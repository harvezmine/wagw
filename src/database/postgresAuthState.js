import { initAuthCreds, BufferJSON, proto } from '@whiskeysockets/baileys';
import { db as defaultDb } from './db.js';

const serialize = (value) => JSON.stringify(value, BufferJSON.replacer);
const deserialize = (value) => JSON.parse(JSON.stringify(value), BufferJSON.reviver);

const UPSERT_SQL = `
  INSERT INTO baileys_auth_store (session_id, data_type, data_id, value, updated_at)
  SELECT $1, t.data_type, t.data_id, t.value::jsonb, NOW()
  FROM unnest($2::text[], $3::text[], $4::text[]) AS t(data_type, data_id, value)
  ON CONFLICT (session_id, data_type, data_id)
  DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`;

const DELETE_SQL = `
  DELETE FROM baileys_auth_store a
  USING unnest($2::text[], $3::text[]) AS t(data_type, data_id)
  WHERE a.session_id = $1 AND a.data_type = t.data_type AND a.data_id = t.data_id`;

/**
 * PostgreSQL Auth State Adapter for Baileys.
 * Database errors are thrown, never swallowed: returning "no data" on a failed read would make
 * Baileys generate fresh credentials, and a silently failed key write desynchronises the Signal
 * sessions (Bad MAC). Key writes are applied atomically in one transaction.
 */
export async function usePostgresAuthState(sessionId, db = defaultDb) {
  const credsRes = await db.query(
    `SELECT value FROM baileys_auth_store WHERE session_id = $1 AND data_type = 'creds' AND data_id = 'creds'`,
    [sessionId]
  );
  const creds = credsRes.rows[0]?.value ? deserialize(credsRes.rows[0].value) : initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {};
          const res = await db.query(
            `SELECT data_id, value FROM baileys_auth_store
             WHERE session_id = $1 AND data_type = $2 AND data_id = ANY($3::text[])`,
            [sessionId, type, ids]
          );
          for (const row of res.rows) {
            if (!row.value) continue;
            let value = deserialize(row.value);
            if (type === 'app-state-sync-key') {
              value = proto.Message.AppStateSyncKeyData.fromObject(value);
            }
            data[row.data_id] = value;
          }
          return data;
        },
        set: async (data) => {
          const upserts = [];
          const deletes = [];
          for (const type in data) {
            for (const id in data[type]) {
              const value = data[type][id];
              if (value) {
                upserts.push([type, id, serialize(value)]);
              } else {
                deletes.push([type, id]);
              }
            }
          }
          if (!upserts.length && !deletes.length) return;

          // Stable row order keeps concurrent transactions from deadlocking on each other
          const byKey = (a, b) => (a[0] + a[1] < b[0] + b[1] ? -1 : 1);
          upserts.sort(byKey);
          deletes.sort(byKey);

          await db.withTransaction(async (client) => {
            if (upserts.length) {
              await client.query(UPSERT_SQL, [
                sessionId,
                upserts.map(([type]) => type),
                upserts.map(([, id]) => id),
                upserts.map(([, , value]) => value)
              ]);
            }
            if (deletes.length) {
              await client.query(DELETE_SQL, [
                sessionId,
                deletes.map(([type]) => type),
                deletes.map(([, id]) => id)
              ]);
            }
          });
        }
      }
    },
    saveCreds: async () => {
      await db.query(UPSERT_SQL, [sessionId, ['creds'], ['creds'], [serialize(creds)]]);
    },
    clearState: () => clearAuthState(sessionId, db)
  };
}

/**
 * Deletes every stored credential and Signal key of a session.
 */
export async function clearAuthState(sessionId, db = defaultDb) {
  await db.query(`DELETE FROM baileys_auth_store WHERE session_id = $1`, [sessionId]);
}
