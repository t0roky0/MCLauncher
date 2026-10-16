package mclauncher.agent;

import java.lang.reflect.Field;
import java.lang.reflect.InvocationTargetException;
import java.lang.reflect.Method;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.Executor;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * The overlay's game settings (the launcher's "Game" tab), in Java: full
 * brightness, a zoom (a key held; the wheel while it's held zooms further),
 * VSync, sprinting by itself, and no fire over the screen.
 *
 * The launcher writes them into the agent's data file ("#comfort" lines);
 * the game's thread applies them about every frame (the client's executor).
 * Brightness and the field of view are the game's own options, set past
 * their sliders — given back while a settings screen is open, so what the
 * game saves is what the player chose. Anything that fails turns that one
 * thing off for the session; the game goes on as it was.
 */
final class Comfort {
  private static volatile Map<String, String> settings = new HashMap<String, String>();
  private static final AtomicBoolean queued = new AtomicBoolean();
  private static boolean started;
  private static final Map<String, Boolean> broken = new HashMap<String, Boolean>();

  // what's applied, and what was there before (given back)
  private static Double gammaBefore;
  private static Integer fovBefore;
  private static Double sensitivityBefore;
  private static boolean sprintHeld;
  private static String vsyncApplied = "";
  private static double zoom = 1, zoomTarget = 4;
  private static long lastFrame;
  private static volatile boolean zooming;
  // the zoom worked out each frame (Camera.calculateFov hooked): its goal from
  // here, the way there by the clock as the camera asks — as smooth as the
  // picture; without the hook the old way (the field of view option, a whole
  // degree at a time, as often as this thread looks)
  private static volatile double zoomGoal = 1;
  private static volatile boolean fovHooked;
  private static double zoomNow = 1;
  private static long zoomAt;
  private static Method calculateFov;

  private Comfort() {}

  static void configure(List<String> lines) {
    Map<String, String> next = new HashMap<String, String>();
    for (String line : lines) {
      if (!line.startsWith("#comfort\t")) continue;
      String[] p = line.split("\t", 3);
      if (p.length == 3) next.put(p[1], p[2]);
    }
    settings = next;
  }

  private static boolean on(String key) { return "1".equals(settings.get(key)); }

  /** The fire over the screen: drawn or not (ScreenEffectRenderer.submitFire, static). */
  static Object staticHook(String name, Object[] a) {
    if ("submitFire".equals(name) && on("noFire")) return null;
    return callStatic((Class<?>) a[1], name, a);
  }

  /** The camera's field of view, every frame: the game's own, divided by the zoom as it is now. */
  static Object fov(Object[] a) {
    Object camera = a[1];
    Object original;
    try {
      if (calculateFov == null || calculateFov.getDeclaringClass() != camera.getClass()) {
        calculateFov = camera.getClass().getDeclaredMethod("mcl$" + PartyBridge.setting("camera.calculateFov", "calculateFov"), float.class);
        calculateFov.setAccessible(true);
      }
      original = calculateFov.invoke(camera, a[2]);
    } catch (InvocationTargetException e) {
      throw SkinAgent.<RuntimeException>sneaky(e.getCause() != null ? e.getCause() : e);
    } catch (ReflectiveOperationException e) {
      throw new IllegalStateException(e);
    }
    fovHooked = true;
    long now = System.nanoTime();
    double dt = zoomAt == 0 ? 0 : Math.min(0.1, (now - zoomAt) / 1e9);
    zoomAt = now;
    double goal = zoomGoal;
    if (!smooth() || dt == 0) zoomNow = goal;
    else {
      zoomNow = goal + (zoomNow - goal) * Math.exp(-dt * 13);
      if (Math.abs(zoomNow - goal) < 0.002) zoomNow = goal;
    }
    float v = ((Number) original).floatValue();
    return zoomNow > 1.001 ? (float) (v / zoomNow) : v;
  }

  private static boolean smooth() { return !"0".equals(settings.get("zoomSmooth")); }

  /** The wheel while the zoom key is held: closer or farther, not the hotbar. */
  static Object scroll(Object[] a) {
    if (zooming && a.length >= 5) {
      double y = ((Number) a[4]).doubleValue();
      if (y != 0) zoomTarget = Math.max(1.5, Math.min(40, zoomTarget * (y > 0 ? 1.25 : 0.8)));
      return null;
    }
    return SkinAgent.around("onScroll", a);
  }

  private static Object callStatic(Class<?> owner, String name, Object[] a) {
    Object[] args = new Object[a.length - 2];
    System.arraycopy(a, 2, args, 0, args.length);
    for (Method m : owner.getDeclaredMethods()) {
      if (m.getName().equals("mcl$" + name) && m.getParameterTypes().length == args.length) {
        try {
          m.setAccessible(true);
          return m.invoke(null, args);
        } catch (InvocationTargetException e) {
          throw SkinAgent.<RuntimeException>sneaky(e.getCause() != null ? e.getCause() : e);
        } catch (IllegalAccessException e) {
          throw new IllegalStateException(e);
        }
      }
    }
    throw new IllegalStateException("mcl$" + name + " missing");
  }

  /** About every frame, on the game's thread. */
  static void start() {
    if (started) return;
    started = true;
    Thread t = new Thread(() -> {
      while (true) {
        try {
          Thread.sleep(15);
          final Object mc = PartyBridge.client();
          if (mc == null || settings.isEmpty() && gammaBefore == null && fovBefore == null && !sprintHeld) continue;
          if (queued.compareAndSet(false, true)) {
            try {
              ((Executor) mc).execute(() -> {
                try { frame(mc); } catch (Throwable e) { SkinAgent.log("comfort: " + e); }
                finally { queued.set(false); }
              });
            } catch (Throwable e) { queued.set(false); }
          }
        } catch (InterruptedException e) { return; }
        catch (Throwable ignored) { /* the next round */ }
      }
    }, "MCL comfort");
    t.setDaemon(true);
    t.start();
  }

  private static void frame(Object mc) throws Exception {
    Object options = get(mc, "client.options", "options");
    if (options == null) return;
    Object screen = screen(mc);
    Object player = get(mc, "client.player", "player");
    String screenName = screen == null ? "" : screen.getClass().getName();
    // a settings screen: the options as the player set them (that's what the game saves)
    boolean settingsOpen = screenName.contains("Option") || screenName.contains("Settings") || screenName.contains("Video");
    long now = System.nanoTime();
    double dt = lastFrame == 0 ? 0.016 : Math.min(0.1, (now - lastFrame) / 1e9);
    lastFrame = now;

    if (!broken.containsKey("bright")) {
      try { bright(options, on("fullbright") && player != null && !settingsOpen); }
      catch (Throwable e) { off("bright", e); }
    }
    if (!broken.containsKey("zoom")) {
      try { zoom(mc, options, on("zoom") && screen == null && player != null && keyDown(mc, number("zoomKey", 67), number("zoomScancode", 6)), dt, settingsOpen); }
      catch (Throwable e) { off("zoom", e); zooming = false; }
    }
    if (!broken.containsKey("vsync")) {
      try { vsync(options); } catch (Throwable e) { off("vsync", e); }
    }
    if (!broken.containsKey("sprint")) {
      try { sprint(options, on("autoSprint") && screen == null && player != null); }
      catch (Throwable e) { off("sprint", e); }
    }
  }

  private static void off(String what, Throwable e) {
    broken.put(what, true);
    SkinAgent.log("comfort " + what + " off: " + (e instanceof InvocationTargetException ? e.getCause() : e));
  }

  // ---- brightness: the gamma option, far past its slider ----
  private static void bright(Object options, boolean want) throws Exception {
    Object gamma = call(options, "options.gamma", "gamma");
    if (want) {
      if (gammaBefore == null) gammaBefore = ((Number) call(gamma, "optionInstance.get", "get")).doubleValue();
      setValue(gamma, 16.0);
    } else if (gammaBefore != null) {
      setValue(gamma, gammaBefore);
      gammaBefore = null;
    }
  }

  // ---- zoom: the field of view narrowed while the key is held, smoothly; the mouse slower with it ----
  private static void zoom(Object mc, Object options, boolean held, double dt, boolean settingsOpen) throws Exception {
    zooming = held;
    // not zooming: the level the overlay's slider sets (tenths, so a decimal — not an int)
    if (!held && zoom <= 1.001) zoomTarget = number("zoomLevel", 4.0);
    double target = held ? zoomTarget : 1;
    zoomGoal = target;
    if (fovHooked) zoom = zoomNow; // the camera's hook moves it, every frame
    else if (!smooth()) zoom = target;
    else {
      zoom += (target - zoom) * Math.min(1, dt * 14);
      if (Math.abs(zoom - target) < 0.01) zoom = target;
    }
    Object fov = call(options, "options.fov", "fov");
    Object sens = call(options, "options.sensitivity", "sensitivity");
    if (zoom > 1.001 && !settingsOpen) {
      if (fovBefore == null) {
        fovBefore = ((Number) call(fov, "optionInstance.get", "get")).intValue();
        sensitivityBefore = ((Number) call(sens, "optionInstance.get", "get")).doubleValue();
      }
      if (!fovHooked) setValue(fov, Math.max(1, (int) Math.round(fovBefore / zoom)));
      // the mouse slower the closer (OptiFine's zoom)
      setValue(sens, sensitivityBefore * Math.max(0.2, Math.min(1, 1.15 / Math.sqrt(zoom))));
    } else if (fovBefore != null) {
      setValue(fov, fovBefore);
      setValue(sens, sensitivityBefore);
      fovBefore = null;
      sensitivityBefore = null;
      if (!held) zoomTarget = number("zoomLevel", 4.0);
    }
  }

  // ---- VSync: the game's own option, set when the launcher's changes ----
  private static void vsync(Object options) throws Exception {
    String want = settings.get("vsync");
    if (want == null || "game".equals(want) || want.equals(vsyncApplied)) return;
    vsyncApplied = want;
    Object opt = call(options, "options.enableVsync", "enableVsync");
    Boolean on = "on".equals(want);
    if (!on.equals(call(opt, "optionInstance.get", "get"))) {
      Method set = opt.getClass().getMethod(PartyBridge.setting("optionInstance.set", "set"), Object.class);
      set.invoke(opt, on);
    }
  }

  // ---- sprinting by itself: the sprint key held for the player (the game sprints when going forward) ----
  private static void sprint(Object options, boolean want) throws Exception {
    if (!want && !sprintHeld) return;
    Object key = get(options, "options.keySprint", "keySprint");
    Method setDown = key.getClass().getMethod(PartyBridge.setting("keyMapping.setDown", "setDown"), boolean.class);
    setDown.invoke(key, want);
    sprintHeld = want;
  }

  // ---- the game's pieces ----
  private static boolean screenInGui;

  /** The screen open now: Minecraft.screen, or (26.x) the gui's screen() — the field moved there. */
  private static Object screen(Object mc) throws Exception {
    if (!screenInGui) {
      try { return get(mc, "client.screen", "screen"); }
      catch (NoSuchFieldException moved) { screenInGui = true; }
    }
    Object gui = get(mc, "client.gui", "gui");
    return gui.getClass().getMethod(PartyBridge.setting("gui.screen", "screen")).invoke(gui);
  }

  private static Object get(Object o, String key, String name) throws Exception {
    Field f;
    String n = PartyBridge.setting(key, name);
    try { f = o.getClass().getField(n); }
    catch (NoSuchFieldException e) {
      f = null;
      for (Class<?> c = o.getClass(); c != null && f == null; c = c.getSuperclass()) {
        try { f = c.getDeclaredField(n); } catch (NoSuchFieldException ignored) { }
      }
      if (f == null) throw e;
    }
    f.setAccessible(true);
    return f.get(o);
  }

  private static Object call(Object o, String key, String name) throws Exception {
    Method m = o.getClass().getMethod(PartyBridge.setting(key, name));
    m.setAccessible(true);
    return m.invoke(o);
  }

  /** An option's value past its slider's range (the field itself, not set(), which checks it). */
  private static void setValue(Object option, Object value) throws Exception {
    Field f = null;
    for (Class<?> c = option.getClass(); c != null && f == null; c = c.getSuperclass()) {
      try { f = c.getDeclaredField(PartyBridge.setting("optionInstance.value", "value")); } catch (NoSuchFieldException ignored) { }
    }
    if (f == null) throw new NoSuchFieldException("OptionInstance.value");
    f.setAccessible(true);
    Object old = f.get(option);
    if (old instanceof Integer && value instanceof Number) value = ((Number) value).intValue();
    else if (old instanceof Double && value instanceof Number) value = ((Number) value).doubleValue();
    if (!value.equals(old)) f.set(option, value);
  }

  private static Method isKeyDown;
  private static boolean keyWithWindow;

  /** A key held now: by its SDL scancode (26.x: the game's input is SDL's), else GLFW's number. */
  private static boolean keyDown(Object mc, int glfw, int scancode) throws Exception {
    if (isKeyDown == null) {
      Class<?> input = Class.forName(PartyBridge.setting("class.inputConstants", "com.mojang.blaze3d.platform.InputConstants"), false, mc.getClass().getClassLoader());
      String name = PartyBridge.setting("inputConstants.isKeyDown", "isKeyDown");
      try { isKeyDown = input.getMethod(name, int.class); }
      catch (NoSuchMethodException old) { isKeyDown = input.getMethod(name, long.class, int.class); keyWithWindow = true; }
    }
    if (!keyWithWindow) return (Boolean) isKeyDown.invoke(null, scancode);
    Object window = call(mc, "client.getWindow", "getWindow");
    long handle;
    try { handle = (Long) call(window, "window.handle", "handle"); }
    catch (NoSuchMethodException older) { handle = (Long) call(window, "window.getWindow", "getWindow"); }
    return (Boolean) isKeyDown.invoke(null, handle, glfw);
  }

  private static double number(String key, double fallback) {
    try { return Double.parseDouble(settings.get(key)); } catch (Exception e) { return fallback; }
  }
  private static int number(String key, int fallback) {
    try { return Integer.parseInt(settings.get(key)); } catch (Exception e) { return fallback; }
  }
}
