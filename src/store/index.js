/**
 * Store factory.
 * Selects the storage backend based on configuration:
 *
 *   DATABASE_URL set  →  PostgreSQL (Neon) — production
 *   NODE_ENV=test     →  In-memory — tests only, no side effects
 *   Otherwise         →  JSON file (data/store.json) — dev, survives restarts
 */
import config from '../config/index.js';
import { createMemoryStore } from './memory.js';

let _storeInstance = null;

/**
 * Get the singleton store instance.
 * Initialises lazily on first call.
 * @returns {Promise<import('./interface.js').IStore>}
 */
export async function getStore() {
  if (_storeInstance) return _storeInstance;

  if (config.NODE_ENV === 'test') {
    _storeInstance = createMemoryStore();
    return _storeInstance;
  }

  if (config.DATABASE_URL) {
    const { createPostgresStore } = await import('./postgres.js');
    _storeInstance = await createPostgresStore(config.DATABASE_URL);
    return _storeInstance;
  }

  // Local dev fallback — JSON file, persists across restarts
  const { createJsonFileStore } = await import('./jsonFile.js');
  _storeInstance = createJsonFileStore();
  return _storeInstance;
}

/**
 * Reset the store singleton (for testing only).
 */
export function resetStore() {
  _storeInstance = null;
}
