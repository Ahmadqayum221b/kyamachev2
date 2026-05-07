/**
 * Cloudflare KV cache helpers
 * KV = fast read cache only; Supabase is source of truth
 */

const PREFIX   = 'entry:';
const LIST_KEY = 'entries:recent';

export async function kvGet(kv, id) {
  const raw = await kv.get(`${PREFIX}${id}`);
  return raw ? JSON.parse(raw) : null;
}

export async function kvSet(kv, entry, ttlSeconds = 3600) {
  await kv.put(`${PREFIX}${entry.id}`, JSON.stringify(entry), {
    expirationTtl: ttlSeconds,
  });
}

export async function kvDelete(kv, id) {
  await kv.delete(`${PREFIX}${id}`);
}

/** Cache a list of recent entries */
export async function kvSetList(kv, entries, ttlSeconds = 300) {
  await kv.put(LIST_KEY, JSON.stringify(entries), {
    expirationTtl: ttlSeconds,
  });
}

export async function kvGetList(kv) {
  const raw = await kv.get(LIST_KEY);
  return raw ? JSON.parse(raw) : null;
}

export async function kvInvalidateList(kv) {
  await kv.delete(LIST_KEY);
}
