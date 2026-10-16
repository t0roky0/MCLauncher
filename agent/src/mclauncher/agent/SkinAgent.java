package mclauncher.agent;

import java.io.BufferedReader;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.DataInputStream;
import java.io.DataOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStreamReader;
import java.lang.instrument.ClassFileTransformer;
import java.lang.instrument.Instrumentation;
import java.lang.reflect.Constructor;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.nio.charset.StandardCharsets;
import java.security.ProtectionDomain;
import java.util.ArrayList;
import java.util.Base64;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.function.Function;

/**
 * MC Launcher's local skin/cape layer; never uploads an official profile.
 *
 * Offline accounts and offline-mode servers carry no skin, so the game draws
 * Steve. The launcher knows better — the skin picked on the "Skins" page and
 * those of the party — and writes them to a small file (one player a line:
 * uuid, name, model, skin url, cape url — either url may be empty). This agent wraps the few authlib methods the game
 * asks for a player's textures and answers from that file whenever authlib
 * is merged with the launcher appearance. Unspecified official textures stay intact.
 *
 * authlib, not the game: its class and method names are the same in every
 * version (1.8 … 26.x), obfuscated or not, vanilla or modded:
 *   up to 1.20.1   getTextures(GameProfile, boolean) -> Map
 *   1.20.2 and up  getPackedTextures(GameProfile) -> Property,
 *                  unpackTextures(Property) -> MinecraftProfileTextures
 *
 * The same agent lets a party play the leader's own world: the world's
 * built-in server always asks Mojang whether a joining player is signed in,
 * which a guest or an Xbox account without Java is not. With "#offline" in
 * the file a joining client skips that sign-in step (joinServer), and with
 * "#lan" the hosting game lets the name in as an offline player when Mojang
 * doesn't know it (hasJoinedServer). Signed-in players go through as usual.
 *
 * Patching without a bytecode library: the original method is renamed and
 * made private, and a new method with the old name calls it and then hands
 * the result to {@link #HOOK}. The new code has no branches, so it needs no
 * stack map frames; the hook is looked up through the system class loader
 * (the agent jar is on it) by reflection, which works from any class loader
 * or module layer a mod loader puts authlib in.
 */
public final class SkinAgent implements ClassFileTransformer {
  private static final String[] SERVICES = {
    "com/mojang/authlib/yggdrasil/YggdrasilMinecraftSessionService",
    "com/mojang/authlib/services/MinecraftServicesSessionService",
    "com/mojang/authlib/minecraft/MinecraftSessionService",
    "com/mojang/authlib/minecraft/SessionService",
  };
  private static final String PROFILE = "Lcom/mojang/authlib/GameProfile;";
  private static final String PROPERTY = "Lcom/mojang/authlib/properties/Property;";
  private static final String INET = "Ljava/net/InetAddress;";
  private static final String STR = "Ljava/lang/String;";
  // {name, descriptor, kind}; kind "unpack" also gets a hook before the call;
  // "around" hands the whole call to the hook, which runs the original itself
  private static final String[][] TARGETS = {
    {"getTextures", "(" + PROFILE + "Z)Ljava/util/Map;", "textures"},
    {"getPackedTextures", "(" + PROFILE + ")" + PROPERTY, "packed"},
    {"unpackTextures", "(" + PROPERTY + ")Lcom/mojang/authlib/minecraft/MinecraftProfileTextures;", "decode"},
    {"joinServer", "(" + PROFILE + STR + STR + ")V", "around"},
    {"joinServer", "(Ljava/util/UUID;" + STR + STR + ")V", "around"},
    {"hasJoinedServer", "(" + PROFILE + STR + ")" + PROFILE, "around"},
    {"hasJoinedServer", "(" + PROFILE + STR + INET + ")" + PROFILE, "around"},
    {"hasJoinedServer", "(" + STR + STR + INET + ")Lcom/mojang/authlib/yggdrasil/ProfileResult;", "around"},
    {"hasJoinedServer", "(" + STR + STR + INET + ")Lcom/mojang/authlib/services/ProfileResult;", "around"},
  };
  // marks a textures property as one of ours (base64 of this + ":" + key)
  private static final String MARK = "mclauncher-skin:";

  /** Called by the patched authlib methods: {kind, service, args…, result}. */
  public static final Function<Object[], Object> HOOK = SkinAgent::hook;

  private static volatile Map<String, Skin> skins = Collections.emptyMap();
  private static final Set<String> told = Collections.newSetFromMap(new ConcurrentHashMap<String, Boolean>());
  private static volatile boolean failedOnce;
  // from the file's "#…" lines (see the class comment)
  private static volatile boolean offlineJoin;
  private static volatile boolean lanAuth;
  private static File dataFile;
  private static final Map<String, Object> originals = new ConcurrentHashMap<String, Object>();
  private static long dataStamp = -1;
  static volatile long revision;

  static final class Skin {
    final String key;
    final String uuid;
    final String name;
    final boolean slim;
    final String url; // "" when only a cape is ours: the game's default skin then
    final String cape;

    Skin(String uuid, String name, boolean slim, String url, String cape) {
      this.uuid = uuid;
      this.name = name;
      this.slim = slim;
      this.url = url;
      this.cape = cape;
      this.key = uuid.isEmpty() ? "n:" + name.toLowerCase(Locale.ROOT) : uuid;
    }
  }

  public static void premain(String args, Instrumentation inst) {
    try {
      dataFile = new File(args == null ? "" : args);
      reload();
      PartyBridge.configure(java.nio.file.Files.readAllLines(dataFile.toPath(), StandardCharsets.UTF_8));
      CosmeticLayer.configure(java.nio.file.Files.readAllLines(dataFile.toPath(), StandardCharsets.UTF_8));
      inst.addTransformer(new SkinAgent());
      Thread watcher = new Thread(SkinAgent::watch, "MCL skins");
      watcher.setDaemon(true);
      watcher.start();
      PartyBridge.start(inst, dataFile);
      Comfort.start();
      log("skins ready (" + skins.size() + ")");
    } catch (Throwable t) {
      log("not started: " + t);
    }
  }

  static void log(String text) {
    System.out.println("[MC Launcher] " + text);
  }

  // ---- the launcher's file ----------------------------------------------------------

  private static void watch() {
    while (true) {
      try {
        Thread.sleep(1000);
        reload();
      } catch (InterruptedException e) {
        return;
      } catch (Throwable ignored) {
        // a half-written file: read again on the next round
      }
    }
  }

  private static void reload() throws IOException {
    long stamp = dataFile.isFile() ? dataFile.lastModified() ^ dataFile.length() : 0;
    if (stamp == dataStamp) return;
    Map<String, Skin> next = new HashMap<String, Skin>();
    boolean offline = false;
    boolean lan = false;
    if (stamp != 0) {
      BufferedReader r = new BufferedReader(new InputStreamReader(new FileInputStream(dataFile), StandardCharsets.UTF_8));
      try {
        String line;
        while ((line = r.readLine()) != null) {
          if (line.startsWith("#")) {
            offline |= line.trim().equals("#offline");
            lan |= line.trim().equals("#lan");
            continue;
          }
          String[] f = line.split("\t", -1);
          String cape = f.length > 4 ? f[4] : "";
          if (f.length < 4 || (f[3].isEmpty() && cape.isEmpty())) continue;
          Skin s = new Skin(f[0].replace("-", "").toLowerCase(Locale.ROOT), f[1], "slim".equals(f[2]), f[3], cape);
          if (!s.uuid.isEmpty()) next.put(s.uuid, s);
          if (!s.name.isEmpty()) next.put("n:" + s.name.toLowerCase(Locale.ROOT), s);
        }
      } finally {
        r.close();
      }
    }
    if (!sameSkins(skins, next)) revision++;
    skins = next;
    CosmeticLayer.configure(stamp == 0 ? Collections.<String>emptyList() : java.nio.file.Files.readAllLines(dataFile.toPath(), StandardCharsets.UTF_8));
    if (offline != offlineJoin || lan != lanAuth) log("party world: " + (offline ? "offline join " : "") + (lan ? "hosting" : ""));
    offlineJoin = offline;
    lanAuth = lan;
    dataStamp = stamp;
  }

  private static boolean sameSkins(Map<String, Skin> a, Map<String, Skin> b) {
    if (!a.keySet().equals(b.keySet())) return false;
    for (String key : a.keySet()) {
      Skin x = a.get(key), y = b.get(key);
      if (!x.url.equals(y.url) || !x.cape.equals(y.cape) || x.slim != y.slim) return false;
    }
    return true;
  }

  // ---- the hook --------------------------------------------------------------------------

  private static Object hook(Object[] a) {
    String kind = (String) a[0];
    if (kind.startsWith("image:")) return imageHook(a);
    if ("decode".equals(kind)) return decode(a);
    if ("around:cape".equals(kind)) {
      try {
        return CosmeticLayer.submit(a);
      } catch (RuntimeException | Error e) {
        throw e;
      } catch (Throwable e) {
        throw new RuntimeException(e);
      }
    }
    if ("around:onScroll".equals(kind)) return Comfort.scroll(a);
    if ("around:calculateFov".equals(kind)) return Comfort.fov(a);
    if (kind.startsWith("static:")) return Comfort.staticHook(kind.substring(7), a);
    if (kind.startsWith("around:")) return around(kind.substring(7), a);
    Object fallback = "unpackArg".equals(kind) ? a[2] : a[a.length - 1];
    try {
      if ("textures".equals(kind)) {
        Map<?, ?> result = (Map<?, ?>) a[3];
        Skin s = forProfile(a[2]);
        if (s == null) return result;
        Map merged = new HashMap();
        if (result != null) merged.putAll(result);
        merged.putAll((Map) texturesMap(a[1], s));
        return merged;
      }
      if ("packed".equals(kind)) {
        Skin s = forProfile(a[2]);
        if (s == null) return a[3];
        if (a[3] != null && ours(a[3]) == null) originals.put(s.key, a[3]);
        else if (a[3] == null) originals.remove(s.key);
        return packed(a[1], s);
      }
      if ("unpackArg".equals(kind)) {
        // ours goes in as an empty payload, so authlib has nothing to complain about
        Skin s = ours(a[2]);
        if (s == null) return a[2];
        Object original = originals.get(s.key);
        return original != null ? original : property(a[1], "textures", b64("{}"), null);
      }
      if ("unpack".equals(kind)) {
        Skin s = ours(a[2]);
        return s == null ? a[3] : unpacked(a[1], s, a[3]);
      }
    } catch (Throwable t) {
      if (!failedOnce) {
        failedOnce = true;
        log("skin hook failed: " + t);
      }
    }
    return fallback;
  }

  private static Object decode(Object[] args) {
    Object service = args[1], property = args[2];
    try {
      Skin local = ours(property);
      Object input = local == null ? property : originals.get(local.key);
      Object fallback = null;
      if (input != null || local == null) {
        Method original = service.getClass().getDeclaredMethod("mcl$unpackTextures", cls(service, "com.mojang.authlib.properties.Property"));
        original.setAccessible(true);
        try { fallback = original.invoke(service, input); }
        catch (InvocationTargetException e) {
          if (local == null) return SkinAgent.<RuntimeException, Object>raise(e.getCause());
          // A server's broken property or an unavailable Mojang service must
          // not prevent rendering an explicitly selected local appearance.
          if (told.add("decode:" + local.key)) log("server texture unavailable; using launcher appearance");
        }
      }
      return local == null ? fallback : unpacked(service, local, fallback);
    } catch (Throwable error) { return SkinAgent.<RuntimeException, Object>raise(error); }
  }

  @SuppressWarnings("unchecked")
  private static <E extends Throwable, T> T raise(Throwable error) throws E { throw (E) error; }

  // joinServer / hasJoinedServer: the original runs here (it was renamed to
  // mcl$<name> and made private); what it throws goes on unchanged, unless
  // a party world needs an offline player let through.
  static Object around(String name, Object[] a) {
    Object service = a[1];
    Object[] args = new Object[a.length - 2];
    System.arraycopy(a, 2, args, 0, args.length);
    Method original = null;
    for (Method m : service.getClass().getDeclaredMethods()) {
      if (m.getName().equals("mcl$" + name) && m.getParameterTypes().length == args.length) original = m;
    }
    if (original == null) throw new IllegalStateException("mcl$" + name + " missing");
    try {
      original.setAccessible(true);
      Object result = original.invoke(service, args);
      if (result == null && "hasJoinedServer".equals(name) && lanAuth) return offlineProfile(service, original.getReturnType(), args[0]);
      return result;
    } catch (InvocationTargetException e) {
      Throwable cause = e.getCause() != null ? e.getCause() : e;
      if ("joinServer".equals(name) && offlineJoin) {
        if (told.add("join")) log("offline player: joining without a session");
        return null;
      }
      if ("hasJoinedServer".equals(name) && lanAuth) {
        try {
          return offlineProfile(service, original.getReturnType(), args[0]);
        } catch (Exception ignored) {
          // fall through: the original's error
        }
      }
      throw SkinAgent.<RuntimeException>sneaky(cause);
    } catch (IllegalAccessException e) {
      throw new IllegalStateException(e);
    }
  }

  @SuppressWarnings("unchecked")
  static <T extends Throwable> T sneaky(Throwable t) throws T {
    throw (T) t;
  }

  // The name as an offline player: the UUID the game itself gives one.
  private static Object offlineProfile(Object service, Class<?> type, Object user) {
    try {
      String name = user instanceof String ? (String) user : String.valueOf(call(user, "getName", "name"));
      UUID id = UUID.nameUUIDFromBytes(("OfflinePlayer:" + name).getBytes(StandardCharsets.UTF_8));
      Class<?> gp = cls(service, "com.mojang.authlib.GameProfile");
      Object profile = gp.getConstructor(UUID.class, String.class).newInstance(id, name);
      if (told.add("lan:" + name)) log("party world: " + name + " joins as an offline player");
      if (type.isAssignableFrom(gp)) return profile;
      for (Constructor<?> c : type.getConstructors()) {
        Class<?>[] p = c.getParameterTypes();
        if (p.length == 0 || !p[0].isAssignableFrom(gp)) continue;
        Object[] v = new Object[p.length];
        v[0] = profile;
        for (int i = 1; i < p.length; i++) v[i] = Set.class.isAssignableFrom(p[i]) ? Collections.emptySet() : null;
        return c.newInstance(v);
      }
      return null;
    } catch (Exception e) {
      log("offline profile failed: " + e);
      return null;
    }
  }

  private static Skin forProfile(Object profile) throws Exception {
    if (profile == null || skins.isEmpty()) return null;
    Object id = call(profile, "getId", "id");
    Object name = call(profile, "getName", "name");
    Skin s = id != null ? skins.get(id.toString().replace("-", "").toLowerCase(Locale.ROOT)) : null;
    if (s == null && name != null) s = skins.get("n:" + name.toString().toLowerCase(Locale.ROOT));
    if (s != null && told.add(s.key + s.url + s.cape)) log((s.url.isEmpty() ? "cape" : s.cape.isEmpty() ? "skin" : "skin and cape") + " for " + (name != null ? name : id));
    return s;
  }

  private static Skin ours(Object property) throws Exception {
    if (property == null) return null;
    Object sig = call(property, "getSignature", "signature");
    if (!(sig instanceof String)) return null;
    String text;
    try {
      text = new String(Base64.getDecoder().decode((String) sig), StandardCharsets.UTF_8);
    } catch (IllegalArgumentException e) {
      return null;
    }
    return text.startsWith(MARK) ? skins.get(text.substring(MARK.length())) : null;
  }

  private static final Map<String, Method> methods = new ConcurrentHashMap<String, Method>();

  // record accessor (authlib 7+) or getter (older)
  private static Object call(Object target, String getter, String accessor) throws Exception {
    Class<?> c = target.getClass();
    String k = c.getName() + "#" + getter;
    Method m = methods.get(k);
    if (m == null) {
      try {
        m = c.getMethod(getter);
      } catch (NoSuchMethodException e) {
        m = c.getMethod(accessor);
      }
      methods.put(k, m);
    }
    return m.invoke(target);
  }

  private static String b64(String s) {
    return Base64.getEncoder().encodeToString(s.getBytes(StandardCharsets.UTF_8));
  }

  private static Class<?> cls(Object service, String name) throws ClassNotFoundException {
    return Class.forName(name, false, service.getClass().getClassLoader());
  }

  private static Object property(Object service, String name, String value, String signature) throws Exception {
    Constructor<?> c = cls(service, "com.mojang.authlib.properties.Property").getConstructor(String.class, String.class, String.class);
    return c.newInstance(name, value, signature);
  }

  private static Object packed(Object service, Skin s) throws Exception {
    String json = "{\"timestamp\":" + System.currentTimeMillis() + ",\"profileId\":\"" + s.uuid + "\",\"profileName\":\"" + s.name.replace("\"", "")
      + "\",\"textures\":{" + texturesJson(s) + "}}";
    return property(service, "textures", b64(json), b64(MARK + s.key));
  }

  private static String texturesJson(Skin s) {
    StringBuilder b = new StringBuilder();
    if (!s.url.isEmpty()) b.append("\"SKIN\":{\"url\":\"").append(s.url).append("\"").append(s.slim ? ",\"metadata\":{\"model\":\"slim\"}" : "").append("}");
    if (!s.cape.isEmpty()) b.append(b.length() > 0 ? "," : "").append("\"CAPE\":{\"url\":\"").append(s.cape).append("\"}");
    return b.toString();
  }

  private static Object texture(Object service, Skin s) throws Exception {
    if (s.url.isEmpty()) return null;
    Map<String, String> meta = new HashMap<String, String>();
    if (s.slim) meta.put("model", "slim");
    Constructor<?> c = cls(service, "com.mojang.authlib.minecraft.MinecraftProfileTexture").getConstructor(String.class, Map.class);
    return c.newInstance(s.url, meta);
  }

  private static Object capeTexture(Object service, Skin s) throws Exception {
    if (s.cape.isEmpty()) return null;
    Constructor<?> c = cls(service, "com.mojang.authlib.minecraft.MinecraftProfileTexture").getConstructor(String.class, Map.class);
    return c.newInstance(s.cape, new HashMap<String, String>());
  }

  @SuppressWarnings({"unchecked", "rawtypes"})
  private static Object texturesMap(Object service, Skin s) throws Exception {
    Class type = cls(service, "com.mojang.authlib.minecraft.MinecraftProfileTexture$Type");
    Map<Object, Object> map = new HashMap<Object, Object>();
    Object skin = texture(service, s);
    Object cape = capeTexture(service, s);
    if (skin != null) map.put(Enum.valueOf(type, "SKIN"), skin);
    if (cape != null) map.put(Enum.valueOf(type, "CAPE"), cape);
    return map;
  }

  @SuppressWarnings({"unchecked", "rawtypes"})
  private static Object unpacked(Object service, Skin s, Object fallback) throws Exception {
    Class<?> tex = cls(service, "com.mojang.authlib.minecraft.MinecraftProfileTexture");
    Class state = cls(service, "com.mojang.authlib.SignatureState");
    Constructor<?> c = cls(service, "com.mojang.authlib.minecraft.MinecraftProfileTextures").getConstructor(tex, tex, tex, state);
    // "signed": the game shows other players' skins only when they are
    Object skin = texture(service, s), cape = capeTexture(service, s), elytra = null;
    if (fallback != null) {
      if (skin == null) skin = call(fallback, "getSkin", "skin");
      if (cape == null) cape = call(fallback, "getCape", "cape");
      elytra = call(fallback, "getElytra", "elytra");
    }
    return c.newInstance(skin, cape, elytra, Enum.valueOf(state, "SIGNED"));
  }

  // Only launcher-owned textures bypass vanilla size/alpha processing.
  private static Object imageHook(Object[] args) {
    Class<?> owner = (Class<?>) args[1];
    Object image = args[2];
    String url = String.valueOf(args[3]);
    for (Skin s : skins.values()) if (s.url.equals(url)) return image;
    try {
      Method m = owner.getDeclaredMethod("mcl$" + ((String) args[0]).substring(6), image.getClass(), String.class);
      m.setAccessible(true);
      return m.invoke(null, image, args[3]);
    } catch (InvocationTargetException e) { throw new RuntimeException(e.getCause()); }
    catch (Exception e) { throw new RuntimeException(e); }
  }

  // ---- patching ----------------------------------------------------------------------------

  @Override
  public byte[] transform(ClassLoader loader, String className, Class<?> redefined, ProtectionDomain pd, byte[] bytes) {
    if (className == null || redefined != null) return null;
    // cosmetics: drawn with (or instead of) each player's cape
    String cape = PartyBridge.setting("class.capeLayer", "net.minecraft.client.renderer.entity.layers.CapeLayer").replace('.', '/');
    if (className.equals(cape)) {
      String method = PartyBridge.setting("capeLayer.render", PartyBridge.setting("capeLayer.submit", "submit"));
      String desc = PartyBridge.setting("capeLayer.renderDesc", PartyBridge.setting("capeLayer.submitDesc",
        "(Lcom/mojang/blaze3d/vertex/PoseStack;Lnet/minecraft/client/renderer/SubmitNodeCollector;ILnet/minecraft/client/renderer/entity/state/AvatarRenderState;FF)V"));
      try {
        byte[] patched = Patcher.patch(bytes, new String[][] {{method, desc, "cape"}});
        log(patched != null ? "cosmetics hooked" : "cosmetics: no cape layer to hook here");
        return patched;
      } catch (Throwable e) { log("cosmetics hook unavailable: " + e); return null; }
    }
    // the overlay's game settings (Comfort): the wheel while zooming, the fire over the screen
    String mouse = PartyBridge.setting("class.mouseHandler", "net.minecraft.client.MouseHandler").replace('.', '/');
    if (className.equals(mouse)) {
      try {
        byte[] patched = Patcher.patch(bytes, new String[][] {{PartyBridge.setting("mouseHandler.onScroll", "onScroll"), PartyBridge.setting("mouseHandler.onScrollDesc", "(JDD)V"), "around"}});
        if (patched != null) log("zoom wheel hooked");
        return patched;
      } catch (Throwable e) { log("zoom wheel hook unavailable: " + e); return null; }
    }
    // the zoom, every frame: the camera's field of view divided as it's worked out (26.x: Camera.calculateFov)
    String camera = PartyBridge.setting("class.camera", "net.minecraft.client.Camera").replace('.', '/');
    if (className.equals(camera)) {
      try {
        byte[] patched = Patcher.patch(bytes, new String[][] {{PartyBridge.setting("camera.calculateFov", "calculateFov"), PartyBridge.setting("camera.calculateFovDesc", "(F)F"), "around"}});
        if (patched != null) log("zoom field of view hooked");
        return patched;
      } catch (Throwable e) { log("zoom field of view hook unavailable: " + e); return null; }
    }
    String effects = PartyBridge.setting("class.screenEffects", "net.minecraft.client.renderer.ScreenEffectRenderer").replace('.', '/');
    if (className.equals(effects)) {
      try {
        byte[] patched = Patcher.patch(bytes, new String[][] {{PartyBridge.setting("screenEffects.submitFire", "submitFire"),
          PartyBridge.setting("screenEffects.submitFireDesc", "(Lcom/mojang/blaze3d/vertex/PoseStack;Lnet/minecraft/client/renderer/SubmitNodeCollector;Lnet/minecraft/client/renderer/texture/TextureAtlasSprite;)V"), "static"}});
        if (patched != null) log("screen fire hooked");
        return patched;
      } catch (Throwable e) { log("screen fire hook unavailable: " + e); return null; }
    }
    String downloader = PartyBridge.setting("class.skinDownloader", "net.minecraft.client.renderer.texture.SkinTextureDownloader").replace('.', '/');
    if (className.equals(downloader)) {
      String image = "L" + PartyBridge.setting("class.image", "com.mojang.blaze3d.platform.NativeImage").replace('.', '/') + ";";
      String method = PartyBridge.setting("skinDownloader.processLegacySkin", "processLegacySkin");
      try {
        byte[] patched = Patcher.patch(bytes, new String[][] {{method, "(" + image + "Ljava/lang/String;)" + image, "image"}});
        if (patched != null) log("HD skin and alpha processing hooked");
        return patched;
      } catch (Throwable e) { log("HD skin hook unavailable: " + e); return null; }
    }
    for (String s : SERVICES) {
      if (s.equals(className)) {
        try {
          byte[] out = Patcher.patch(bytes, TARGETS);
          if (out != null) log("skins hooked into " + className.substring(className.lastIndexOf('/') + 1));
          return out;
        } catch (Throwable t) {
          log("could not hook " + className + ": " + t);
          return null;
        }
      }
    }
    return null;
  }

  static final class Patcher {
    private final List<byte[]> pool = new ArrayList<byte[]>();
    private final Map<String, Integer> index = new HashMap<String, Integer>();
    private final List<String> utf = new ArrayList<String>();
    private int thisClass;
    private boolean isInterface;
    // the wrapped method's parameter types, for the hook to get every one (primitives boxed)
    private List<Character> typed;

    static byte[] patch(byte[] in, String[][] targets) throws IOException {
      return new Patcher().run(in, targets);
    }

    private byte[] run(byte[] in, String[][] targets) throws IOException {
      DataInputStream d = new DataInputStream(new ByteArrayInputStream(in));
      int magic = d.readInt();
      int minor = d.readUnsignedShort();
      int major = d.readUnsignedShort();
      int count = d.readUnsignedShort();
      pool.add(null);
      utf.add(null);
      for (int i = 1; i < count; i++) {
        int tag = d.readUnsignedByte();
        ByteArrayOutputStream raw = new ByteArrayOutputStream();
        DataOutputStream o = new DataOutputStream(raw);
        o.writeByte(tag);
        String text = null;
        int size;
        switch (tag) {
          case 1: text = d.readUTF(); o.writeUTF(text); size = 0; break;
          case 3: case 4: size = 4; break;
          case 5: case 6: size = 8; break;
          case 7: case 8: case 16: case 19: case 20: size = 2; break;
          case 9: case 10: case 11: case 12: case 17: case 18: size = 4; break;
          case 15: size = 3; break;
          default: throw new IOException("constant tag " + tag);
        }
        byte[] b = new byte[size];
        d.readFully(b);
        o.write(b);
        pool.add(raw.toByteArray());
        utf.add(text);
        if (text != null) index.put("U" + text, i);
        if (tag == 5 || tag == 6) {
          pool.add(null);
          utf.add(null);
          i++;
        }
      }
      int access = d.readUnsignedShort();
      isInterface = (access & 0x0200) != 0;
      thisClass = d.readUnsignedShort();
      int superClass = d.readUnsignedShort();
      byte[] interfaces = new byte[d.readUnsignedShort() * 2];
      d.readFully(interfaces);
      int fieldCount = d.readUnsignedShort();
      ByteArrayOutputStream fields = new ByteArrayOutputStream();
      DataOutputStream fo = new DataOutputStream(fields);
      for (int i = 0; i < fieldCount; i++) copyMember(d, fo);

      int methodCount = d.readUnsignedShort();
      List<int[]> heads = new ArrayList<int[]>(); // access, name, desc
      List<byte[]> bodies = new ArrayList<byte[]>();
      for (int i = 0; i < methodCount; i++) {
        int[] head = {d.readUnsignedShort(), d.readUnsignedShort(), d.readUnsignedShort()};
        ByteArrayOutputStream body = new ByteArrayOutputStream();
        copyAttributes(d, new DataOutputStream(body));
        heads.add(head);
        bodies.add(body.toByteArray());
      }
      ByteArrayOutputStream rest = new ByteArrayOutputStream();
      byte[] buf = new byte[4096];
      int n;
      while ((n = d.read(buf)) > 0) rest.write(buf, 0, n);

      for (int[] head : heads) if (utf.get(head[1]).startsWith("mcl$")) return null; // done already
      List<int[]> newHeads = new ArrayList<int[]>();
      List<byte[]> newBodies = new ArrayList<byte[]>();
      for (String[] t : targets) {
        for (int[] head : heads) {
          if (!t[0].equals(utf.get(head[1])) || !t[1].equals(utf.get(head[2]))) continue;
          if ((head[0] & 0x0400) != 0 || ((head[0] & 8) != 0 && !"image".equals(t[2]) && !"static".equals(t[2]))) continue;
          int origName = utf("mcl$" + t[0]);
          newHeads.add(new int[] {head[0], head[1], head[2]});
          newBodies.add(wrapper(t[0], t[1], t[2], origName));
          head[1] = origName;
          // Java 8 interfaces require a public default method here.
          head[0] = isInterface ? (head[0] & ~0x0006) | 0x0001 | 0x1000 : (head[0] & ~0x0005) | 0x0002 | 0x1000;
        }
      }
      if (newHeads.isEmpty()) return null;

      ByteArrayOutputStream out = new ByteArrayOutputStream(in.length + 2048);
      DataOutputStream o = new DataOutputStream(out);
      o.writeInt(magic);
      o.writeShort(minor);
      o.writeShort(major);
      o.writeShort(pool.size());
      for (byte[] e : pool) if (e != null) o.write(e);
      o.writeShort(access);
      o.writeShort(thisClass);
      o.writeShort(superClass);
      o.writeShort(interfaces.length / 2);
      o.write(interfaces);
      o.writeShort(fieldCount);
      o.write(fields.toByteArray());
      o.writeShort(heads.size() + newHeads.size());
      for (int i = 0; i < heads.size(); i++) {
        int[] h = heads.get(i);
        o.writeShort(h[0]);
        o.writeShort(h[1]);
        o.writeShort(h[2]);
        o.write(bodies.get(i));
      }
      for (int i = 0; i < newHeads.size(); i++) {
        int[] h = newHeads.get(i);
        o.writeShort(h[0]);
        o.writeShort(h[1]);
        o.writeShort(h[2]);
        o.write(newBodies.get(i));
      }
      o.write(rest.toByteArray());
      return out.toByteArray();
    }

    private static void copyMember(DataInputStream d, DataOutputStream o) throws IOException {
      o.writeShort(d.readUnsignedShort());
      o.writeShort(d.readUnsignedShort());
      o.writeShort(d.readUnsignedShort());
      copyAttributes(d, o);
    }

    private static void copyAttributes(DataInputStream d, DataOutputStream o) throws IOException {
      int count = d.readUnsignedShort();
      o.writeShort(count);
      for (int i = 0; i < count; i++) {
        o.writeShort(d.readUnsignedShort());
        int len = d.readInt();
        o.writeInt(len);
        byte[] b = new byte[len];
        d.readFully(b);
        o.write(b);
      }
    }

    // ---- constant pool ----

    private int add(String key, byte[] entry) {
      Integer i = index.get(key);
      if (i != null) return i;
      pool.add(entry);
      utf.add(null);
      index.put(key, pool.size() - 1);
      return pool.size() - 1;
    }

    private int utf(String s) throws IOException {
      Integer i = index.get("U" + s);
      if (i != null) return i;
      ByteArrayOutputStream raw = new ByteArrayOutputStream();
      DataOutputStream o = new DataOutputStream(raw);
      o.writeByte(1);
      o.writeUTF(s);
      pool.add(raw.toByteArray());
      utf.add(s);
      index.put("U" + s, pool.size() - 1);
      return pool.size() - 1;
    }

    private static byte[] entry(int tag, int... u2) {
      byte[] b = new byte[1 + u2.length * 2];
      b[0] = (byte) tag;
      for (int i = 0; i < u2.length; i++) {
        b[1 + i * 2] = (byte) (u2[i] >> 8);
        b[2 + i * 2] = (byte) u2[i];
      }
      return b;
    }

    private int classRef(String name) throws IOException {
      int u = utf(name);
      return add("C" + name, entry(7, u));
    }

    private int string(String s) throws IOException {
      int u = utf(s);
      return add("S" + s, entry(8, u));
    }

    private int nameType(String name, String desc) throws IOException {
      int n = utf(name);
      int t = utf(desc);
      return add("N" + name + desc, entry(12, n, t));
    }

    private int method(int tag, int owner, String name, String desc) throws IOException {
      int nt = nameType(name, desc);
      return add("M" + tag + ":" + owner + "." + name + desc, entry(tag, owner, nt));
    }

    private int method(String owner, String name, String desc, boolean iface) throws IOException {
      return method(iface ? 11 : 10, classRef(owner), name, desc);
    }

    // ---- the new method -----

    private byte[] wrapper(String name, String desc, String kind, int origName) throws IOException {
      ByteArrayOutputStream code = new ByteArrayOutputStream();
      DataOutputStream c = new DataOutputStream(code);
      List<Character> params = new ArrayList<Character>();
      int slots = 1;
      int i = 1;
      while (desc.charAt(i) != ')') {
        char ch = desc.charAt(i);
        params.add(ch == '[' ? 'L' : ch);
        while (desc.charAt(i) == '[') i++;
        if (desc.charAt(i) == 'L') i = desc.indexOf(';', i);
        i++;
        slots += ch == 'J' || ch == 'D' ? 2 : 1;
      }
      String ret = desc.substring(desc.indexOf(')') + 1);
      String retClass = ret.startsWith("L") ? ret.substring(1, ret.length() - 1) : ret;
      int resultSlot = slots;

      if ("decode".equals(kind)) {
        hookCall(c, kind, params.size(), -1);
        c.writeByte(0xc0); c.writeShort(classRef(retClass)); c.writeByte(0xb0);
        return code(bytecode(code), slots);
      }

      if ("static".equals(kind)) {
        // a static void method: the hook gets its class and every argument, and calls the original (or not)
        hookCall(c, "static:" + name, params.size(), -1);
        c.writeByte(0x57); // pop
        c.writeByte(0xb1); // return
        return code(bytecode(code), slots);
      }
      if ("image".equals(kind)) {
        hookCall(c, "image:" + name, params.size(), -1);
        c.writeByte(0xc0); c.writeShort(classRef(retClass)); c.writeByte(0xb0);
        return code(bytecode(code), slots);
      }
      if ("around".equals(kind) || "cape".equals(kind)) {
        typed = params;
        hookCall(c, "cape".equals(kind) ? "around:cape" : "around:" + name, params.size(), -1);
        typed = null;
        if (retClass.equals("V")) {
          c.writeByte(0x57); // pop
          c.writeByte(0xb1); // return
        } else if ("FDJI".indexOf(retClass.charAt(0)) >= 0 && retClass.length() == 1) {
          // a number (the field of view: a float): the hook's boxed result, unboxed
          char r = retClass.charAt(0);
          c.writeByte(0xc0); // checkcast Number
          c.writeShort(classRef("java/lang/Number"));
          c.writeByte(0xb6); // invokevirtual Number.xxxValue
          c.writeShort(method("java/lang/Number", r == 'F' ? "floatValue" : r == 'D' ? "doubleValue" : r == 'J' ? "longValue" : "intValue", "()" + r, false));
          c.writeByte(r == 'F' ? 0xae : r == 'D' ? 0xaf : r == 'J' ? 0xad : 0xac); // freturn / dreturn / lreturn / ireturn
        } else {
          c.writeByte(0xc0);
          c.writeShort(classRef(retClass));
          c.writeByte(0xb0);
        }
        return code(bytecode(code), slots);
      }
      c.writeByte(0x2a); // aload_0
      if ("unpack".equals(kind)) {
        // the argument goes through the hook first
        hookCall(c, "unpackArg", 1, -1);
        c.writeByte(0xc0);
        c.writeShort(classRef(PROPERTY.substring(1, PROPERTY.length() - 1)));
      } else {
        loadParams(c, params);
      }
      c.writeByte(isInterface ? 0xb9 : 0xb7);
      c.writeShort(method(isInterface ? 11 : 10, thisClass, utf.get(origName), desc));
      if (isInterface) { c.writeByte(slots); c.writeByte(0); }
      store(c, resultSlot);
      hookCall(c, kind, params.size(), resultSlot);
      c.writeByte(0xc0); // checkcast
      c.writeShort(classRef(retClass));
      c.writeByte(0xb0); // areturn
      return code(bytecode(code), slots);
    }

    private static byte[] bytecode(ByteArrayOutputStream code) {
      return code.toByteArray();
    }

    private byte[] code(byte[] bytecode, int slots) throws IOException {
      ByteArrayOutputStream attr = new ByteArrayOutputStream();
      DataOutputStream a = new DataOutputStream(attr);
      a.writeShort(1); // one attribute: Code
      a.writeShort(utf("Code"));
      a.writeInt(2 + 2 + 4 + bytecode.length + 2 + 2);
      a.writeShort(12); // max_stack, generously
      a.writeShort(slots + 1); // max_locals
      a.writeInt(bytecode.length);
      a.write(bytecode);
      a.writeShort(0); // exception table
      a.writeShort(0); // attributes
      return attr.toByteArray();
    }

    private void loadParams(DataOutputStream c, List<Character> params) throws IOException {
      int slot = 1;
      for (char p : params) {
        int op;
        switch (p) {
          case 'J': op = 0x16; break;
          case 'F': op = 0x17; break;
          case 'D': op = 0x18; break;
          case 'L': op = 0x19; break;
          default: op = 0x15; // int, boolean, byte, char, short
        }
        c.writeByte(op);
        c.writeByte(slot);
        slot += p == 'J' || p == 'D' ? 2 : 1;
      }
    }

    private static void store(DataOutputStream c, int slot) throws IOException {
      c.writeByte(0x3a); // astore
      c.writeByte(slot);
    }

    // HOOK.apply(new Object[] {kind, this, <object params…>, result?}); only
    // object params go in (the boolean of getTextures isn't needed)
    private void hookCall(DataOutputStream c, String kind, int paramCount, int resultSlot) throws IOException {
      c.writeByte(0xb8); // ClassLoader.getSystemClassLoader()
      c.writeShort(method("java/lang/ClassLoader", "getSystemClassLoader", "()Ljava/lang/ClassLoader;", false));
      ldc(c, string("mclauncher.agent.SkinAgent"));
      c.writeByte(0xb6);
      c.writeShort(method("java/lang/ClassLoader", "loadClass", "(Ljava/lang/String;)Ljava/lang/Class;", false));
      ldc(c, string("HOOK"));
      c.writeByte(0xb6);
      c.writeShort(method("java/lang/Class", "getField", "(Ljava/lang/String;)Ljava/lang/reflect/Field;", false));
      c.writeByte(0x01); // aconst_null
      c.writeByte(0xb6);
      c.writeShort(method("java/lang/reflect/Field", "get", "(Ljava/lang/Object;)Ljava/lang/Object;", false));
      c.writeByte(0xc0);
      c.writeShort(classRef("java/util/function/Function"));

      // only the first parameter (the profile/property) matters to the hook,
      // except around calls, which get them all (objects, every one of them)
      boolean image = kind.startsWith("image:") || kind.startsWith("static:");
      boolean all = image || kind.startsWith("around:");
      int passed = all ? paramCount : Math.min(1, paramCount);
      int length = 2 + passed + (resultSlot >= 0 ? 1 : 0);
      c.writeByte(0x10); // bipush
      c.writeByte(length);
      c.writeByte(0xbd); // anewarray Object
      c.writeShort(classRef("java/lang/Object"));
      int at = 0;
      element(c, at++);
      ldc(c, string(kind));
      c.writeByte(0x53);
      element(c, at++);
      if (image) ldc(c, thisClass); else c.writeByte(0x2a); // Class for static hook, otherwise this
      c.writeByte(0x53);
      if (typed != null) {
        int slot = 1;
        for (char p : typed) {
          element(c, at++);
          box(c, p, slot);
          c.writeByte(0x53);
          slot += p == 'J' || p == 'D' ? 2 : 1;
        }
      } else for (int i = 1; i <= passed; i++) {
        element(c, at++);
        c.writeByte(0x19); // aload i
        c.writeByte(image ? i - 1 : i);
        c.writeByte(0x53);
      }
      if (resultSlot >= 0) {
        element(c, at++);
        c.writeByte(0x19);
        c.writeByte(resultSlot);
        c.writeByte(0x53);
      }
      c.writeByte(0xb9); // invokeinterface Function.apply
      c.writeShort(method("java/util/function/Function", "apply", "(Ljava/lang/Object;)Ljava/lang/Object;", true));
      c.writeByte(2);
      c.writeByte(0);
    }

    // a parameter onto the stack as an object: loaded by its type, boxed
    private void box(DataOutputStream c, char p, int slot) throws IOException {
      String[] boxed;
      int op;
      switch (p) {
        case 'I': op = 0x15; boxed = new String[] {"java/lang/Integer", "(I)Ljava/lang/Integer;"}; break;
        case 'Z': op = 0x15; boxed = new String[] {"java/lang/Boolean", "(Z)Ljava/lang/Boolean;"}; break;
        case 'B': op = 0x15; boxed = new String[] {"java/lang/Byte", "(B)Ljava/lang/Byte;"}; break;
        case 'C': op = 0x15; boxed = new String[] {"java/lang/Character", "(C)Ljava/lang/Character;"}; break;
        case 'S': op = 0x15; boxed = new String[] {"java/lang/Short", "(S)Ljava/lang/Short;"}; break;
        case 'J': op = 0x16; boxed = new String[] {"java/lang/Long", "(J)Ljava/lang/Long;"}; break;
        case 'F': op = 0x17; boxed = new String[] {"java/lang/Float", "(F)Ljava/lang/Float;"}; break;
        case 'D': op = 0x18; boxed = new String[] {"java/lang/Double", "(D)Ljava/lang/Double;"}; break;
        default: op = 0x19; boxed = null;
      }
      c.writeByte(op);
      c.writeByte(slot);
      if (boxed != null) {
        c.writeByte(0xb8); // invokestatic valueOf
        c.writeShort(method(boxed[0], "valueOf", boxed[1], false));
      }
    }

    private static void element(DataOutputStream c, int i) throws IOException {
      c.writeByte(0x59); // dup
      c.writeByte(0x10); // bipush i
      c.writeByte(i);
    }

    private static void ldc(DataOutputStream c, int index) throws IOException {
      c.writeByte(0x13); // ldc_w
      c.writeShort(index);
    }
  }

  private SkinAgent() {}

}
