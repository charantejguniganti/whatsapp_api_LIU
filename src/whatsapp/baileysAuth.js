/**
 * PostgreSQL Auth State for Baileys
 *
 * Stores multi-device credentials directly in the Neon PostgreSQL kv_store table.
 * This guarantees sessions survive Render restarts and dyno cycling.
 */
import { proto } from '@whiskeysockets/baileys';
import { BufferJSON, initAuthCreds } from '@whiskeysockets/baileys';

export async function usePostgresAuthState(store, sessionPrefix = 'baileys_auth:') {
  const writeData = async (data, key) => {
    try {
      const serialized = JSON.stringify(data, BufferJSON.replacer);
      await store.set(`${sessionPrefix}${key}`, serialized);
    } catch (error) {
      console.error('Failed to write auth data to store:', error);
    }
  };

  const readData = async (key) => {
    try {
      const raw = await store.get(`${sessionPrefix}${key}`);
      if (!raw) return null;
      return JSON.parse(raw, BufferJSON.reviver);
    } catch (error) {
      console.error('Failed to read auth data from store:', error);
      return null;
    }
  };

  const removeData = async (key) => {
    try {
      await store.delete(`${sessionPrefix}${key}`);
    } catch (error) {
      console.error('Failed to delete auth data from store:', error);
    }
  };

  const creds = (await readData('creds')) || initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {};
          await Promise.all(
            ids.map(async (id) => {
              let value = await readData(`${type}-${id}`);
              if (type === 'app-state-sync-key' && value) {
                value = proto.Message.AppStateSyncKeyData.fromObject(value);
              }
              data[id] = value;
            })
          );
          return data;
        },
        set: async (data) => {
          const tasks = [];
          for (const category in data) {
            for (const id in data[category]) {
              const value = data[category][id];
              const key = `${category}-${id}`;
              tasks.push(value ? writeData(value, key) : removeData(key));
            }
          }
          await Promise.all(tasks);
        },
      },
    },
    saveCreds: () => writeData(creds, 'creds'),
    clearAuth: async () => {
      const keys = await store.keys(sessionPrefix);
      for (const k of keys) {
        await store.delete(k);
      }
    }
  };
}
