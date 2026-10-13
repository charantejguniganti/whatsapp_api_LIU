/**
 * In-memory store implementation.
 *
 * Satisfies the IStore interface for development and testing.
 *
 * LIMITATIONS:
 * - All data is lost on process restart
 * - Not suitable for production multi-instance deployments
 * - TTL is checked lazily at read time (no background cleanup)
 * - Memory usage grows unboundedly if keys are never deleted
 *
 * Replace with Redis or PostgreSQL adapter for production.
 */

/**
 * Creates a new in-memory store instance.
 * @returns {import('./interface.js').IStore}
 */
export function createMemoryStore() {
  /** @type {Map<string, {value: any, expiresAt: number|null}>} */
  const store = new Map();

  return {
    /**
     * Retrieve a value. Returns null if not found or expired.
     * @param {string} key
     * @returns {Promise<any|null>}
     */
    async get(key) {
      const entry = store.get(key);
      if (!entry) return null;
      if (entry.expiresAt !== null && Date.now() > entry.expiresAt) {
        store.delete(key);
        return null;
      }
      return entry.value;
    },

    /**
     * Store a value with optional TTL.
     * @param {string} key
     * @param {any} value
     * @param {number} [ttlMs]  - Time to live in milliseconds
     */
    async set(key, value, ttlMs) {
      store.set(key, {
        value,
        expiresAt: ttlMs != null ? Date.now() + ttlMs : null,
      });
    },

    /**
     * Delete a key.
     * @param {string} key
     */
    async delete(key) {
      store.delete(key);
    },

    /**
     * List all keys matching a prefix.
     * @param {string} prefix
     * @returns {Promise<string[]>}
     */
    async keys(prefix) {
      const result = [];
      for (const key of store.keys()) {
        if (key.startsWith(prefix)) {
          // Lazily evict expired entries
          const entry = store.get(key);
          if (entry.expiresAt !== null && Date.now() > entry.expiresAt) {
            store.delete(key);
          } else {
            result.push(key);
          }
        }
      }
      return result;
    },

    /**
     * Flush all entries (useful for testing).
     */
    flush() {
      store.clear();
    },

    /**
     * Current size (for diagnostics).
     */
    get size() {
      return store.size;
    },
  };
}
