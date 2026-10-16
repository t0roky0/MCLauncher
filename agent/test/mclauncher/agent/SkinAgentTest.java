package mclauncher.agent;
import java.io.*;
import java.lang.reflect.*;
import java.nio.file.*;
import java.nio.charset.StandardCharsets;
import java.util.*;

public class SkinAgentTest {
  public interface Session {
    default Object packed(Object profile) { return profile; }
  }
  public static class Service implements Session {}
  private static byte[] bytes(String name) throws IOException {
    try (InputStream in = SkinAgentTest.class.getResourceAsStream(name + ".class")) {
      ByteArrayOutputStream out = new ByteArrayOutputStream(); byte[] buf = new byte[4096]; int n;
      while ((n = in.read(buf)) != -1) out.write(buf, 0, n);
      return out.toByteArray();
    }
  }
  public static class Texture {
    public static Object processLegacySkin(Object image, String url) { return "vanilla"; }
  }
  public static class Effects {
    public static int fires;
    public static void submitFire(Object pose, Object collector, Object sprite) { fires++; }
  }
  public static class Mouse {
    public double scrolled;
    private void onScroll(long window, double x, double y) { scrolled += y; }
  }
  private static Class<?> define(final String name, final byte[] b) {
    return new ClassLoader(SkinAgentTest.class.getClassLoader()) { Class<?> it() { return defineClass(name, b, 0, b.length); } }.it();
  }
  public static void main(String[] args) throws Exception {
    // the overlay's game settings: a static void method wrapped (the fire over the screen), an instance one with primitives (the wheel)
    byte[] fx = SkinAgent.Patcher.patch(bytes("SkinAgentTest$Effects"), new String[][]{{"submitFire", "(Ljava/lang/Object;Ljava/lang/Object;Ljava/lang/Object;)V", "static"}});
    Class<?> effects = define(Effects.class.getName(), fx);
    Method fire = effects.getMethod("submitFire", Object.class, Object.class, Object.class);
    Field fires = effects.getField("fires");
    Comfort.configure(Collections.<String>emptyList());
    fire.invoke(null, "a", "b", "c");
    if (fires.getInt(null) != 1) throw new AssertionError("Fire must still draw when the setting is off");
    Comfort.configure(Collections.singletonList("#comfort	noFire	1"));
    fire.invoke(null, "a", "b", "c");
    if (fires.getInt(null) != 1) throw new AssertionError("No fire must skip the original");
    Comfort.configure(Collections.<String>emptyList());
    System.out.println("PASS: static void wrapper verifies; the fire is drawn or not by the setting");
    byte[] mx = SkinAgent.Patcher.patch(bytes("SkinAgentTest$Mouse"), new String[][]{{"onScroll", "(JDD)V", "around"}});
    Class<?> mouse = define(Mouse.class.getName(), mx);
    Object m = mouse.getConstructor().newInstance();
    Method scroll = mouse.getDeclaredMethod("onScroll", long.class, double.class, double.class);
    scroll.setAccessible(true);
    scroll.invoke(m, 1L, 0.0, 2.0);
    if (mouse.getField("scrolled").getDouble(m) != 2.0) throw new AssertionError("The wheel must reach the game when not zooming");
    Field zooming = Comfort.class.getDeclaredField("zooming"); zooming.setAccessible(true); zooming.set(null, true);
    scroll.invoke(m, 1L, 0.0, 2.0);
    zooming.set(null, false);
    if (mouse.getField("scrolled").getDouble(m) != 2.0) throw new AssertionError("The wheel must zoom, not scroll, while zooming");
    System.out.println("PASS: wheel wrapper verifies; zooming takes the wheel");

    final byte[] iface = SkinAgent.Patcher.patch(bytes("SkinAgentTest$Session"), new String[][]{{"packed", "(Ljava/lang/Object;)Ljava/lang/Object;", "test"}});
    final byte[] impl = bytes("SkinAgentTest$Service");
    ClassLoader loader = new ClassLoader(SkinAgentTest.class.getClassLoader()) {
      @Override public Class<?> loadClass(String name) throws ClassNotFoundException {
        synchronized (getClassLoadingLock(name)) {
          Class<?> loaded = findLoadedClass(name); if (loaded != null) return loaded;
          byte[] b = name.equals(Session.class.getName()) ? iface : name.equals(Service.class.getName()) ? impl : null;
          return b == null ? super.loadClass(name) : defineClass(name, b, 0, b.length);
        }
      }
    };
    Object service = loader.loadClass(Service.class.getName()).getConstructor().newInstance();
    Object profile = new Object();
    if (service.getClass().getMethod("packed", Object.class).invoke(service, profile) != profile) throw new AssertionError("Interface default wrapper must preserve original result");
    System.out.println("PASS: Java 8 default interface skin method verifies and executes");
    File file = File.createTempFile("mcl-agent-test", ".txt");
    try {
      Files.write(file.toPath(), Collections.singletonList("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\tSelf\tslim\thttp://127.0.0.1:1234/skin/test.png\t"), StandardCharsets.UTF_8);
      Field data = SkinAgent.class.getDeclaredField("dataFile");data.setAccessible(true);data.set(null,file);
      Method reload = SkinAgent.class.getDeclaredMethod("reload");reload.setAccessible(true);reload.invoke(null);
      byte[] bytes;
      try (InputStream stream = SkinAgentTest.class.getResourceAsStream("SkinAgentTest$Texture.class")) {
        ByteArrayOutputStream b = new ByteArrayOutputStream();byte[] chunk = new byte[4096];int n;
        while ((n=stream.read(chunk))!=-1) b.write(chunk,0,n);bytes=b.toByteArray();
      }
      final byte[] patched = SkinAgent.Patcher.patch(bytes,new String[][]{{"processLegacySkin","(Ljava/lang/Object;Ljava/lang/String;)Ljava/lang/Object;","image"}});
      Class<?> type = new ClassLoader(SkinAgentTest.class.getClassLoader()) { Class<?> texture(){return defineClass(Texture.class.getName(),patched,0,patched.length);} }.texture();
      Method process = type.getMethod("processLegacySkin",Object.class,String.class);
      Object image = new Object();
      if (process.invoke(null,image,"http://127.0.0.1:1234/skin/test.png") != image) throw new AssertionError("Launcher PNG must preserve the original image and alpha");
      if (!"vanilla".equals(process.invoke(null,image,"https://textures.minecraft.net/official"))) throw new AssertionError("Official image processing changed");
      System.out.println("PASS: static bytecode wrapper verifies; launcher texture bypasses vanilla; official textures retain processing");
    } finally { Files.deleteIfExists(file.toPath()); }
  }
}
