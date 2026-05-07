/**
 * /entries route
 * GET    /entries     → list entries (Supabase, filtered)
 * GET    /entries/:id → single entry (Supabase, RLS-safe)
 * POST   /entries     → create entry, fire async AI classification
 * DELETE /entries/:id → soft-delete (status = trashed)
 */

import { makeSupabase } from '../lib/supabase.js';
import { makeB2 }       from '../lib/b2.js';
import { getRawToken }  from '../lib/auth.js';
// FIX: unused KV list helpers removed (kvGetList, kvSetList, kvInvalidateList were
// imported but never called — dead code eliminated)
import { kvGet, kvSet, kvDelete } from '../lib/kv.js';
import { json } from '../lib/response.js';


function extractId(url) {
  const parts = url.pathname.split('/');
  return parts[2] || null;
}

export async function handleEntries(request, env, ctx, url, user) {
  const db = makeSupabase(env);
  const id = extractId(url);
  // FIX (bug): use getRawToken() helper instead of unsafe authHeader.split(' ')[1]
  // which throws a TypeError when the Authorization header is absent.
  const userToken = getRawToken(request);

  // ── GET /entries/:id ─────────────────────────────────────────────────────
  if (request.method === 'GET' && id && id !== 'bulk') {
    const entry = await db.selectOne('entries', id, userToken);
    if (!entry) return json({ error: 'Entry not found' }, 404, env);
    return json(entry, 200, env);
  }

  // ── GET /entries ──────────────────────────────────────────────────────────
  if (request.method === 'GET') {
    const limit  = Math.min(Number(url.searchParams.get('limit')  ?? 20), 100);
    const offset = Number(url.searchParams.get('offset') ?? 0);
    let status = url.searchParams.get('status') ?? 'active';
    if (!status.includes('.')) status = `eq.${status}`;

    // Update default order to respect pinning: is_pinned DESC, created_at DESC
    const params = { order: 'is_pinned.desc,created_at.desc', limit, offset, status };

    const ALLOWED_FILTERS = ['is_starred', 'is_pinned', 'content_type', 'ai_labels', 'source', 'family_id', 'collection_id'];
    for (const [key, val] of url.searchParams.entries()) {
      if (ALLOWED_FILTERS.includes(key)) {
        if (key === 'is_pinned' || key === 'is_starred') {
          params[key] = `eq.${val}`;
        } else {
          params[key] = val;
        }
      }
    }

    const entries = await db.select('entries', params, userToken);
    return json(entries, 200, env);
  }

  // ── POST /entries ─────────────────────────────────────────────────────────
  if (request.method === 'POST' && !id) {
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: 'Invalid JSON body' }, 400, env);
    }

    const { content, content_type = 'text', source, file_url, file_key, family_id, sharing_scope, collection_id } = body;
    if (!content) return json({ error: '`content` is required' }, 400, env);

    const entry = await db.insert('entries', {
      content,
      content_type,
      source:        source        ?? null,
      file_url:      file_url      ?? null,
      file_key:      file_key      ?? null,
      family_id:     family_id     ?? null,
      collection_id: collection_id ?? null,
      sharing_scope: sharing_scope ?? 'family',
      status:        'active',
      ai_status:     'pending',
    }, userToken);

    ctx.waitUntil(triggerAiClassification(entry.id, env));

    return json(entry, 201, env);
  }

  // ── POST /entries/bulk ────────────────────────────────────────────────────
  if (request.method === 'POST' && id === 'bulk') {
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: 'Invalid JSON body' }, 400, env);
    }

    const { action, ids, data } = body;
    if (!action || !ids || !Array.isArray(ids) || ids.length === 0) {
      return json({ error: '`action` and `ids` (array) are required' }, 400, env);
    }

    // Use id=in.(...) for bulk operations
    const filter = `id=in.(${ids.map(i => i.replace(/[^a-f0-9-]/g, '')).join(',')})`;
    
    if (action === 'delete') {
      await db.patch('entries', filter, { status: 'trashed', trashed_at: new Date().toISOString() }, userToken);
      return json({ success: true, count: ids.length }, 200, env);
    }

    if (action === 'move') {
      if (!data?.collection_id) return json({ error: '`collection_id` required for move' }, 400, env);
      await db.patch('entries', filter, { collection_id: data.collection_id }, userToken);
      return json({ success: true, count: ids.length }, 200, env);
    }

    if (action === 'tag') {
      if (!data?.labels || !Array.isArray(data.labels)) return json({ error: '`labels` array required for tagging' }, 400, env);
      // This is trickier as it needs to append to existing labels or overwrite.
      // PostgREST doesn't support array appending easily in PATCH. 
      // For now, we'll overwrite or let AI handle it.
      await db.patch('entries', filter, { ai_labels: data.labels }, userToken);
      return json({ success: true, count: ids.length }, 200, env);
    }

    // FIX: Add 'pin' bulk action — previously PWA sent action:'update' which was
    // unrecognised here, causing bulk pin to silently fail.
    if (action === 'pin') {
      const is_pinned = data?.is_pinned !== false; // default to true (pin), pass false to unpin
      await db.patch('entries', filter, { is_pinned }, userToken);
      return json({ success: true, count: ids.length }, 200, env);
    }

    return json({ error: 'Unknown bulk action' }, 400, env);
  }

  // ── PATCH /entries/:id ────────────────────────────────────────────────────
  if (request.method === 'PATCH' && id) {
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: 'Invalid JSON body' }, 400, env);
    }

    const ALLOWED_UPDATES = ['content', 'is_starred', 'is_pinned', 'collection_id', 'sharing_scope', 'status'];
    const updateData = {};
    for (const key of ALLOWED_UPDATES) {
      if (key in body) updateData[key] = body[key];
    }

    if (Object.keys(updateData).length === 0) {
      return json({ error: 'No valid fields to update' }, 400, env);
    }

    const entry = await db.update('entries', id, updateData, userToken);
    if (!entry) return json({ error: 'Entry not found or unauthorized' }, 404, env);

    // If content changed, re-trigger AI classification
    if (updateData.content) {
      ctx.waitUntil(triggerAiClassification(entry.id, env));
    }

    return json(entry, 200, env);
  }

  // ── DELETE /entries/:id ───────────────────────────────────────────────────
  if (request.method === 'DELETE' && id) {
    await db.update('entries', id, {
      status:     'trashed',
      trashed_at: new Date().toISOString(),
    }, userToken);
    return json({ trashed: true, id }, 200, env);
  }

  return json({ error: 'Method not allowed' }, 405, env);
}

/** Fire-and-forget: call /process internally with the shared secret */
async function triggerAiClassification(entryId, env) {
  try {
    // FIX (security): include X-Internal-Secret so the /process route accepts it.
    await fetch(`${env.WORKER_SELF_URL ?? 'http://localhost'}/process/${entryId}`, {
      method:  'POST',
      headers: {
        'Content-Type':      'application/json',
        'X-Internal-Secret': env.PROCESS_SECRET ?? '',
      },
      body: JSON.stringify({ trigger: 'auto' }),
    });
  } catch (e) {
    console.warn('[entries] async AI trigger failed:', e.message);
  }
}
