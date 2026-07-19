export function createTimedCache(options = {}) {
  const ttlMs = Math.max(Number(options.ttlMs) || 0, 0);
  const entries = new Map();

  return {
    async get(key, loader, request = {}) {
      const now = Date.now();
      const existing = entries.get(key);
      if (!request.force && existing?.promise) return existing.promise;
      if (!request.force && existing && now - existing.loadedAt < ttlMs) return existing.value;

      const promise = Promise.resolve().then(loader);
      entries.set(key, { ...existing, promise });
      try {
        const value = await promise;
        entries.set(key, { value, loadedAt: Date.now(), promise: null });
        return value;
      } catch (error) {
        entries.delete(key);
        throw error;
      }
    },
    clear() {
      entries.clear();
    }
  };
}
