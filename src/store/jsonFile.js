/**
 * JSON-file store — development fallback when DATABASE_URL is absent.
 *
 * Stores all key-value pairs in a single JSON file on disk.
 * TTL is checked lazily at read time (no background cleanup).
 *
 * NOT suitable for production or concurrent processes.
 * Survives server restarts (unlike the in-memory store).
 */
import fs from 'fs';
import path from 'path';
import logger from '../logger.js';

/**
 * @param {string} [filePath] - Absolute path to the JSON file.
 *   Defaults to <project_root>/data/store.json
 * @returns {import('./interface.js').IStore}
 */
export function createJsonFileStore(filePath) {
  const storePath = filePath ?? path.resolve(process.cwd(), 'data', 'store.json');
  const storeDir = path.dirname(storePath);

  // Ensure directory exists
  if (!fs.existsSync(storeDir)) {
    fs.mkdirSync(storeDir, { recursive: true });
  }

  /** @returns {Record<string, {value: any, expiresAt: number|null}>} */
  function load() {
    if (!fs.existsSync(storePath)) return {};
    try {
      return JSON.parse(fs.readFileSync(storePath, 'utf8'));
    } catch {
      logger.warn({ storePath }, 'JSON store file corrupt — starting fresh');
      return {};
    }
  }

  function save(data) {
    fs.writeFileSync(storePath, JSON.stringify(data, null, 2), 'utf8');
  }

  return {
    async get(key) {
      const data = load();
      const entry = data[key];
      if (!entry) return null;
      if (entry.expiresAt !== null && Date.now() > entry.expiresAt) {
        delete data[key];
        save(data);
        return null;
      }
      return entry.value;
    },

    async set(key, value, ttlMs) {
      const data = load();
      data[key] = {
        value,
        expiresAt: ttlMs != null ? Date.now() + ttlMs : null,
      };
      save(data);
    },

    async delete(key) {
      const data = load();
      delete data[key];
      save(data);
    },

    async keys(prefix) {
      const data = load();
      const now = Date.now();
      return Object.keys(data).filter((k) => {
        if (!k.startsWith(prefix)) return false;
        const entry = data[k];
        if (entry.expiresAt !== null && now > entry.expiresAt) return false;
        return true;
      });
    },
  };
}
