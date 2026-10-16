package mclauncher.agent;

import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.util.function.Supplier;

/** Refresh memoized PlayerInfo suppliers on the render thread after discovery. */
final class SkinRefresh {
  private static long applied = -1;
  private static boolean warned;
  static void tick(Object mc, long revision) {
    if (revision == applied) return;
    try {
      Object connection = PartyBridge.method(mc.getClass(), "client.getConnection", "getConnection", 0).invoke(mc);
      if (connection == null) return;
      Object manager = PartyBridge.method(mc.getClass(), "client.getSkinManager", "getSkinManager", 0).invoke(mc);
      Field cacheField = field(manager.getClass(), PartyBridge.setting("skinManager.skinCache", "skinCache"));
      Object cache = cacheField.get(manager);
      Class<?> cacheApi = mc.getClass().getClassLoader().loadClass("com.google.common.cache.Cache");
      cacheApi.getMethod("invalidateAll").invoke(cache);
      Object players = PartyBridge.method(connection.getClass(), "connection.getOnlinePlayers", "getOnlinePlayers", 0).invoke(connection);
      for (Object info : (Iterable<?>) players) {
        Object profile = PartyBridge.method(info.getClass(), "info.getProfile", "getProfile", 0).invoke(info);
        // Mojang renamed this supplier across releases; select by type, not position.
        Field lookup = null;
        for (Field f : info.getClass().getDeclaredFields()) if (Supplier.class.isAssignableFrom(f.getType())) { lookup = f; break; }
        if (lookup == null) continue;
        Method create = null;
        for (Method m : info.getClass().getDeclaredMethods()) {
          if (java.lang.reflect.Modifier.isStatic(m.getModifiers()) && Supplier.class.isAssignableFrom(m.getReturnType())
              && m.getParameterTypes().length == 1 && m.getParameterTypes()[0].isInstance(profile)) { create = m; break; }
        }
        if (create == null) continue;
        create.setAccessible(true); lookup.setAccessible(true);
        lookup.set(info, create.invoke(null, profile));
      }
      applied = revision;
    } catch (Throwable error) {
      applied = revision;
      if (!warned) { warned = true; System.out.println("[MC Launcher] Live skin refresh unavailable for this version; rejoin after changing skins: " + error); }
    }
  }
  private static Field field(Class<?> type, String name) throws Exception {
    Field f = type.getDeclaredField(name); f.setAccessible(true); return f;
  }
}
