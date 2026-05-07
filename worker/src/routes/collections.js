/**
 * /collections route
 * GET    /collections     → list collections
 * POST   /collections     → create collection
 * DELETE /collections/:id → delete collection
 */

import { makeSupabase } from '../lib/supabase.js';
import { getRawToken }  from '../lib/auth.js';
import { json } from '../lib/response.js';

function extractId(url) {
  const parts = url.pathname.split('/');
  return parts[2] || null;
}

export async function handleCollections(request, env, ctx, url, user) {
  const db = makeSupabase(env);
  const id = extractId(url);
  const userToken = getRawToken(request);

  // ── GET /collections ─────────────────────────────────────────────────────
  if (request.method === 'GET') {
    const params = { order: 'name.asc' };
    const collections = await db.select('collections', params, userToken);
    return json(collections, 200, env);
  }

  // ── POST /collections ────────────────────────────────────────────────────
  if (request.method === 'POST') {
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: 'Invalid JSON body' }, 400, env);
    }

    const { name, sharing_scope = 'private', family_id } = body;
    if (!name) return json({ error: '`name` is required' }, 400, env);

    const collection = await db.insert('collections', {
      name,
      sharing_scope,
      family_id: family_id ?? null,
      user_id:   user.sub,
    }, userToken);

    return json(collection, 201, env);
  }

  // ── DELETE /collections/:id ──────────────────────────────────────────────
  if (request.method === 'DELETE' && id) {
    await db.delete('collections', id, userToken);
    return json({ deleted: true, id }, 200, env);
  }

  return json({ error: 'Method not allowed' }, 405, env);
}
