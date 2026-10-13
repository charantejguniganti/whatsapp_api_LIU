/**
 * PostgreSQL store adapter (Neon-compatible).
 *
 * Implements the IStore interface backed by a single key-value table.
 * Compatible with Neon serverless PostgreSQL — uses pg (node-postgres).
 *
 * Table schema (auto-created on first connection):
 *   CREATE TABLE IF NOT EXISTS kv_store (
 *     key        TEXT PRIMARY KEY,
 *     value      JSONB NOT NULL,
 *     expires_at TIMESTAMPTZ
 *   );
 *
 * Usage: set DATABASE_URL in .env to a Neon connection string.
 */
import pg from 'pg';
import logger from '../logger.js';

const { Pool } = pg;

const INIT_SQL = `
  CREATE TABLE IF NOT EXISTS kv_store (
    key        TEXT PRIMARY KEY,
    value      JSONB NOT NULL,
    expires_at TIMESTAMPTZ
  );
  CREATE INDEX IF NOT EXISTS kv_store_expires_at ON kv_store (expires_at)
    WHERE expires_at IS NOT NULL;
`;

/**
 * Create a PostgreSQL-backed store.
 * @param {string} connectionString
 * @returns {Promise<import('./interface.js').IStore>}
 */
export async function createPostgresStore(connectionString) {
  const pool = new Pool({
    connectionString,
    ssl: { rejectUnauthorized: false }, // required for Neon
    max: 5,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  });

  // Initialise schema
  try {
    await pool.query(INIT_SQL);
    logger.info('PostgreSQL store initialised');
  } catch (err) {
    logger.error({ err }, 'PostgreSQL store init failed');
    throw err;
  }

  return {
    async get(key) {
      const { rows } = await pool.query(
        `SELECT value FROM kv_store
         WHERE key = $1
           AND (expires_at IS NULL OR expires_at > NOW())`,
        [key]
      );
      if (rows.length === 0) return null;
      return rows[0].value;
    },

    async set(key, value, ttlMs) {
      const expiresAt = ttlMs != null
        ? new Date(Date.now() + ttlMs).toISOString()
        : null;
      await pool.query(
        `INSERT INTO kv_store (key, value, expires_at)
         VALUES ($1, $2::jsonb, $3)
         ON CONFLICT (key) DO UPDATE
           SET value = EXCLUDED.value,
               expires_at = EXCLUDED.expires_at`,
        [key, JSON.stringify(value), expiresAt]
      );
    },

    async delete(key) {
      await pool.query('DELETE FROM kv_store WHERE key = $1', [key]);
    },

    async keys(prefix) {
      const { rows } = await pool.query(
        `SELECT key FROM kv_store
         WHERE key LIKE $1
           AND (expires_at IS NULL OR expires_at > NOW())
         ORDER BY key`,
        [`${prefix}%`]
      );
      return rows.map((r) => r.key);
    },

    /** Gracefully close the pool. */
    async close() {
      await pool.end();
    },
  };
}
