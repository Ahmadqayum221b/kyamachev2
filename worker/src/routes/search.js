/**
 * /search route
 * GET /search?q=term&labels=tag1,tag2&limit=20
 */

import { makeSupabase } from '../lib/supabase.js';
import { getRawToken }  from '../lib/auth.js';
import { json } from '../lib/response.js';


export async function handleSearch(request, env, ctx, url, user) {
  if (request.method !== 'GET')
    return json({ error: 'Method not allowed' }, 405, env);

  const q      = url.searchParams.get('q')?.trim() ?? '';
  const labels = url.searchParams.get('labels')
    ? url.searchParams.get('labels').split(',').map(l => l.trim()).filter(Boolean)
    : [];
  const limit  = Math.min(Number(url.searchParams.get('limit') ?? 20), 100);

  if (!q && labels.length === 0)
    return json({ error: 'Provide at least one of: q, labels' }, 400, env);

  const db = makeSupabase(env);
  // FIX (bug): use getRawToken() helper
  const userToken = getRawToken(request);

  const results = await db.search('entries', q, labels, userToken);

  return json({
    query:   q,
    labels,
    count:   results.length,
    results: results.slice(0, limit),
  }, 200, env);
}
