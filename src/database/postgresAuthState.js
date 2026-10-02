import { initAuthCreds, BufferJSON, proto } from '@whiskeysockets/baileys';
import { query } from './db.js';

/**
 * PostgreSQL Auth State Adapter for Baileys
 * Provides persistent authentication storage directly in PostgreSQL.
 * Supports multi-device sessions and survivable restarts in containerized environments.
 */
export async function usePostgresAuthState(sessionId) {
  const writeData = async (type, id, value) => {
    try {
      const jsonValue = JSON.stringify(value, BufferJSON.replacer);
      await query(
        `INSERT INTO baileys_auth_store (session_id, data_type, data_id, value, updated_at)
         VALUES ($1, $2, $3, $4::jsonb, NOW())
         ON CONFLICT (session_id, data_type, data_id)
         DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
        [sessionId, type, id, jsonValue]
      );
    } catch (error) {
      console.error(`[PostgresAuth] Error writing data (${type}/${id}):`, error.message);
    }
  };

  const readData = async (type, id) => {
    try {
      const res = await query(
        `SELECT value FROM baileys_auth_store WHERE session_id = $1 AND data_type = $2 AND data_id = $3`,
        [sessionId, type, id]
      );
      if (res.rows.length === 0 || !res.rows[0].value) {
        return null;
      }
      return JSON.parse(JSON.stringify(res.rows[0].value), BufferJSON.reviver);
    } catch (error) {
      console.error(`[PostgresAuth] Error reading data (${type}/${id}):`, error.message);
      return null;
    }
  };

  const removeData = async (type, id) => {
    try {
      await query(
        `DELETE FROM baileys_auth_store WHERE session_id = $1 AND data_type = $2 AND data_id = $3`,
        [sessionId, type, id]
      );
    } catch (error) {
      console.error(`[PostgresAuth] Error removing data (${type}/${id}):`, error.message);
    }
  };

  // Load or initialize creds
  const creds = (await readData('creds', 'creds')) || initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {};
          try {
            const res = await query(
              `SELECT data_id, value FROM baileys_auth_store
               WHERE session_id = $1 AND data_type = $2 AND data_id = ANY($3)`,
              [sessionId, type, ids]
            );

            for (const row of res.rows) {
              if (row.value) {
                let value = JSON.parse(JSON.stringify(row.value), BufferJSON.reviver);
                if (type === 'app-state-sync-key' && value) {
                  value = proto.Message.AppStateSyncKeyData.fromObject(value);
                }
                data[row.data_id] = value;
              }
            }
          } catch (error) {
            console.error(`[PostgresAuth] Error getting keys (${type}):`, error.message);
          }
          return data;
        },
        set: async (data) => {
          const tasks = [];
          for (const category in data) {
            for (const id in data[category]) {
              const value = data[category][id];
              if (value) {
                tasks.push(writeData(category, id, value));
              } else {
                tasks.push(removeData(category, id));
              }
            }
          }
          await Promise.all(tasks);
        }
      }
    },
    saveCreds: async () => {
      await writeData('creds', 'creds', creds);
    },
    clearState: async () => {
      await query(`DELETE FROM baileys_auth_store WHERE session_id = $1`, [sessionId]);
    }
  };
}
