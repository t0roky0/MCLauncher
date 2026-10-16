package mclauncher.agent;

import java.lang.reflect.Constructor;
import java.lang.reflect.Method;
import java.nio.charset.StandardCharsets;
import java.lang.ref.WeakReference;
import java.util.ArrayList;
import java.util.Base64;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Samples only entities loaded in this client. No coordinates leave the machine:
 * the launcher gets each player's place relative to our view (right, up, forward)
 * and the surroundings that colour a voice — blocks in between, water, a roof —
 * and, for its event quests, our own position, the server we're on and how many
 * monsters we've beaten (see countKills).
 */
public final class NearbyBridge {
  private static final int ENV_PLAYERS = 12;     // surroundings for the nearest few
  private static final double ENV_RANGE = 48;
  private static final long ENV_MS = 250;
  private static String last = "";
  private static long sent;
  // Surroundings: unsupported here → plain 3D only, never an exception per tick.
  private static boolean envBroken;
  private static long envAt;
  private static int selfWater, selfEnclosed;
  private static final Map<String, int[]> env = new HashMap<String, int[]>(); // id → {blocks between, in water}
  private static final Map<String, Method> calls = new HashMap<String, Method>(); // class#key → method
  private static Constructor<?> blockPos;
  private static final long MIN_GAP_MS = 200;     // at most five samples a second
  // monsters we hit, until they die or are forgotten: id → (entity, when)
  private static final Map<Integer, Object[]> hit = new HashMap<Integer, Object[]>();
  private static final Set<Integer> beaten = new HashSet<Integer>();
  private static int kills;
  private static boolean killsBroken, damageBroken, swingBroken;
  private static Class<?> enemy;
  private static final Map<String, Method> shared = new HashMap<String, Method>(); // key → a base class's method, any subclass

  static void tick(Object mc) {
    String data = "";
    try {
      Object self = PartyBridge.field(mc.getClass(), "client.player", "player").get(mc);
      Object level = PartyBridge.field(mc.getClass(), "client.level", "level").get(mc);
      if (self != null && level != null) {
        double x = number(self, "getX"), y = eye(self), z = number(self, "getZ");
        double yaw = Math.toRadians(number(self, "getYRot"));
        // Minecraft: +X east, +Z south, yaw 0 faces south, 90 faces west.
        double rightX = -Math.cos(yaw), rightZ = -Math.sin(yaw), aheadX = -Math.sin(yaw), aheadZ = Math.cos(yaw);
        long now = System.currentTimeMillis();
        boolean refresh = !envBroken && now - envAt >= ENV_MS;
        if (refresh) {
          envAt = now;
          try {
            selfWater = flag(self, "isUnderWater");
            selfEnclosed = sky(level, x, y, z) ? 0 : 1;
          } catch (Throwable unsupported) { brokenEnv(); }
        }
        Object players = PartyBridge.method(level.getClass(), "level.players", "players", 0).invoke(level);
        List<Object[]> rows = new ArrayList<Object[]>();
        for (Object other : (Iterable<?>) players) {
          if (other == self) continue;
          double ox = number(other, "getX"), oy = eye(other), oz = number(other, "getZ");
          double dx = ox - x, dy = oy - y, dz = oz - z;
          double distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
          if (!Double.isFinite(distance) || distance > 128) continue;
          rows.add(new Object[] {other, distance, dx, dy, dz, ox, oy, oz});
        }
        rows.sort((a, b) -> Double.compare((Double) a[1], (Double) b[1]));
        if (!killsBroken) {
          try { countKills(mc, self, level); } catch (Throwable unsupported) { killsBroken = true; hit.clear(); }
        }
        StringBuilder text = new StringBuilder(identity(self)).append('\t').append(selfWater).append('\t').append(selfEnclosed)
          .append('\t').append(round(number(self, "getX"))).append('\t').append(round(number(self, "getY"))).append('\t').append(round(z))
          .append('\t').append(server(mc)).append('\t').append(killsBroken ? -1 : kills);
        for (int i = 0; i < Math.min(64, rows.size()); i++) {
          Object[] row = rows.get(i);
          double distance = (Double) row[1], dx = (Double) row[2], dy = (Double) row[3], dz = (Double) row[4];
          double horizontal = Math.sqrt(dx * dx + dz * dz);
          double right = dx * rightX + dz * rightZ, ahead = dx * aheadX + dz * aheadZ;
          double pan = horizontal < 0.01 ? 0 : right / horizontal;
          String id = identity(row[0]);
          if (refresh && !envBroken) {
            if (i < ENV_PLAYERS && distance <= ENV_RANGE) {
              try {
                env.put(id, new int[] {between(level, x, y, z, (Double) row[5], (Double) row[6], (Double) row[7]), flag(row[0], "isUnderWater")});
              } catch (Throwable unsupported) { brokenEnv(); }
            } else env.remove(id);
          }
          int[] around = env.get(id);
          text.append('\n').append(id).append('\t').append(distance).append('\t').append(pan)
            .append('\t').append(round(right)).append('\t').append(round(dy)).append('\t').append(round(ahead))
            .append('\t').append(around == null ? 0 : around[0]).append('\t').append(around == null ? 0 : around[1]);
        }
        if (refresh && env.size() > 64) env.clear();
        data = text.toString();
      }
    } catch (Throwable ignored) { /* Unsupported version or unloaded world: fail silent, never full volume. */ }
    long now = System.currentTimeMillis();
    if ((!data.equals(last) && (now - sent >= MIN_GAP_MS || data.isEmpty())) || now - sent >= 1000) {
      last = data; sent = now;
      System.out.println("[MC Launcher] nearby\t" + Base64.getEncoder().encodeToString(data.getBytes(StandardCharsets.UTF_8)));
    }
  }

  // Monsters we beat: ones that die soon after we hurt them, each once. Who
  // hurt a monster is the server's business — the client's own "last hurt
  // mob" stays empty — so two things the client does know:
  //  * the damage the server tells it about (1.19.4+) names its source: a
  //    monster whose last damage came from us (a sword, an arrow, a trident);
  //  * every version: the monster under the crosshair while we swing.
  private static void countKills(Object mc, Object self, Object level) throws Exception {
    if (enemy == null) enemy = Class.forName(PartyBridge.setting("class.enemy", "net.minecraft.world.entity.monster.Enemy"), false, self.getClass().getClassLoader());
    long now = System.currentTimeMillis();
    if (!swingBroken) {
      try {
        if (swinging(self)) {
          Object target = PartyBridge.field(mc.getClass(), "client.crosshairPickEntity", "crosshairPickEntity").get(mc);
          if (target != null && enemy.isInstance(target)) mark(target, now);
        }
      } catch (Throwable unsupported) { swingBroken = true; }
    }
    if (!damageBroken) {
      try {
        for (Object e : (Iterable<?>) shared(level, "level.entitiesForRendering", "entitiesForRendering").invoke(level)) {
          if (!enemy.isInstance(e)) continue;
          Object source = shared(e, "living.getLastDamageSource", "getLastDamageSource").invoke(e);
          if (source != null && shared(source, "damageSource.getEntity", "getEntity").invoke(source) == self) mark(e, now);
        }
      } catch (Throwable unsupported) { damageBroken = true; }
    }
    if (swingBroken && damageBroken) throw new IllegalStateException("no way to tell");
    for (Iterator<Map.Entry<Integer, Object[]>> it = hit.entrySet().iterator(); it.hasNext();) {
      Map.Entry<Integer, Object[]> e = it.next();
      Object mob = ((WeakReference<?>) e.getValue()[0]).get();
      if (mob == null || now - (Long) e.getValue()[1] > 8000) { it.remove(); continue; }
      if (Boolean.TRUE.equals(shared(mob, "living.isDeadOrDying", "isDeadOrDying").invoke(mob))) {
        kills++;
        beaten.add(e.getKey());
        if (beaten.size() > 512) beaten.clear();
        it.remove();
      }
    }
  }

  // Our arm mid-swing: isSwinging() in 26.x, the swinging field before.
  private static boolean swinging(Object self) throws Exception {
    try { return Boolean.TRUE.equals(shared(self, "living.isSwinging", "isSwinging").invoke(self)); }
    catch (NoSuchMethodException older) { return Boolean.TRUE.equals(PartyBridge.field(self.getClass(), "living.swinging", "swinging").get(self)); }
  }

  // A monster we hurt: watched until it dies or 8 s pass since.
  private static void mark(Object mob, long now) throws Exception {
    int id = ((Number) shared(mob, "entity.getId", "getId").invoke(mob)).intValue();
    if (beaten.contains(id)) return;
    Object[] seen = hit.get(id);
    if (seen != null) seen[1] = now;
    else if (hit.size() < 256) hit.put(id, new Object[] {new WeakReference<Object>(mob), now});
  }

  // A no-argument method found once and called on any subclass (zombies,
  // skeletons… all share LivingEntity's): no lookup per kind of monster.
  private static Method shared(Object target, String key, String name) throws Exception {
    Method m = shared.get(key);
    if (m == null || !m.getDeclaringClass().isInstance(target)) {
      m = PartyBridge.method(target.getClass(), key, name, 0);
      m.setAccessible(true);
      shared.put(key, m);
    }
    return m;
  }

  // The server's address, "" in a world of our own.
  private static String server(Object mc) {
    try {
      Object data = PartyBridge.method(mc.getClass(), "client.getCurrentServer", "getCurrentServer", 0).invoke(mc);
      if (data == null) return "";
      return String.valueOf(PartyBridge.field(data.getClass(), "data.ip", "ip").get(data)).replaceAll("[\\t\\r\\n]", "");
    } catch (Throwable unsupported) { return ""; }
  }

  private static void brokenEnv() {
    envBroken = true;
    selfWater = selfEnclosed = 0;
    env.clear();
  }

  private static double round(double v) { return Math.round(v * 100) / 100.0; }

  // Solid blocks on the straight line between two heads, one block a step (at most 9).
  private static int between(Object level, double x, double y, double z, double tx, double ty, double tz) throws Exception {
    double d = Math.sqrt((tx - x) * (tx - x) + (ty - y) * (ty - y) + (tz - z) * (tz - z));
    int count = 0;
    long previous = Long.MIN_VALUE;
    for (double s = 1; s < d - 0.5; s += 1) {
      double t = s / d;
      int bx = (int) Math.floor(x + (tx - x) * t), by = (int) Math.floor(y + (ty - y) * t), bz = (int) Math.floor(z + (tz - z) * t);
      long key = (((long) bx & 0x3FFFFFFL) << 38) | (((long) bz & 0x3FFFFFFL) << 12) | (by & 0xFFFL);
      if (key == previous) continue;
      previous = key;
      if (opaque(level, bx, by, bz) && ++count >= 9) break;
    }
    return count;
  }

  private static Object pos(Object level, int x, int y, int z) throws Exception {
    if (blockPos == null) {
      Class<?> type = Class.forName(PartyBridge.setting("class.blockPos", "net.minecraft.core.BlockPos"), false, level.getClass().getClassLoader());
      blockPos = type.getConstructor(int.class, int.class, int.class);
    }
    return blockPos.newInstance(x, y, z);
  }

  private static boolean opaque(Object level, int x, int y, int z) throws Exception {
    Object state = call(level, "blockGetter.getBlockState", "getBlockState", 1).invoke(level, pos(level, x, y, z));
    return (Boolean) call(state, "blockState.canOcclude", "canOcclude", 0).invoke(state);
  }

  private static boolean sky(Object level, double x, double y, double z) throws Exception {
    Object at = pos(level, (int) Math.floor(x), (int) Math.floor(y), (int) Math.floor(z));
    return (Boolean) call(level, "tintGetter.canSeeSky", "canSeeSky", 1).invoke(level, at);
  }

  // Looked up once per class: these run many times a second.
  private static Method call(Object target, String key, String name, int count) throws Exception {
    Class<?> type = target.getClass();
    String slot = type.getName() + '#' + key;
    Method m = calls.get(slot);
    if (m == null) {
      m = PartyBridge.method(type, key, name, count);
      m.setAccessible(true);
      if (calls.size() > 32) calls.clear();
      calls.put(slot, m);
    }
    return m;
  }

  private static int flag(Object entity, String name) throws Exception {
    return Boolean.TRUE.equals(PartyBridge.method(entity.getClass(), "entity." + name, name, 0).invoke(entity)) ? 1 : 0;
  }

  // Head height when the version has it, else the usual standing eyes.
  private static double eye(Object entity) throws Exception {
    try { return number(entity, "getEyeY"); }
    catch (NoSuchMethodException old) { return number(entity, "getY") + 1.62; }
  }

  private static String identity(Object player) throws Exception {
    Object profile = PartyBridge.method(player.getClass(), "player.getGameProfile", "getGameProfile", 0).invoke(player);
    String name;
    try { name = String.valueOf(profile.getClass().getMethod("name").invoke(profile)); }
    catch (NoSuchMethodException old) { name = String.valueOf(profile.getClass().getMethod("getName").invoke(profile)); }
    Object id = PartyBridge.method(player.getClass(), "entity.getUUID", "getUUID", 0).invoke(player);
    return id.toString().replace("-", "") + "\t" + name.replaceAll("[\\t\\r\\n]", "");
  }

  private static double number(Object entity, String name) throws Exception {
    return ((Number) PartyBridge.method(entity.getClass(), "entity." + name, name, 0).invoke(entity)).doubleValue();
  }
}
