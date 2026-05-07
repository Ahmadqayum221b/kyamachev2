/**
 * Service Broker Route
 *
 * POST /upload-init     → generate pre-signed B2 upload URL
 * POST /upload-complete → notify worker of finished direct upload
 */

import { makeB2 }       from '../lib/b2.js';
import { makeSupabase } from '../lib/supabase.js';
import { getRawToken }  from '../lib/auth.js';
import { json } from '../lib/response.js';


export async function handleBroker(request, env, ctx, url, user) {
  const b2   = makeB2(env);
  const db   = makeSupabase(env);
  const path = url.pathname;
  // FIX (bug): use getRawToken() helper
  const userToken = getRawToken(request);

  // ── POST /upload-init ─────────────────────────────────────────────────────
  if (path === '/upload-init' && request.method === 'POST') {
    const { filename, size, mime } = await request.json();
    if (!filename || !size || !mime)
      return json({ error: 'Missing required fields' }, 400, env);

    const now    = new Date();
    // FIX (bug): include user.sub in the broker key so /file/:key/signed
    // ownership check works for broker-uploaded files too.
    const folder = `uploads/${user.sub}/${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, '0')}`;
    const uid    = crypto.randomUUID();
    const name   = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
    const key    = `${folder}/${uid}/${name}`;

    try {
      const uploadUrlResult = await b2.getUploadUrl();
      return json({
        upload_url:        uploadUrlResult.uploadUrl,
        upload_auth_token: uploadUrlResult.authorizationToken,
        file_key:          key,
      }, 200, env);
    } catch (err) {
      return json({ error: 'Failed to generate upload URL', detail: err.message }, 500, env);
    }
  }

  // ── POST /upload-complete ─────────────────────────────────────────────────
  if (path === '/upload-complete' && request.method === 'POST') {
    const { file_key, file_id, filename, size, mime } = await request.json();

    // FIX (security): verify the file actually exists in B2 before creating a
    // database record. Without this check, any authenticated user could call
    // upload-complete with an arbitrary file_key (even one they don't own) and
    // manufacture a database entry pointing to a non-existent or another user's
    // file. A HEAD request to B2 is cheap (~50ms) and confirms real existence.
    // The key ownership (uploads/${user.sub}/...) is still checked by the signed
    // URL route, but we add defence-in-depth here at insertion time.
    if (!file_key || !file_key.startsWith(`uploads/${user.sub}/`)) {
      return json({ error: 'Forbidden: file_key does not belong to your account' }, 403, env);
    }
    try {
      const exists = await b2.fileExists(file_key);
      if (!exists) {
        return json({ error: 'File not found in B2 — upload may have failed' }, 422, env);
      }
    } catch (err) {
      return json({ error: 'Could not verify file existence', detail: err.message }, 502, env);
    }

    const entry = await db.insert('entries', {
      content:      filename,
      content_type: mime.startsWith('image/') ? 'image' : 'file',
      file_url:     `${env.B2_PUBLIC_URL}/${file_key}`,
      file_key,
      ai_metadata:  { b2_file_id: file_id, size, direct_upload: true },
      ai_status:    'pending',
      status:       'active',
    }, userToken);

    // FIX (security): include X-Internal-Secret on the /process self-call
    ctx.waitUntil(fetch(`${env.WORKER_SELF_URL || 'http://localhost'}/process/${entry.id}`, {
      method:  'POST',
      headers: {
        'Content-Type':      'application/json',
        'X-Internal-Secret': env.PROCESS_SECRET ?? '',
      },
      body: JSON.stringify({ trigger: 'broker' }),
    }));

    return json(entry, 201, env);
  }

  return json({ error: 'Not found' }, 404, env);
}
