/**
 * /file route
 * POST   /file             → upload file to B2, return { file_url, file_key, file_id }
 * GET    /file/:key/signed → return a time-limited signed download URL
 */

import { makeB2 }      from '../lib/b2.js';
import { getRawToken } from '../lib/auth.js';
import { json } from '../lib/response.js';


const ALLOWED_TYPES = new Set([
  'image/jpeg', 'image/png', 'image/gif', 'image/webp',
  'application/pdf',
  'text/plain', 'text/markdown',
  'application/octet-stream',
]);

export async function handleFile(request, env, ctx, url, user) {
  const parts = url.pathname.split('/').filter(Boolean);
  const b2 = makeB2(env);

  // FIX (bug): use getRawToken() instead of unsafe authHeader.split(' ')[1]
  const userToken = getRawToken(request);

  // ── GET /file/:key/signed ─────────────────────────────────────────────────
  if (request.method === 'GET' && parts.length >= 2) {
    const pathMatch = url.pathname.match(/^\/file\/(.+)\/signed$/);
    if (!pathMatch) return json({ error: 'Invalid file route' }, 400, env);
    const key = pathMatch[1];

    // FIX (security): user.sub is now guaranteed safe (alphanumeric only) by
    // verifyJwt() in auth.js, eliminating the path-traversal risk. The check
    // itself is otherwise unchanged.
    if (!key.startsWith(`uploads/${user.sub}/`)) {
      return json({ error: 'Forbidden: you do not own this file' }, 403, env);
    }

    const signedUrl = await b2.getDownloadUrl(key, 3600);
    return json({ signed_url: signedUrl, expires_in: 3600 }, 200, env);
  }

  // ── POST /file ────────────────────────────────────────────────────────────
  if (request.method === 'POST') {
    if (env.KYMACACHE_KV) {
      const userIp  = request.headers.get('cf-connecting-ip') || 'anon';
      const rateKey = `rate:upload:${userIp}`;
      const count   = Number(await env.KYMACACHE_KV.get(rateKey) || 0);
      if (count > 10) return json({ error: 'Rate limit exceeded' }, 429, env);
      await env.KYMACACHE_KV.put(rateKey, count + 1, { expirationTtl: 60 });
    }

    const maxBytes = Number(env.MAX_FILE_SIZE ?? 10 * 1024 * 1024);

    const formData = await request.formData().catch(() => null);
    if (!formData) return json({ error: 'Expected multipart/form-data' }, 400, env);

    const file = formData.get('file');
    if (!file || typeof file === 'string')
      return json({ error: 'Form field `file` is missing or not a file' }, 400, env);

    const buffer = await file.arrayBuffer();
    if (buffer.byteLength > maxBytes)
      return json({ error: `File too large. Max ${maxBytes} bytes.` }, 413, env);

    const mimeType = formData.get('mime_type') ?? file.type ?? 'application/octet-stream';
    if (!ALLOWED_TYPES.has(mimeType) && !mimeType.startsWith('image/'))
      return json({ error: `Unsupported file type: ${mimeType}` }, 415, env);

    const now    = new Date();
    const folder = `uploads/${user.sub}/${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, '0')}`;
    const uid    = crypto.randomUUID();
    const name   = (file.name ?? 'file').replace(/[^a-zA-Z0-9._-]/g, '_');
    const key    = `${folder}/${uid}/${name}`;

    const result = await b2.upload(key, buffer, mimeType);

    return json({
      file_url:  result.publicUrl,
      file_key:  key,
      file_id:   result.fileId,
      mime_type: mimeType,
      size:      buffer.byteLength,
    }, 201, env);
  }

  return json({ error: 'Method not allowed' }, 405, env);
}
