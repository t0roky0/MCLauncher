package mclauncher.agent;
import java.io.*;
import java.util.*;
import java.nio.charset.StandardCharsets;

// Direction relative to the view, blocks between heads, water and a roof.
public class NearbySurroundingsTest {
  public static class Profile { final String name; Profile(String name){this.name=name;} public String name(){return name;} }
  public static class Pos { final int x,y,z; public Pos(int x,int y,int z){this.x=x;this.y=y;this.z=z;} }
  public static class State { final boolean solid; State(boolean solid){this.solid=solid;} public boolean canOcclude(){return solid;} }
  public static class Player {
    final double x,y,z; final float yaw; final boolean wet; final UUID id=UUID.randomUUID(); final String name;
    Player(String name,double x,double y,double z,float yaw,boolean wet){this.name=name;this.x=x;this.y=y;this.z=z;this.yaw=yaw;this.wet=wet;}
    public double getX(){return x;} public double getY(){return y;} public double getZ(){return z;} public double getEyeY(){return y+1.5;}
    public float getYRot(){return yaw;} public boolean isUnderWater(){return wet;}
    public UUID getUUID(){return id;} public Profile getGameProfile(){return new Profile(name);}
  }
  public static class Level {
    List<Player> players; Set<String> walls=new HashSet<String>(); boolean roof;
    public List<Player> players(){return players;}
    public State getBlockState(Pos p){return new State(walls.contains(p.x+","+p.y+","+p.z));}
    public boolean canSeeSky(Pos p){return !roof;}
  }
  public static class Minecraft { public Player player; public Level level; }

  static String[][] sample(Minecraft mc) throws Exception {
    ByteArrayOutputStream bytes=new ByteArrayOutputStream();PrintStream previous=System.out;
    try { System.setOut(new PrintStream(bytes,true,"UTF-8")); NearbyBridge.tick(mc); } finally { System.setOut(previous); }
    String[] emitted=bytes.toString("UTF-8").trim().split("\t",2);
    String[] lines=new String(Base64.getDecoder().decode(emitted[1]),StandardCharsets.UTF_8).split("\n");
    String[][] out=new String[lines.length][]; for(int i=0;i<lines.length;i++) out[i]=lines[i].split("\t"); return out;
  }
  static String[] row(String[][] s,String name){ for(String[] r:s) if(r.length>1&&r[1].equals(name)) return r; throw new AssertionError("no "+name); }
  static void near(String v,double want){ if(Math.abs(Double.parseDouble(v)-want)>0.01) throw new AssertionError(v+" != "+want); }

  public static void main(String[] args) throws Exception {
    PartyBridge.configure(Arrays.asList("#party\tclass.blockPos\tmclauncher.agent.NearbySurroundingsTest$Pos"));
    Minecraft mc=new Minecraft();
    // facing south (+Z): ahead is +Z, right is -X (west)
    mc.player=new Player("Self",0.5,64,0.5,0,false);
    mc.level=new Level();
    mc.level.players=Arrays.asList(mc.player,new Player("Ahead",0.5,64,8.5,0,false),new Player("East",6.5,64,0.5,0,true),new Player("Behind",0.5,64,-7.5,0,false));
    mc.level.walls.add("0,65,4"); mc.level.walls.add("0,65,5");
    String[][] s=sample(mc);
    if(!"0".equals(s[0][2])||!"0".equals(s[0][3])) throw new AssertionError("dry, open sky: "+Arrays.toString(s[0]));
    String[] ahead=row(s,"Ahead"), east=row(s,"East"), behind=row(s,"Behind");
    near(ahead[4],0); near(ahead[6],8); if(!"2".equals(ahead[7])) throw new AssertionError("two blocks between: "+Arrays.toString(ahead));
    near(east[4],-6); near(east[3],-1); if(!"1".equals(east[8])) throw new AssertionError("east is in water");
    near(behind[6],-8); if(!"0".equals(behind[7])) throw new AssertionError("nothing behind");
    // turned to face east (yaw -90): East is ahead now; a roof overhead
    Thread.sleep(300);
    mc.player=new Player("Self",0.5,64,0.5,-90,true);
    mc.level.players=Arrays.asList(mc.player,new Player("East",6.5,64,0.5,0,false));
    mc.level.roof=true;
    s=sample(mc);
    if(!"1".equals(s[0][2])||!"1".equals(s[0][3])) throw new AssertionError("underwater and roofed: "+Arrays.toString(s[0]));
    east=row(s,"East"); near(east[4],0); near(east[6],6);
    System.out.println("PASS: view-relative direction, blocks between, water and roof");
  }
}
