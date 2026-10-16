package mclauncher.agent;

import java.io.File;
import java.io.FileInputStream;
import java.io.InputStream;
import java.lang.reflect.Field;
import java.lang.reflect.Constructor;
import java.nio.FloatBuffer;
import java.lang.reflect.InvocationHandler;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.lang.reflect.Proxy;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.function.Supplier;

/**
 * The launcher's cosmetics on players in Java, seen by this game only.
 *
 * The launcher lists who wears what ("#cos\tname\tid,id") and bakes each
 * item into a small mesh in the game's model space ("#cosdir\t<folder>",
 * cosmetic-mesh.js). The cape layer's submit is wrapped (see SkinAgent): it
 * runs for every player the game draws, with the player model already posed,
 * so after the cape — or instead of it, when something is worn on the back —
 * each worn item goes through the game's own "custom geometry" path, posed
 * on the head or the body part, lit like the player, with its own texture.
 * An outline's faces ("g" in the mesh) go through it again on their own: a
 * render type that drops back faces (the outline is a shell seen from
 * inside — 26.x's plain entityCutout draws both sides), at full light.
 *
 * Everything here is reflection on the game's names (26.x: Mojang's own);
 * any failure switches the layer off for the session and the cape renders
 * as before — never a broken frame.
 */
public final class CosmeticLayer {
  private static volatile Map<String, String[]> wearers = Collections.emptyMap(); // lower-case name → ids
  private static volatile String dir = "";
  private static final Map<String, Mesh> meshes = new HashMap<String, Mesh>();
  private static final Map<Integer, String> names = new HashMap<Integer, String>();
  private static Object namesLevel;
  private static long namesAt;
  private static volatile boolean broken;

  // the game's classes and calls, found once
  private static Method original, getParentModel, translateAndRotate, pushPose, popPose, submitCustom, entityCutout, entityCutoutCull, fromPath;
  private static Method poseMatrix, normalMatrix, matrix4Get, matrix3Get, addVertex, getEntity, scoreboardName, isEmpty;
  private static Field stateId, headEquipment, chestEquipment, modelHead, modelBody, clientLevel;
  private static Class<?> geometryType;
  private static Object client, textureManager;
  private static ClassLoader gameLoader;
  private static boolean oldVertex;
  private static int noOverlay = 655360;
  private static final int FULL_BRIGHT = 0xF000F0; // LightTexture.FULL_BRIGHT

  static final class Part {
    float px, py, pz, rx, ry, rz, ax, ay, az, period, phase;
    float wx, wy, wz; // its lean in the wind (a pet flying after the player), at full speed
    // now and then: a quick motion (an ear's flick: its turn, period, every, how long, from when)
    float bx, by, bz, burstPeriod, burstEvery, burstDur, burstOffset;
    // …and a blink: squashed top to bottom (how much, every, how long, from when)
    float squash, blinkEvery, blinkDur, blinkOffset;
  }

  static final class Mesh {
    String id, slot, bone;
    // a pet's float (bob in blocks, its period; sway in degrees, its period; about cx, cz), else bobPeriod 0
    float bob, bobPeriod, sway, swayPeriod, cx, cy, cz;
    Object renderType, outlineType;
    final List<Part> parts = new ArrayList<Part>();
    // per face: part, normal xyz, then 4 × (x y z u v)
    float[] faces = new float[0];
    boolean[] outline = new boolean[0];
    int faceCount;
    boolean hasOutline;
  }

  static void configure(List<String> lines) {
    Map<String, String[]> next = new HashMap<String, String[]>();
    String d = "";
    for (String line : lines) {
      if (line.startsWith("#cosdir\t")) d = line.substring(8).trim();
      else if (line.startsWith("#cos\t")) {
        String[] p = line.split("\t", 3);
        if (p.length == 3 && !p[1].isEmpty() && !p[2].isEmpty()) next.put(p[1].toLowerCase(Locale.ROOT), p[2].split(","));
      }
    }
    wearers = next;
    dir = d;
  }

  static boolean wanted() {
    return !broken && !wearers.isEmpty() && !dir.isEmpty();
  }

  // Both render (1.8–1.21) and submit (1.21.9+) arrive with boxed arguments.
  static Object submit(Object[] args) throws Throwable {
    Object layer = args[1];
    gameLoader = layer.getClass().getClassLoader();
    boolean legacy = "legacy".equals(PartyBridge.setting("cosmetic.api", "submit"));
    Object player = legacy ? args[2] : args[5];
    List<Mesh> list = new ArrayList<Mesh>();
    boolean back = false;
    if (wanted()) {
      try {
        String[] worn = wornBy(player);
        if (worn != null) for (String id : worn) {
          Mesh m = mesh(layer, id);
          if (m != null) { list.add(m); if ("back".equals(m.slot)) back = true; }
        }
      } catch (Throwable e) { disable("who", e); }
    }
    if (!back) call(layer, args);
    if (!list.isEmpty()) {
      try {
        if (legacy) LegacyCosmetics.draw(layer, player, list, ((Number) args[9]).floatValue());
        else draw(layer, args, list);
      } catch (Throwable e) {
        disable("draw", e);
        // A failed cosmetic must not suppress the player's original cape.
        if (back) call(layer, args);
      }
    }
    return null;
  }

  private static void disable(String at, Throwable e) {
    broken = true;
    SkinAgent.log("cosmetics off (" + at + "): " + (e instanceof InvocationTargetException ? e.getCause() : e));
  }

  private static void call(Object layer, Object[] args) throws Throwable {
    if (original == null) {
      for (Method m : layer.getClass().getDeclaredMethods()) {
        if (m.getName().startsWith("mcl$") && m.getParameterTypes().length == args.length - 2) {
          original = m; m.setAccessible(true); break;
        }
      }
      if (original == null) throw new NoSuchMethodException("original cape method");
    }
    Object[] values = new Object[args.length - 2];
    System.arraycopy(args, 2, values, 0, values.length);
    try { original.invoke(layer, values); }
    catch (InvocationTargetException e) { throw e.getCause(); }
  }

  static Class<?> type(String key, String fallback) throws Exception {
    return Class.forName(PartyBridge.setting("class." + key, fallback), false, gameLoader);
  }
  static Method method(Class<?> c, String key, String fallback, Class<?>... params) throws Exception {
    Method m = c.getMethod(PartyBridge.setting(key, fallback), params); m.setAccessible(true); return m;
  }
  static Field field(Class<?> c, String key, String fallback) throws Exception {
    Field f = c.getField(PartyBridge.setting(key, fallback)); f.setAccessible(true); return f;
  }
  static Object client() throws Exception {
    if (client == null) {
      Class<?> mc = type("client", "net.minecraft.client.Minecraft");
      client = method(mc, "client.getInstance", "getInstance").invoke(null);
    }
    return client;
  }
  static File textureFile(String id) { return new File(dir, id + ".png"); }

  private static String[] wornBy(Object player) throws Exception {
    String name = null;
    try {
      Object profile = method(player.getClass(), "player.getGameProfile", "getGameProfile").invoke(player);
      if ((Boolean) method(player.getClass(), "entity.isInvisible", "isInvisible").invoke(player)) return null;
      name = (String) profile.getClass().getMethod("getName").invoke(profile);
    } catch (NoSuchMethodException state) {
      try { if (field(player.getClass(), "entityState.isInvisible", "isInvisible").getBoolean(player)) return null; }
      catch (NoSuchFieldException ignored) { }
      try { name = (String) field(player.getClass(), "playerState.name", "name").get(player); }
      catch (NoSuchFieldException missingName) {
        int id = field(player.getClass(), "playerState.id", "id").getInt(player);
        name = nameOf(id);
      }
    }
    return name == null ? null : wearers.get(name.toLowerCase(Locale.ROOT));
  }

  private static String nameOf(int id) throws Exception {
    Object mc = client();
    Object level = field(mc.getClass(), "client.level", "level").get(mc);
    if (level == null) return null;
    long now = System.currentTimeMillis();
    if (level != namesLevel || now - namesAt > 5000) { names.clear(); namesLevel = level; namesAt = now; }
    if (names.containsKey(id)) return names.get(id);
    Object e = method(level.getClass(), "level.getEntity", "getEntity", int.class).invoke(level, id);
    String name = e == null ? null : String.valueOf(method(e.getClass(), "entity.getScoreboardName", "getScoreboardName").invoke(e));
    names.put(id, name);
    return name;
  }

  // ---- what -----------------------------------------------------------------------------------

  private static Mesh mesh(Object layer, String id) {
    if (!id.matches("[a-z0-9_]{1,32}")) return null;
    if (meshes.containsKey(id)) return meshes.get(id);
    Mesh m = null;
    try {
      m = load(id);
      if (!PartyBridge.setting("cosmetic.api", "").equals("legacy")) {
        m.renderType = texture(layer, id);
        m.outlineType = cullType;
      }
    } catch (Throwable e) {
      SkinAgent.log("cosmetic " + id + ": " + (e instanceof InvocationTargetException ? e.getCause() : e));
      m = null;
    }
    meshes.put(id, m);
    return m;
  }

  static Mesh load(String id) throws Exception {
    List<String> lines = Files.readAllLines(new File(dir, id + ".mesh").toPath(), StandardCharsets.UTF_8);
    Mesh m = new Mesh();
    m.id = id;
    List<float[]> faces = new ArrayList<float[]>();
    List<Boolean> outline = new ArrayList<Boolean>();
    for (String line : lines) {
      String[] p = line.trim().split(" ");
      if (p.length == 0) continue;
      switch (p[0]) {
        case "slot": m.slot = p[1]; break;
        case "bone": m.bone = p[1]; break;
        case "float": {
          float[] v = floats(p, 1, 7);
          m.bob = v[0]; m.bobPeriod = v[1]; m.sway = v[2]; m.swayPeriod = v[3]; m.cx = v[4]; m.cy = v[5]; m.cz = v[6];
          break;
        }
        case "part": {
          Part part = new Part();
          float[] v = floats(p, 1, 11);
          part.px = v[0]; part.py = v[1]; part.pz = v[2]; part.rx = v[3]; part.ry = v[4]; part.rz = v[5];
          part.ax = v[6]; part.ay = v[7]; part.az = v[8]; part.period = v[9]; part.phase = v[10];
          if (p.length >= 15) { float[] w = floats(p, 12, 3); part.wx = w[0]; part.wy = w[1]; part.wz = w[2]; }
          if (p.length >= 26) {
            float[] u = floats(p, 15, 11);
            part.bx = u[0]; part.by = u[1]; part.bz = u[2]; part.burstPeriod = u[3]; part.burstEvery = u[4]; part.burstDur = u[5]; part.burstOffset = u[6];
            part.squash = u[7]; part.blinkEvery = u[8]; part.blinkDur = u[9]; part.blinkOffset = u[10];
          }
          m.parts.add(part);
          break;
        }
        case "f": faces.add(floats(p, 1, 24)); outline.add(false); break;
        case "g": faces.add(floats(p, 1, 24)); outline.add(true); m.hasOutline = true; break;
        default: break;
      }
    }
    if (m.slot == null || m.bone == null) throw new IllegalStateException("not a mesh");
    m.faceCount = faces.size();
    m.faces = new float[faces.size() * 24];
    m.outline = new boolean[faces.size()];
    for (int i = 0; i < faces.size(); i++) {
      System.arraycopy(faces.get(i), 0, m.faces, i * 24, 24);
      m.outline[i] = outline.get(i);
    }
    return m;
  }

  private static float[] floats(String[] p, int from, int count) {
    float[] out = new float[count];
    for (int i = 0; i < count; i++) out[i] = Float.parseFloat(p[from + i]);
    return out;
  }

  private static Object cullType; // the last texture's render type for its outline
  private static Method beaconBeam;

  // the item's texture, registered with the game once: its render type (and
  // its outline's, cullType: glowing and solid — see below)
  private static Object texture(Object layer, String id) throws Exception {
    Class<?> identifier = type("identifier", "net.minecraft.resources.Identifier");
    Object location;
    try { location = method(identifier, "identifier.fromNamespaceAndPath", "fromNamespaceAndPath", String.class, String.class).invoke(null, "mclauncher", "cosmetics/" + id); }
    catch (NoSuchMethodException old) { location = identifier.getConstructor(String.class, String.class).newInstance("mclauncher", "cosmetics/" + id); }
    Class<?> image = type("image", "com.mojang.blaze3d.platform.NativeImage");
    Object img;
    InputStream in = new FileInputStream(textureFile(id));
    try { img = method(image, "image.read", "read", InputStream.class).invoke(null, in); } finally { in.close(); }
    Class<?> dynamic = type("dynamicTexture", "net.minecraft.client.renderer.texture.DynamicTexture");
    Object tex;
    try { tex = dynamic.getConstructor(Supplier.class, image).newInstance((Supplier<String>) () -> "mclauncher cosmetic " + id, img); }
    catch (NoSuchMethodException old) { tex = dynamic.getConstructor(image).newInstance(img); }
    Object mc = client();
    if (textureManager == null) textureManager = method(mc.getClass(), "client.getTextureManager", "getTextureManager").invoke(mc);
    Class<?> abstractTexture = type("abstractTexture", "net.minecraft.client.renderer.texture.AbstractTexture");
    method(textureManager.getClass(), "textureManager.register", "register", identifier, abstractTexture).invoke(textureManager, location, tex);
    if (entityCutout == null) {
      Class<?> types = type("renderTypes", "net.minecraft.client.renderer.rendertype.RenderTypes");
      entityCutout = method(types, "renderTypes.entityCutoutNoCull", "entityCutout", identifier);
      try { beaconBeam = method(types, "renderTypes.beaconBeam", "beaconBeam", identifier, boolean.class); }
      catch (Exception none) { beaconBeam = null; }
    }
    // The outline as a solid beacon beam: no light on it and no shadows, in
    // the game and in every shader pack (Iris gives the beam a program of its
    // own, gbuffers_beaconbeam: its colour, glowing, never shaded), and not
    // see-through. It culls: the faces drawn (emit) are the ones turned to the
    // eye. A game without it: the model's own type.
    cullType = beaconBeam != null ? beaconBeam.invoke(null, location, false) : entityCutout.invoke(null, location);
    return entityCutout.invoke(null, location);
  }

  private static void draw(Object layer, Object[] args, List<Mesh> list) throws Exception {
    Object poseStack = args[2], buffers = args[3], state = args[5];
    final int light = (Integer) args[4];
    boolean submitted = "submit".equals(PartyBridge.setting("cosmetic.api", "submit"));
    if (getParentModel == null) {
      getParentModel = method(layer.getClass(), "renderLayer.getParentModel", "getParentModel");
      pushPose = method(poseStack.getClass(), "poseStack.pushPose", "pushPose");
      popPose = method(poseStack.getClass(), "poseStack.popPose", "popPose");
    }
    if (submitted && submitCustom == null) {
      geometryType = type("customGeometry", "net.minecraft.client.renderer.SubmitNodeCollector$CustomGeometryRenderer");
      Class<?> collector = type("collector", "net.minecraft.client.renderer.SubmitNodeCollector");
      for (Method m : collector.getMethods()) {
        if (m.getName().equals(PartyBridge.setting("collector.submitCustomGeometry", "submitCustomGeometry")) && m.getParameterTypes().length == 3) submitCustom = m;
      }
      if (submitCustom == null) throw new NoSuchMethodException("submitCustomGeometry");
    }
    Object model = getParentModel.invoke(layer);
    if (modelHead == null) {
      modelHead = field(model.getClass(), "humanoidModel.head", "head");
      modelBody = field(model.getClass(), "humanoidModel.body", "body");
    }
    boolean helmet = !empty(equipment(state, true));
    Object chest = equipment(state, false);
    boolean elytra = chest != null && String.valueOf(chest).toLowerCase(Locale.ROOT).contains("elytra");
    final float time = (System.nanoTime() % 3_600_000_000_000L) / 1e9f;
    // the inventory's figure (drawn scaled up to pixels): its pet stays by its shoulder
    Object last = method(poseStack.getClass(), "poseStack.last", "last").invoke(poseStack);
    if (poseMatrix == null) { poseMatrix = method(last.getClass(), "pose.pose", "pose"); normalMatrix = method(last.getClass(), "pose.normal", "normal"); }
    float[] at = matrix(poseMatrix.invoke(last), 4);
    final boolean onScreen = Math.sqrt(at[0] * at[0] + at[1] * at[1] + at[2] * at[2]) > 3;
    for (final Mesh m : list) {
      final float[] follow = "root".equals(m.bone) && !onScreen ? follow(state, m) : null;
      // a hat not over a helmet, wings not with an elytra; a pet whatever's worn
      if ("head".equals(m.slot) ? helmet : "back".equals(m.slot) && elytra) continue;
      pushPose.invoke(poseStack);
      try {
        // a pet: by the player as a whole (the model's root), not on a part of it
        if (!"root".equals(m.bone)) {
          Object part = ("head".equals(m.bone) ? modelHead : modelBody).get(model);
          if (translateAndRotate == null) translateAndRotate = method(part.getClass(), "modelPart.translateAndRotate", "translateAndRotate", poseStack.getClass());
          translateAndRotate.invoke(part, poseStack);
        }
        if (submitted) {
          submitCustom.invoke(buffers, poseStack, m.renderType, renderer(gameLoader, m, false, light, time, follow));
          if (m.hasOutline) submitCustom.invoke(buffers, poseStack, m.outlineType, renderer(gameLoader, m, true, FULL_BRIGHT, time, follow));
        } else {
          Object pose = method(poseStack.getClass(), "poseStack.last", "last").invoke(poseStack);
          Class<?> source = type("bufferSource", "net.minecraft.client.renderer.MultiBufferSource");
          Class<?> rt = type("renderTypes", "net.minecraft.client.renderer.RenderType");
          Method getBuffer = method(source, "bufferSource.getBuffer", "getBuffer", rt);
          emit(m, pose, getBuffer.invoke(buffers, m.renderType), light, time, false, follow);
          if (m.hasOutline) emit(m, pose, getBuffer.invoke(buffers, m.outlineType != null ? m.outlineType : m.renderType), FULL_BRIGHT, time, true, follow);
        }
      } finally { popPose.invoke(poseStack); }
    }
  }

  // ---- a pet following its player as a creature of its own ------------------------------------------
  // Its spot by the shoulder, in the world, from the player's place and turn
  // (the model's root: turned 180 - body yaw, flipped on x and y, 1.501 down).
  // Free, not tied to it: while the player is close it stays where it is
  // (only rising and sinking with the player); once the spot is more than
  // LEASH away (or the player walks into it) it flies after it smoothly —
  // walls are nothing to it — looking at the player as it goes, leaning in
  // the wind of its own speed, and settles when it's back by the shoulder.
  static final class Follow { double x, y, z; float yaw, wind; boolean going; long at, seen; }
  private static final double LEASH = 1.6, SETTLED = 0.25, PERSONAL = 0.55;
  private static final Map<String, Follow> follows = new HashMap<String, Follow>();
  private static Field stateX, stateY, stateZ, stateBody, stateIdOf;
  private static long followsSwept;

  /** {x, y, z offset in the model's space; the turn about its middle (degrees); the wind 0…1}, or null. */
  static float[] follow(Object state, Mesh m) {
    try {
      if (stateX == null) {
        stateX = field(state.getClass(), "entityState.x", "x");
        stateY = field(state.getClass(), "entityState.y", "y");
        stateZ = field(state.getClass(), "entityState.z", "z");
        stateBody = field(state.getClass(), "livingState.bodyRot", "bodyRot");
        stateIdOf = field(state.getClass(), "playerState.id", "id");
      }
      double px = stateX.getDouble(state), py = stateY.getDouble(state), pz = stateZ.getDouble(state);
      float body = stateBody.getFloat(state);
      String key = stateIdOf.getInt(state) + ":" + m.id;
      double t = Math.toRadians(180 - body), c = Math.cos(t), s = Math.sin(t);
      // the rest spot: the pet's middle by the shoulder, in the world
      double dx = -m.cx, dy = 1.501 - m.cy, dz = m.cz;
      double rx = px + dx * c + dz * s, ry = py + dy, rz = pz - dx * s + dz * c;
      long now = System.nanoTime();
      Follow f = follows.get(key);
      if (f == null || now - f.seen > 1_000_000_000L || Math.abs(f.x - rx) + Math.abs(f.y - ry) + Math.abs(f.z - rz) > 8) {
        // new, or back after a while, or the player went far at once (a teleport): there already
        f = new Follow(); f.x = rx; f.y = ry; f.z = rz; f.yaw = body; f.at = now;
        follows.put(key, f);
      }
      f.seen = now;
      double dt = Math.min(0.1, (now - f.at) / 1e9);
      f.at = now;
      if (dt > 0) {
        double away = Math.hypot(rx - f.x, rz - f.z), near = Math.hypot(f.x - px, f.z - pz);
        if (away > LEASH || near < PERSONAL) f.going = true;
        else if (away < SETTLED) f.going = false;
        double k = f.going ? 1 - Math.exp(-dt * 3.8) : 0;
        double mx = (rx - f.x) * k, my = (ry - f.y) * (1 - Math.exp(-dt * 5)), mz = (rz - f.z) * k;
        f.x += mx; f.y += my; f.z += mz;
        float speed = (float) (Math.hypot(mx, mz) / dt);
        f.wind += (Math.min(1f, speed / 4f) - f.wind) * (float) (1 - Math.exp(-dt * 4));
        // going after the player: its face to the player; at rest: as it was
        if (f.going) {
          float look = (float) Math.toDegrees(Math.atan2(-(px - f.x), pz - f.z));
          f.yaw += wrap(look - f.yaw) * (float) (1 - Math.exp(-dt * 4));
        }
      }
      if (now - followsSwept > 10_000_000_000L) {
        followsSwept = now;
        follows.values().removeIf(x -> now - x.seen > 10_000_000_000L);
      }
      // back into the model's space
      double wx = f.x - px, wy = f.y - py, wz = f.z - pz;
      double ix = wx * c - wz * s, iz = wx * s + wz * c;
      return new float[] {(float) (-ix - m.cx), (float) (1.501 - wy - m.cy), (float) (iz - m.cz), wrap(f.yaw - body), f.wind};
    } catch (Throwable e) {
      return null;
    }
  }

  private static float wrap(float degrees) {
    float d = degrees % 360f;
    if (d > 180) d -= 360;
    if (d < -180) d += 360;
    return d;
  }

  static Object equipment(Object player, boolean head) throws Exception {
    try { return field(player.getClass(), head ? "livingState.headEquipment" : "livingState.chestEquipment", head ? "headEquipment" : "chestEquipment").get(player); }
    catch (NoSuchFieldException entity) {
      Class<?> slot = type("equipmentSlot", "net.minecraft.world.entity.EquipmentSlot");
      Object value = field(slot, head ? "equipmentSlot.HEAD" : "equipmentSlot.CHEST", head ? "HEAD" : "CHEST").get(null);
      return method(player.getClass(), "living.getItemBySlot", "getItemBySlot", slot).invoke(player, value);
    }
  }

  // the game's CustomGeometryRenderer: the mesh's faces, its outline's or the rest
  private static Object renderer(ClassLoader loader, final Mesh m, final boolean outline, final int light, final float time, final float[] follow) {
    return Proxy.newProxyInstance(loader, new Class<?>[] {geometryType}, new InvocationHandler() {
      @Override
      public Object invoke(Object proxy, Method method, Object[] a) throws Throwable {
        if (method.getName().equals(PartyBridge.setting("customGeometry.render", "render")) && a != null && a.length == 2) {
          try { emit(m, a[0], a[1], light, time, outline, follow); }
          catch (Throwable e) { broken = true; SkinAgent.log("cosmetics off (draw): " + (e instanceof InvocationTargetException ? e.getCause() : e)); }
          return null;
        }
        if (method.getName().equals("hashCode")) return System.identityHashCode(proxy);
        if (method.getName().equals("equals")) return proxy == a[0];
        if (method.getName().equals("toString")) return "MC Launcher cosmetic " + m.id + (outline ? " (outline)" : "");
        return null;
      }
    });
  }

  static boolean empty(Object stack) throws Exception {
    if (stack == null) return true;
    if (isEmpty == null) isEmpty = method(stack.getClass(), "itemStack.isEmpty", "isEmpty");
    return (Boolean) isEmpty.invoke(stack);
  }

  // The mesh's faces through the pose the game captured, each part turned
  // about its pivot first (rest pose plus its slow sine).
  static void emit(Mesh m, Object pose, Object consumer, int light, float time, boolean outline) throws Exception {
    emit(m, pose, consumer, light, time, outline, null);
  }

  // follow: a pet's place by its player (draw's follow()), else null
  static void emit(Mesh m, Object pose, Object consumer, int light, float time, boolean outline, float[] follow) throws Exception {
    if (poseMatrix == null) {
      poseMatrix = method(pose.getClass(), "pose.pose", "pose");
      normalMatrix = method(pose.getClass(), "pose.normal", "normal");
    }
    Object m4 = poseMatrix.invoke(pose), m3 = normalMatrix.invoke(pose);
    if (addVertex == null) {
      Class<?> vertex = type("vertexConsumer", "com.mojang.blaze3d.vertex.VertexConsumer");
      try { addVertex = method(vertex, "vertexConsumer.addVertex", "addVertex", float.class, float.class, float.class, int.class, float.class, float.class, int.class, int.class, float.class, float.class, float.class); }
      catch (NoSuchMethodException old) {
        oldVertex = true;
        addVertex = method(vertex, "vertexConsumer.vertex", "vertex", float.class, float.class, float.class, float.class, float.class, float.class, float.class, float.class, float.class, int.class, int.class, float.class, float.class, float.class);
      }
    }
    float[] a = matrix(m4, 4), n = matrix(m3, 3);
    float[][] rot = new float[m.parts.size()][];
    final float wind = follow != null ? follow[4] : 0;
    for (int i = 0; i < rot.length; i++) rot[i] = partRotation(m.parts.get(i), time, wind);
    // a pet floating: the whole of it up and down, turned a little about its middle (and after its player)
    float lift = 0, sc = 1, ss = 0, ox = 0, oy = 0, oz = 0;
    if (m.bobPeriod > 0) {
      lift = m.bob * (float) Math.sin(2 * Math.PI * time / m.bobPeriod);
      double yaw = Math.toRadians(m.sway * Math.sin(2 * Math.PI * time / (m.swayPeriod > 0 ? m.swayPeriod : m.bobPeriod)) + (follow != null ? follow[3] : 0));
      sc = (float) Math.cos(yaw); ss = (float) Math.sin(yaw);
      if (follow != null) { ox = follow[0]; oy = follow[1]; oz = follow[2]; }
    }
    // where the eye is, for an outline's faces: the world is drawn about the
    // camera (it's at 0, 0, 0); a screen's figure (the inventory) is drawn
    // scaled up to pixels and looked at straight along z
    final boolean screen = Math.sqrt(a[0] * a[0] + a[1] * a[1] + a[2] * a[2]) > 3;
    // a pose that mirrors (the inventory's figure: z scaled by -1) turns the corners' order round
    final boolean mirrored = a[0] * (a[5] * a[10] - a[9] * a[6]) - a[4] * (a[1] * a[10] - a[9] * a[2]) + a[8] * (a[1] * a[6] - a[5] * a[2]) < 0;
    float[] v = new float[3], w = new float[3], p = new float[12];
    for (int f = 0; f < m.faceCount; f++) {
      if (m.outline[f] != outline) continue;
      int o = f * 24;
      int pi = (int) m.faces[o];
      Part part = pi >= 0 && pi < rot.length ? m.parts.get(pi) : null;
      float[] r = part != null ? rot[pi] : null;
      // the normal (for the light): the part's turn, then the pose's
      v[0] = m.faces[o + 1]; v[1] = m.faces[o + 2]; v[2] = m.faces[o + 3];
      if (r != null) turn(r, v);
      if (m.bobPeriod > 0) { float x = v[0] * sc + v[2] * ss, z = -v[0] * ss + v[2] * sc; v[0] = x; v[2] = z; }
      float nx = n[0] * v[0] + n[3] * v[1] + n[6] * v[2];
      float ny = n[1] * v[0] + n[4] * v[1] + n[7] * v[2];
      float nz = n[2] * v[0] + n[5] * v[1] + n[8] * v[2];
      float len = (float) Math.sqrt(nx * nx + ny * ny + nz * nz);
      if (len > 0) { nx /= len; ny /= len; nz /= len; }
      for (int k = 0; k < 4; k++) {
        int q = o + 4 + k * 5;
        w[0] = m.faces[q]; w[1] = m.faces[q + 1]; w[2] = m.faces[q + 2];
        if (r != null) {
          w[0] -= part.px; w[1] -= part.py; w[2] -= part.pz;
          turn(r, w);
          w[0] += part.px; w[1] += part.py; w[2] += part.pz;
        }
        if (m.bobPeriod > 0) {
          float x = w[0] - m.cx, z = w[2] - m.cz;
          w[0] = m.cx + x * sc + z * ss + ox; w[2] = m.cz - x * ss + z * sc + oz; w[1] += lift + oy;
        }
        p[k * 3] = a[0] * w[0] + a[4] * w[1] + a[8] * w[2] + a[12];
        p[k * 3 + 1] = a[1] * w[0] + a[5] * w[1] + a[9] * w[2] + a[13];
        p[k * 3 + 2] = a[2] * w[0] + a[6] * w[1] + a[10] * w[2] + a[14];
        // a pet's line a little farther from the eye than it is: where its own body is, the body
        // wins (no strip of it over the body where one part hangs over another); round its edge it shows
        if (outline && m.bobPeriod > 0 && !screen) {
          float d = (float) Math.sqrt(p[k * 3] * p[k * 3] + p[k * 3 + 1] * p[k * 3 + 1] + p[k * 3 + 2] * p[k * 3 + 2]);
          if (d > 0.01f) { float g = 1 + 0.25f / d; p[k * 3] *= g; p[k * 3 + 1] *= g; p[k * 3 + 2] *= g; }
        }
      }
      // An outline is a shell seen from inside: of its faces only those
      // turned to the eye (by their corners' own turn, not the light's
      // normal, which is the same "up" for all of them) — dropped here, not
      // by the render type, so any shader pack draws it as it draws the model
      if (outline && facing(p, screen) == mirrored) continue;
      for (int k = 0; k < 4; k++) {
        int q = o + 4 + k * 5;
        if (oldVertex) addVertex.invoke(consumer, p[k * 3], p[k * 3 + 1], p[k * 3 + 2], 1f, 1f, 1f, 1f, m.faces[q + 3], m.faces[q + 4], noOverlay, light, nx, ny, nz);
        else addVertex.invoke(consumer, p[k * 3], p[k * 3 + 1], p[k * 3 + 2], 0xFFFFFFFF, m.faces[q + 3], m.faces[q + 4], noOverlay, light, nx, ny, nz);
      }
    }
  }

  // Is a quad (its corners in the order drawn: counter-clockwise from its
  // front) turned to the eye — at 0, 0, 0, or along +z on a screen?
  static boolean facing(float[] p, boolean screen) {
    float ax = p[3] - p[0], ay = p[4] - p[1], az = p[5] - p[2];
    float bx = p[6] - p[0], by = p[7] - p[1], bz = p[8] - p[2];
    float fx = ay * bz - az * by, fy = az * bx - ax * bz, fz = ax * by - ay * bx;
    if (screen) return fz > 0;
    float cx = (p[0] + p[3] + p[6] + p[9]) / 4, cy = (p[1] + p[4] + p[7] + p[10]) / 4, cz = (p[2] + p[5] + p[8] + p[11]) / 4;
    return fx * -cx + fy * -cy + fz * -cz > 0;
  }

  private static float[] matrix(Object value, int size) throws Exception {
    float[] out = new float[size * size];
    try { value.getClass().getMethod("get", float[].class).invoke(value, (Object) out); }
    catch (NoSuchMethodException preJoml) {
      FloatBuffer buffer = java.nio.ByteBuffer.allocateDirect(out.length * 4).order(java.nio.ByteOrder.nativeOrder()).asFloatBuffer();
      method(value.getClass(), size == 4 ? "matrix4.store" : "matrix3.store", "store", FloatBuffer.class).invoke(value, buffer);
      for (int i = 0; i < out.length; i++) out[i] = buffer.get(i);
    }
    return out;
  }

  // rotation Z·Y·X (the game's ModelPart order), as a row-major 3×3
  static float[] partRotation(Part p, float time) { return partRotation(p, time, 0); }

  // wind: 0…1, how fast a pet flies after its player (its parts lean by wx, wy, wz at full)
  static float[] partRotation(Part p, float time, float wind) {
    float k = p.period > 0 ? (float) Math.sin(2 * Math.PI * time / p.period + p.phase) : 0;
    float kick = 0;
    if (p.burstEvery > 0 && p.burstDur > 0 && p.burstPeriod > 0) {
      double u = into(time + p.burstOffset, p.burstEvery);
      if (u < p.burstDur) kick = (float) (Math.sin(2 * Math.PI * u / p.burstPeriod) * Math.sin(Math.PI * u / p.burstDur));
    }
    double x = Math.toRadians(p.rx + p.ax * k + p.wx * wind + p.bx * kick), y = Math.toRadians(p.ry + p.ay * k + p.wy * wind + p.by * kick),
        z = Math.toRadians(p.rz + p.az * k + p.wz * wind + p.bz * kick);
    double cx = Math.cos(x), sx = Math.sin(x), cy = Math.cos(y), sy = Math.sin(y), cz = Math.cos(z), sz = Math.sin(z);
    // a blink: squashed top to bottom (about its pivot) before the turn
    double s = 1;
    if (p.squash > 0 && p.blinkEvery > 0 && p.blinkDur > 0) {
      double u = into(time + p.blinkOffset, p.blinkEvery);
      if (u < p.blinkDur) s = 1 - p.squash * Math.sin(Math.PI * u / p.blinkDur);
    }
    // Rz * Ry * Rx (* the blink's squash on y)
    return new float[] {
      (float) (cz * cy), (float) ((cz * sy * sx - sz * cx) * s), (float) (cz * sy * cx + sz * sx),
      (float) (sz * cy), (float) ((sz * sy * sx + cz * cx) * s), (float) (sz * sy * cx - cz * sx),
      (float) (-sy), (float) (cy * sx * s), (float) (cy * cx),
    };
  }

  // how far into its round of length every the time t is (0 … every)
  private static double into(double t, double every) {
    double u = t % every;
    return u < 0 ? u + every : u;
  }

  static void turn(float[] r, float[] v) {
    float x = r[0] * v[0] + r[1] * v[1] + r[2] * v[2];
    float y = r[3] * v[0] + r[4] * v[1] + r[5] * v[2];
    float z = r[6] * v[0] + r[7] * v[1] + r[8] * v[2];
    v[0] = x; v[1] = y; v[2] = z;
  }

  private CosmeticLayer() {}
}
