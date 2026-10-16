package mclauncher.agent;
import java.io.*;
import java.util.*;
import java.nio.charset.StandardCharsets;

// For the launcher's event quests: our position, the server we're on, monsters beaten.
public class NearbyQuestTest {
  public interface Monster {}
  public static class Profile { final String name; Profile(String name){this.name=name;} public String name(){return name;} }
  public static class Damage { final Object by; Damage(Object by){this.by=by;} public Object getEntity(){return by;} }
  public static class Mob {
    final int id; boolean dead; Damage last; Mob(int id){this.id=id;}
    public int getId(){return id;} public boolean isDeadOrDying(){return dead;} public Damage getLastDamageSource(){return last;}
  }
  public static class Zombie extends Mob implements Monster { Zombie(int id){super(id);} }
  public static class Cow extends Mob { Cow(int id){super(id);} }
  // an old game: the client doesn't know who hurt a monster
  public static class OldZombie implements Monster {
    final int id; boolean dead; OldZombie(int id){this.id=id;}
    public int getId(){return id;} public boolean isDeadOrDying(){return dead;}
  }
  public static class Player {
    double x=10.25,y=64,z=-3.5; final UUID id=UUID.randomUUID(); public boolean swinging;
    public double getX(){return x;} public double getY(){return y;} public double getZ(){return z;} public double getEyeY(){return y+1.62;}
    public float getYRot(){return 0;} public boolean isUnderWater(){return false;}
    public UUID getUUID(){return id;} public Profile getGameProfile(){return new Profile("Self");}
    public boolean isDeadOrDying(){return false;} public int getId(){return 1;}
  }
  public static class Level {
    List<Object> players=new ArrayList<Object>(), entities=new ArrayList<Object>();
    public List<Object> players(){return players;} public Iterable<Object> entitiesForRendering(){return entities;}
  }
  public static class ServerData { public String ip="mc.hypixel.net"; }
  public static class Minecraft { public Player player; public Level level; public Object crosshairPickEntity; ServerData server=new ServerData(); public ServerData getCurrentServer(){return server;} }

  static String[] self(Minecraft mc) throws Exception {
    Thread.sleep(220);
    ByteArrayOutputStream bytes=new ByteArrayOutputStream();PrintStream previous=System.out;
    try { System.setOut(new PrintStream(bytes,true,"UTF-8")); NearbyBridge.tick(mc); } finally { System.setOut(previous); }
    String[] emitted=bytes.toString("UTF-8").trim().split("\t",2);
    return new String(Base64.getDecoder().decode(emitted[1]),StandardCharsets.UTF_8).split("\n")[0].split("\t");
  }
  static void expect(Minecraft mc, String kills, String what) throws Exception {
    mc.player.x+=1;
    String[] r=self(mc);
    if(!kills.equals(r[8])) throw new AssertionError(what+" "+Arrays.toString(r));
  }

  public static void main(String[] args) throws Exception {
    PartyBridge.configure(Arrays.asList("#party\tclass.enemy\tmclauncher.agent.NearbyQuestTest$Monster"));
    Minecraft mc=new Minecraft(); mc.player=new Player(); mc.level=new Level(); mc.level.players.add(mc.player); mc.level.entities.add(mc.player);
    String[] r=self(mc);
    if(!"10.25".equals(r[4])||!"64.0".equals(r[5])||!"-3.5".equals(r[6])) throw new AssertionError("position "+Arrays.toString(r));
    if(!"mc.hypixel.net".equals(r[7])||!"0".equals(r[8])) throw new AssertionError("server/kills "+Arrays.toString(r));
    // the server says we hurt it (a sword, an arrow), it dies: one kill, once
    Zombie z=new Zombie(42); mc.level.entities.add(z);
    z.last=new Damage(mc.player); expect(mc,"0","hurt, alive");
    z.dead=true; expect(mc,"1","one kill");
    expect(mc,"1","counted once");
    // dying in the very tick it was hurt
    Zombie quick=new Zombie(43); mc.level.entities.add(quick); quick.last=new Damage(mc.player); quick.dead=true;
    expect(mc,"2","one blow");
    // someone else's kill, or not a monster: nothing
    Zombie theirs=new Zombie(44); mc.level.entities.add(theirs); theirs.last=new Damage(new Object()); theirs.dead=true;
    Cow cow=new Cow(45); mc.level.entities.add(cow); cow.last=new Damage(mc.player); cow.dead=true;
    expect(mc,"2","only our monsters");
    // an old game: the monster under the crosshair while we swing
    OldZombie old=new OldZombie(46); mc.level.entities.add(old);
    mc.crosshairPickEntity=old; mc.player.swinging=true; expect(mc,"2","swung, alive");
    mc.player.swinging=false; mc.crosshairPickEntity=null; old.dead=true; expect(mc,"3","swung, then it died");
    mc.server=null; mc.player.x=15;
    r=self(mc);
    if(!"".equals(r[7])) throw new AssertionError("singleplayer "+Arrays.toString(r));
    System.out.println("PASS: position, server address, monsters beaten once (by damage source and by swing)");
  }
}
