/**
 * Tiny in-memory TTL cache. Replaces Laravel's file cache for ephemeral
 * things (session join codes, Mojang profile cache, rename timestamps).
 */
const store = new Map<string, { value: any; expiresAt: number }>();

export function cacheGet<T = any>(key: string): T | undefined {
  const entry = store.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt < Date.now()) {
    store.delete(key);
    return undefined;
  }
  return entry.value as T;
}

export function cachePut(key: string, value: any, ttlSeconds: number): void {
  if (ttlSeconds <= 0) {
    store.delete(key);
    return;
  }
  store.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
}

export function cacheForget(key: string): void {
  store.delete(key);
}
