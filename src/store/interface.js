/**
 * IStore interface definition (JSDoc-based contract).
 *
 * Implement this interface when adding a new storage backend
 * (e.g., PostgreSQL, Redis, DynamoDB).
 *
 * LIMITATIONS of the current in-memory implementation:
 * - Data is lost when the process restarts
 * - Not suitable for multi-instance deployments
 * - No persistence, no backups
 * - TTL is approximate (checked at read time)
 *
 * @typedef {Object} IStore
 * @property {(key: string) => Promise<any|null>} get  - Retrieve a value by key
 * @property {(key: string, value: any, ttlMs?: number) => Promise<void>} set - Store a value
 * @property {(key: string) => Promise<void>} delete  - Delete a value by key
 * @property {(prefix: string) => Promise<string[]>} keys - List keys matching a prefix
 */

export {};
