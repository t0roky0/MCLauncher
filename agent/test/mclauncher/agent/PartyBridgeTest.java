package mclauncher.agent;

import java.io.File;
import java.lang.instrument.Instrumentation;
import java.lang.reflect.Proxy;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.Arrays;
import java.util.Base64;
import java.util.Collections;
import java.util.concurrent.Executor;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;

public final class PartyBridgeTest {
  public enum Scope { OFF, LAN }
  public enum Mode { SURVIVAL, CREATIVE }
  public enum Type { LAN, REALM, OTHER }
  public static class Server {
    public boolean published, commands = true;
    public int port, publications, closures;
    public Thread expectedThread;
    public boolean isPublished() { return published; }
    public int getPort() { return port; }
    public boolean publishServer(Scope scope, int value) {
      if (expectedThread != null) check(expectedThread == Thread.currentThread(), "publish on client thread");
      check(scope == Scope.LAN, "LAN scope"); check(value > 0 && value <= 65535, "real port");
      publications++; port = value; published = true; return true;
    }
    public boolean unpublishServer() { closures++; published = false; return true; }
  }
  public static class LegacyServer {
    public Mode gameMode;
    public boolean cheats;
    public Mode getDefaultGameType() { return Mode.CREATIVE; }
    public boolean publishServer(Mode mode, boolean allow, int port) {
      gameMode = mode; cheats = allow; return port > 0;
    }
  }
  public static class Data {
    public String ip;
    public Type type;
    public Data(String name, String ip, Type type) { this.ip = ip; this.type = type; }
  }
  public static class Address {
    public String text;
    public static Address parseString(String value) { Address a = new Address(); a.text = value; return a; }
  }
  public static class Title {}
  public static class Connect {
    public static int count;
    public static String address;
    public static void startConnecting(Title title, Minecraft mc, Address a, Data data, boolean quick, Object transfer) {
      check(title != null && !quick && transfer == null, "connect arguments");
      check(data.type == Type.OTHER && data.ip.equals(a.text), "server data");
      count++; address = a.text; mc.screen = null;
    }
  }
  public static class Minecraft implements Executor {
    public static final Minecraft INSTANCE = new Minecraft();
    public Object player, server, screen;
    public Data data;
    public final LinkedBlockingQueue<Runnable> tasks = new LinkedBlockingQueue<Runnable>();
    public static Minecraft getInstance() { return INSTANCE; }
    public Object getSingleplayerServer() { return server; }
    public Data getCurrentServer() { return data; }
    public void execute(Runnable task) { tasks.add(task); }
  }
  static void check(boolean value, String message) { if (!value) throw new AssertionError(message); }
  static String line(String key, String value) { return "#party\t" + key + "\t" + value; }
  static String[] member(String id, String address) {
    return new String[] { line("role", "member"), line("class.data", Data.class.getName()), line("class.address", Address.class.getName()),
      line("class.connect", Connect.class.getName()), line("class.title", Title.class.getName()),
      line("join", id + " " + Base64.getEncoder().encodeToString(address.getBytes(StandardCharsets.UTF_8))) };
  }
  public static void main(String[] args) throws Exception {
    Minecraft mc = Minecraft.INSTANCE;
    Server first = new Server(); mc.server = first; mc.player = new Object();
    PartyBridge.configure(Collections.<String>emptyList()); PartyBridge.tick(mc);
    check(first.publications == 0, "solo worlds stay private");
    PartyBridge.configure(Arrays.asList(line("role", "leader")));
    PartyBridge.tick(mc); PartyBridge.tick(mc);
    check(first.publications == 1, "publish only once"); check(first.commands, "world commands preserved");
    Server second = new Server(); mc.server = second;
    PartyBridge.tick(mc);
    check(second.publications == 1, "next world opens too");
    PartyBridge.configure(Collections.<String>emptyList()); PartyBridge.tick(mc);
    check(second.closures == 1 && !second.published, "leaving lobby closes agent-opened LAN");
    LegacyServer legacy = new LegacyServer(); PartyBridge.publish(legacy);
    check(legacy.gameMode == Mode.CREATIVE && !legacy.cheats, "legacy world mode preserved, no guest cheats");
    mc.server = null;
    PartyBridge.configure(Arrays.asList(member("one", "example.test:25566")));
    PartyBridge.tick(mc); PartyBridge.tick(mc);
    check(Connect.count == 1 && Connect.address.equals("example.test:25566"), "connect command only once");
    PartyBridge.configure(Arrays.asList(member("two", "127.0.0.1:40000")));
    mc.screen = new Connect(); PartyBridge.tick(mc);
    check(Connect.count == 1, "wait for current connection attempt");
    mc.screen = null; PartyBridge.tick(mc);
    check(Connect.count == 2 && Connect.address.equals("127.0.0.1:40000"), "redirect running game to world");
    PartyBridge.configure(Collections.<String>emptyList()); PartyBridge.tick(mc);
    check(Connect.count == 2, "no commands after leaving lobby");

    File controls = File.createTempFile("mcl-party-test-", ".txt");
    try {
      Server scheduled = new Server(); scheduled.expectedThread = Thread.currentThread(); mc.server = scheduled;
      Files.write(controls.toPath(), Arrays.asList(line("role", "leader"), line("class.client", Minecraft.class.getName())), StandardCharsets.UTF_8);
      Instrumentation inst = (Instrumentation) Proxy.newProxyInstance(PartyBridgeTest.class.getClassLoader(), new Class<?>[] { Instrumentation.class },
        (proxy, method, arguments) -> method.getName().equals("getAllLoadedClasses") ? new Class<?>[] { Minecraft.class } : null);
      PartyBridge.start(inst, controls);
      long end = System.currentTimeMillis() + 4000;
      while (scheduled.publications == 0 && System.currentTimeMillis() < end) {
        Runnable task = mc.tasks.poll(1, TimeUnit.SECONDS); if (task != null) task.run();
      }
      check(scheduled.publications == 1, "watcher schedules automatic LAN on client executor");
    } finally { Files.deleteIfExists(controls.toPath()); }
    System.out.println("PartyBridge: all integration checks passed");
  }
}
