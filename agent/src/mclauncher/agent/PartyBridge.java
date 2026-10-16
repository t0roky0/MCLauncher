package mclauncher.agent;

import java.io.File;
import java.lang.instrument.Instrumentation;
import java.lang.reflect.Constructor;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.lang.reflect.Modifier;
import java.net.ServerSocket;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.Base64;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.Executor;
import java.util.concurrent.atomic.AtomicBoolean;

/** Local launcher control. All Minecraft operations run on its client thread. */
public final class PartyBridge {
  private static final AtomicBoolean queued = new AtomicBoolean();
  private static volatile Map<String, String> settings = Collections.emptyMap();
  private static Object client;
  private static Object openedServer;
  private static Object currentServer;
  private static String lastState = "", lastCommand = "", lastError = "", role = "";
  private static long retryAt;

  public static void start(final Instrumentation instrumentation, final File file) {
    Thread watcher = new Thread(() -> {
      while (true) {
        try {
          Thread.sleep(250);
          List<String> lines = file.isFile() ? Files.readAllLines(file.toPath(), StandardCharsets.UTF_8) : Collections.<String>emptyList();
          configure(lines);
          Comfort.configure(lines);
          if (client == null) {
            String wanted = setting("class.client", "net.minecraft.client.Minecraft");
            for (Class<?> c : instrumentation.getAllLoadedClasses()) {
              if (c.getName().equals(wanted) || c.getName().equals("net.minecraft.client.Minecraft")) {
                client = method(c, "client.getInstance", "getInstance", 0).invoke(null);
                if (client != null) event("ready", "");
                break;
              }
            }
          }
          if (client != null && queued.compareAndSet(false, true)) {
            try {
              ((Executor) client).execute(() -> {
                try { SkinRefresh.tick(client, SkinAgent.revision); NearbyBridge.tick(client); tick(client); } catch (Throwable e) { failure(e); }
                finally { queued.set(false); }
              });
            } catch (Throwable e) { queued.set(false); throw e; }
          }
        } catch (InterruptedException e) { return; }
        catch (Throwable e) { if (!role.isEmpty()) failure(e); }
      }
    }, "MCL party");
    watcher.setDaemon(true);
    watcher.start();
  }

  static void configure(List<String> lines) {
    Map<String, String> next = new HashMap<String, String>();
    for (String line : lines) {
      if (!line.startsWith("#party\t")) continue;
      String[] parts = line.split("\t", 3);
      if (parts.length == 3) next.put(parts[1], parts[2]);
    }
    settings = next;
    role = setting("role", "");
  }

  static String setting(String key, String fallback) { String v = settings.get(key); return v == null ? fallback : v; }
  static Object client() { return client; }

  static void tick(Object mc) throws Exception {
    if (!"leader".equals(role)) {
      if (openedServer != null) {
        // Versions with reversible LAN publishing return to single player.
        try { method(openedServer.getClass(), "server.unpublishServer", "unpublishServer", 0).invoke(openedServer); }
        catch (NoSuchMethodException ignored) { /* older games close LAN with the world */ }
        openedServer = null;
      }
      lastState = "";
      currentServer = null;
      if ("member".equals(role)) {
        String command = setting("join", "");
        if (!command.isEmpty() && !command.equals(lastCommand)) {
          String[] parts = command.split(" ", 2);
          if (parts.length == 2) {
            try {
              if (connect(mc, new String(Base64.getDecoder().decode(parts[1]), StandardCharsets.UTF_8))) {
                lastCommand = command;
                event("command", parts[0]);
              }
            } catch (Exception error) { lastCommand = command; throw error; }
          }
        }
      } else lastCommand = "";
      return;
    }
    Object player = field(mc.getClass(), "client.player", "player").get(mc);
    Object server = method(mc.getClass(), "client.getSingleplayerServer", "getSingleplayerServer", 0).invoke(mc);
    if (server != currentServer) { currentServer = server; openedServer = null; retryAt = 0; lastState = ""; }
    if (player == null) { state("idle", ""); return; }
    if (server != null) {
      boolean published = (Boolean) method(server.getClass(), "server.isPublished", "isPublished", 0).invoke(server);
      if (!published) {
        if (System.currentTimeMillis() < retryAt) return;
        retryAt = System.currentTimeMillis() + 3000;
        publish(server);
        openedServer = server;
      }
      int port = ((Number) method(server.getClass(), "server.getPort", "getPort", 0).invoke(server)).intValue();
      if (port > 0 && port <= 65535) state("world", String.valueOf(port));
      return;
    }
    openedServer = null;
    Object data = method(mc.getClass(), "client.getCurrentServer", "getCurrentServer", 0).invoke(mc);
    if (data == null) { state("idle", ""); return; }
    String address = String.valueOf(field(data.getClass(), "data.ip", "ip").get(data));
    state("server", address);
  }

  static void publish(Object server) throws Exception {
    Method publish = null;
    for (Method m : server.getClass().getMethods()) {
      Class<?>[] p = m.getParameterTypes();
      if (!m.getName().equals(setting("server.publishServer", "publishServer")) || m.getReturnType() != boolean.class) continue;
      if ((p.length == 2 || p.length == 3) && p[0].isEnum() && p[p.length - 1] == int.class) {
        publish = m;
        if (p.length == 2) break; // modern LAN scope API keeps the world's command settings
      }
    }
    if (publish == null) throw new NoSuchMethodException("Automatic LAN is unavailable for this Minecraft version");
    Class<?> modeType = publish.getParameterTypes()[0];
    Object mode = null;
    for (Object value : modeType.getEnumConstants()) if (((Enum<?>) value).name().equals("LAN")) mode = value;
    if (mode == null) {
      try { mode = method(server.getClass(), "server.getDefaultGameType", "getDefaultGameType", 0).invoke(server); }
      catch (NoSuchMethodException ignored) { /* nullable game mode means the existing world mode */ }
    }
    int port;
    try (ServerSocket available = new ServerSocket(0)) { port = available.getLocalPort(); }
    Object[] args = publish.getParameterTypes().length == 2 ? new Object[] { mode, port } : new Object[] { mode, false, port };
    if (!Boolean.TRUE.equals(publish.invoke(server, args))) throw new IllegalStateException("Could not open the world to LAN");
  }

  static boolean connect(Object mc, String address) throws Exception {
    if (address.isEmpty() || address.length() > 256 || address.matches(".*[\\s\\x00-\\x1f].*")) throw new IllegalArgumentException("Invalid server address");
    ClassLoader loader = mc.getClass().getClassLoader();
    Class<?> dataType = loader.loadClass(setting("class.data", "net.minecraft.client.multiplayer.ServerData"));
    Class<?> addressType = loader.loadClass(setting("class.address", "net.minecraft.client.multiplayer.resolver.ServerAddress"));
    Class<?> screenType = loader.loadClass(setting("class.connect", "net.minecraft.client.gui.screens.ConnectScreen"));
    Class<?> titleType = loader.loadClass(setting("class.title", "net.minecraft.client.gui.screens.TitleScreen"));
    Object screen = null;
    try { screen = field(mc.getClass(), "client.screen", "screen").get(mc); }
    catch (NoSuchFieldException oldScreenAbsent) {
      try {
        Object gui = mc.getClass().getField("gui").get(mc);
        screen = gui.getClass().getMethod("screen").invoke(gui);
      } catch (NoSuchFieldException ignored) { /* test or custom client without a screen field */ }
    }
    if (screenType.isInstance(screen)) return false; // let an existing connection attempt finish first
    Method start = null;
    for (Method m : screenType.getMethods()) {
      Class<?>[] p = m.getParameterTypes();
      if (Modifier.isStatic(m.getModifiers()) && m.getName().equals(setting("connect.startConnecting", "startConnecting"))
          && p.length >= 4 && p.length <= 6 && p[1].isInstance(mc) && p[2] == addressType && p[3] == dataType) { start = m; break; }
    }
    if (start == null) throw new NoSuchMethodException("Automatic connection is unavailable for this Minecraft version");
    Object data = null;
    for (Constructor<?> c : dataType.getConstructors()) {
      Class<?>[] p = c.getParameterTypes();
      if (p.length != 3 || p[0] != String.class || p[1] != String.class) continue;
      Object kind = false;
      if (p[2].isEnum()) {
        Object[] values = p[2].getEnumConstants();
        kind = values[values.length - 1]; // OTHER, also when enum fields are obfuscated
        for (Object value : values) if (((Enum<?>) value).name().equals("OTHER")) kind = value;
      } else if (p[2] != boolean.class) continue;
      data = c.newInstance("MC Launcher", address, kind);
      break;
    }
    if (data == null) throw new NoSuchMethodException("ServerData constructor");
    Object parsed = method(addressType, "address.parseString", "parseString", 1).invoke(null, address);
    Object[] args = new Object[start.getParameterTypes().length];
    args[0] = titleType.getConstructor().newInstance(); args[1] = mc; args[2] = parsed; args[3] = data;
    for (int i = 4; i < args.length; i++) args[i] = start.getParameterTypes()[i] == boolean.class ? false : null;
    start.invoke(null, args); // the game's own connect screen saves/disconnects the previous world
    return true;
  }

  static Method method(Class<?> c, String key, String fallback, int count) throws NoSuchMethodException {
    String name = setting(key, fallback);
    for (Method m : c.getMethods()) if (m.getName().equals(name) && m.getParameterTypes().length == count) return m;
    throw new NoSuchMethodException(c.getName() + "." + name);
  }
  static Field field(Class<?> c, String key, String fallback) throws NoSuchFieldException {
    Field f = c.getField(setting(key, fallback)); f.setAccessible(true); return f;
  }
  private static void state(String kind, String value) {
    String next = kind + ":" + value;
    if (!next.equals(lastState)) { lastState = next; lastError = ""; event(kind, value); }
  }
  private static void failure(Throwable error) {
    Throwable cause = error.getCause() == null ? error : error.getCause();
    String message = cause.toString();
    if (!message.equals(lastError)) { lastError = message; event("error", message); }
  }
  private static void event(String kind, String value) {
    System.out.println("[MC Launcher] party\t" + kind + "\t" + Base64.getEncoder().encodeToString(value.getBytes(StandardCharsets.UTF_8)));
  }
}
