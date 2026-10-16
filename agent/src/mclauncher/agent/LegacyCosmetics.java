package mclauncher.agent;

import java.awt.image.BufferedImage;
import javax.imageio.ImageIO;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.nio.ByteBuffer;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/** LWJGL 2 player layers (1.8–1.14). No linked game or loader classes. */
final class LegacyCosmetics {
  private static Class<?> gl;
  private static final Map<String, Method> calls = new HashMap<String, Method>();
  private static final Map<String, Integer> textures = new HashMap<String, Integer>();
  private static Method beginEyes, endEyes;
  private static boolean shadersChecked;

  private static Object gl(String name, Object... args) throws Exception {
    Method m = calls.get(name);
    if (m == null) {
      Class<?>[] types = new Class<?>[args.length];
      for (int i = 0; i < args.length; i++) types[i] = args[i] instanceof Integer ? int.class : args[i] instanceof Float ? float.class : args[i] instanceof Double ? double.class : ByteBuffer.class;
      m = gl.getMethod(name, types); calls.put(name, m);
    }
    return m.invoke(null, args);
  }

  private static int texture(String id) throws Exception {
    Integer cached = textures.get(id);
    if (cached != null) return cached;
    BufferedImage image = ImageIO.read(CosmeticLayer.textureFile(id));
    ByteBuffer pixels = ByteBuffer.allocateDirect(image.getWidth() * image.getHeight() * 4);
    for (int y = 0; y < image.getHeight(); y++) for (int x = 0; x < image.getWidth(); x++) {
      int p = image.getRGB(x, y); pixels.put((byte)(p >> 16)).put((byte)(p >> 8)).put((byte)p).put((byte)(p >> 24));
    }
    pixels.flip();
    int tex = (Integer) gl("glGenTextures");
    gl("glBindTexture", 3553, tex);
    gl("glTexParameteri", 3553, 10241, 9728); gl("glTexParameteri", 3553, 10240, 9728);
    gl("glTexImage2D", 3553, 0, 6408, image.getWidth(), image.getHeight(), 0, 6408, 5121, pixels);
    textures.put(id, tex); return tex;
  }

  static void draw(Object layer, Object player, List<CosmeticLayer.Mesh> meshes, float scale) throws Exception {
    if (gl == null) gl = Class.forName("org.lwjgl.opengl.GL11", false, layer.getClass().getClassLoader());
    if (!shadersChecked) {
      shadersChecked = true;
      for (String name : new String[] {"net.optifine.shaders.Shaders", "shadersmod.client.Shaders"}) {
        try {
          Class<?> shader = Class.forName(name, false, layer.getClass().getClassLoader());
          beginEyes = shader.getMethod("beginSpiderEyes"); endEyes = shader.getMethod("endSpiderEyes"); break;
        } catch (ClassNotFoundException | NoSuchMethodException ignored) { }
      }
    }
    Object model;
    try { model = CosmeticLayer.method(layer.getClass(), "renderLayer.getParentModel", "getParentModel").invoke(layer); }
    catch (NoSuchMethodException old) {
      Field parent = layer.getClass().getDeclaredField(PartyBridge.setting("capeLayer.renderer", "field_177167_a")); parent.setAccessible(true);
      Object renderer = parent.get(layer);
      model = CosmeticLayer.method(renderer.getClass(), "renderer.getModel", "getMainModel").invoke(renderer);
    }
    Object head = equipment(player, true), chest = equipment(player, false);
    boolean helmet = head != null && !empty(head), elytra = chest != null && String.valueOf(chest).toLowerCase(java.util.Locale.ROOT).contains("elytra");
    float time = (System.nanoTime() % 3_600_000_000_000L) / 1e9f;
    // Raw GL is deliberately scoped to an attribute snapshot: Minecraft's
    // state cache and the actual GL state agree again before returning.
    gl("glPushAttrib", 0xFFFFF);
    try {
      for (CosmeticLayer.Mesh mesh : meshes) {
        if ("head".equals(mesh.slot) ? helmet : "back".equals(mesh.slot) && elytra) continue;
        gl("glPushMatrix");
        try {
          // a pet: by the player as a whole, not on a part of it
          if (!"root".equals(mesh.bone)) {
            Object part = CosmeticLayer.field(model.getClass(), "head".equals(mesh.bone) ? "humanoidModel.head" : "humanoidModel.body", "head".equals(mesh.bone) ? "bipedHead" : "bipedBody").get(model);
            CosmeticLayer.method(part.getClass(), "modelPart.postRender", "postRender", float.class).invoke(part, scale);
          }
          gl("glEnable", 3553); gl("glEnable", 3008); gl("glColor4f", 1f, 1f, 1f, 1f);
          gl("glBindTexture", 3553, texture(mesh.id));
          emit(mesh, false, time);
          if (mesh.hasOutline) {
            gl("glPushAttrib", 0xFFFFF);
            boolean entered = false;
            try {
              if (beginEyes != null) { beginEyes.invoke(null); entered = true; }
              gl("glDisable", 2896); // no directional lighting
              gl("glEnable", 2884); gl("glCullFace", 1029);
              Class<?> gl13 = Class.forName("org.lwjgl.opengl.GL13", false, layer.getClass().getClassLoader());
              gl13.getMethod("glMultiTexCoord2f", int.class, float.class, float.class).invoke(null, 33985, 240f, 240f);
              gl("glColor4f", 1f, 1f, 1f, 1f);
              emit(mesh, true, time);
            } finally {
              if (entered) endEyes.invoke(null);
              gl("glPopAttrib");
            }
          }
        } finally { gl("glPopMatrix"); }
      }
    } finally { gl("glPopAttrib"); }
  }

  private static Object equipment(Object p, boolean head) throws Exception {
    try { return CosmeticLayer.equipment(p, head); }
    catch (ClassNotFoundException | NoSuchMethodException e) {
      return CosmeticLayer.method(p.getClass(), "player.getCurrentArmor", "getCurrentArmor", int.class).invoke(p, head ? 3 : 2);
    }
  }
  private static boolean empty(Object p) throws Exception {
    try { return CosmeticLayer.empty(p); } catch (NoSuchMethodException old) { return false; }
  }
  private static void emit(CosmeticLayer.Mesh mesh, boolean outline, float time) throws Exception {
    float[][] rotations = new float[mesh.parts.size()][];
    for (int i = 0; i < rotations.length; i++) rotations[i] = CosmeticLayer.partRotation(mesh.parts.get(i), time);
    gl("glBegin", 7);
    try {
      for (int f = 0; f < mesh.faceCount; f++) {
        if (mesh.outline[f] != outline) continue;
        int o = f * 24, pi = (int) mesh.faces[o];
        CosmeticLayer.Part p = pi >= 0 && pi < rotations.length ? mesh.parts.get(pi) : null;
        float[] r = p == null ? null : rotations[pi], n = {mesh.faces[o+1],mesh.faces[o+2],mesh.faces[o+3]};
        if (r != null) CosmeticLayer.turn(r,n);
        gl("glNormal3f", n[0], n[1], n[2]);
        for (int k=0;k<4;k++) {
          int q=o+4+k*5;float[] v={mesh.faces[q],mesh.faces[q+1],mesh.faces[q+2]};
          if (r != null) {v[0]-=p.px;v[1]-=p.py;v[2]-=p.pz;CosmeticLayer.turn(r,v);v[0]+=p.px;v[1]+=p.py;v[2]+=p.pz;}
          gl("glTexCoord2f",mesh.faces[q+3],mesh.faces[q+4]);gl("glVertex3f",v[0],v[1],v[2]);
        }
      }
    } finally {gl("glEnd");}
  }
}
