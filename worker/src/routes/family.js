/**
 * /family routes
 * GET    /family/members       → list members of current user's family
 * POST   /family/invite        → invite a new member
 * DELETE /family/members/:id   → remove a member (owner/admin only, enforced by RLS)
 */

import { makeSupabase } from '../lib/supabase.js';
import { getRawToken }  from '../lib/auth.js';
import { json } from '../lib/response.js';


export async function handleFamily(request, env, ctx, url, user) {
  const db = makeSupabase(env);
  // FIX (bug): use getRawToken() helper instead of unsafe authHeader.split(' ')[1]
  const userToken = getRawToken(request);

  // ── GET /family/members ──────────────────────────────────────────────────
  if (request.method === 'GET' && url.pathname === '/family/members') {
    const members = await db.select('family_members', { order: 'joined_at.asc' }, userToken);
    return json(members, 200, env);
  }

  // ── POST /family/invite ──────────────────────────────────────────────────
  if (request.method === 'POST' && url.pathname === '/family/invite') {
    let body;
    try { body = await request.json(); } catch {
      return json({ error: 'Invalid JSON body' }, 400, env);
    }

    const { email, role = 'member' } = body;
    if (!email) return json({ error: 'Email required' }, 400, env);

    // Validate role to prevent privilege escalation
    const ALLOWED_ROLES = ['member', 'adult', 'child', 'member_limited'];
    if (!ALLOWED_ROLES.includes(role))
      return json({ error: `Invalid role. Allowed: ${ALLOWED_ROLES.join(', ')}` }, 400, env);

    const userMemberships = await db.select('family_members', {
      user_id: `eq.${user.sub}`,
      limit: 1,
    }, userToken);

    if (!userMemberships.length)
      return json({ error: 'User has no family' }, 403, env);

    const family_id = userMemberships[0].family_id;

    const invitation = await db.insert('invitations', {
      family_id,
      email,
      role,
      invited_by: user.sub,
      token:      crypto.randomUUID(),
      expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
    }, userToken);

    return json({ invited: true, invitation }, 200, env);
  }

  // ── DELETE /family/members/:id ────────────────────────────────────────────
  if (request.method === 'DELETE' && url.pathname.startsWith('/family/members/')) {
    const memberId = url.pathname.split('/').pop();
    if (!memberId) return json({ error: 'Missing member id' }, 400, env);

    await db.delete('family_members', memberId, userToken);
    return json({ removed: true, id: memberId }, 200, env);
  }

  return json({ error: 'Not found' }, 404, env);
}
