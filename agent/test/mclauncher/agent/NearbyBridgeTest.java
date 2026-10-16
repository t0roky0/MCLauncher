package mclauncher.agent;
import java.io.*;
import java.util.*;
import java.nio.charset.StandardCharsets;

public class NearbyBridgeTest {
  public static class Profile { final String name; Profile(String name){this.name=name;} public String name(){return name;} }
  public static class Player {
    final double x,y,z; final UUID id=UUID.randomUUID(); final String name;
    Player(String name,double x,double y,double z){this.name=name;this.x=x;this.y=y;this.z=z;}
    public double getX(){return x;} public double getY(){return y;} public double getZ(){return z;}
    public float getYRot(){return 0;} public UUID getUUID(){return id;} public Profile getGameProfile(){return new Profile(name);}
  }
  public static class Level { List<Player> players; public List<Player> players(){return players;} }
  public static class Minecraft { public Player player; public Level level; }
  public static void main(String[] args) throws Exception {
    PartyBridge.configure(Collections.<String>emptyList());
    Minecraft mc=new Minecraft();mc.player=new Player("Self",0,64,0);mc.level=new Level();
    mc.level.players=Arrays.asList(mc.player,new Player("Near",3,68,0),new Player("Far",200,64,0));
    ByteArrayOutputStream bytes=new ByteArrayOutputStream();PrintStream previous=System.out;
    try {
      System.setOut(new PrintStream(bytes,true,"UTF-8"));NearbyBridge.tick(mc);
      String[] emitted=bytes.toString("UTF-8").trim().split("\t",2);
      String payload=new String(Base64.getDecoder().decode(emitted[1]),StandardCharsets.UTF_8);
      if (!payload.contains("Near\t5.0\t-1.0") || payload.contains("Far") || payload.split("\n").length!=2) throw new AssertionError(payload);
      bytes.reset();mc.level=null;NearbyBridge.tick(mc);
      if (!bytes.toString("UTF-8").contains("[MC Launcher] nearby\t")) throw new AssertionError("No disconnected-world event");
    } finally {System.setOut(previous);}
    System.out.println("PASS: local 3D distance, nearest-player filtering and world exit");
  }
}
