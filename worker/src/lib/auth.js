/**
 * JWT Verification Utility for Cloudflare Workers
 * Uses Web Crypto API (HMAC-SHA256)
 */

/**
 * Verifies a Supabase HS256 JWT
 * @param {string} token
 * @param {string} secret
 * @returns {Promise<object|null>} Decoded payload or null if invalid
 */
export async function verifyJwt(token, secret) {
  if (!token || !secret) return null;

  const parts = token.split('.');
  if (parts.length !== 3) return null;

  const [headerB64, payloadB64, signatureB64] = parts;

  try {
    const encoder = new TextEncoder();
    const data = encoder.encode(`${headerB64}.${payloadB64}`);
    const key = await crypto.subtle.importKey(
      'raw',
      encoder.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify']
    );

    const signature = base64UrlToUint8Array(signatureB64);
    const isValid = await crypto.subtle.verify('HMAC', key, signature, data);
    if (!isValid) return null;

    const payload = JSON.parse(
      new TextDecoder().decode(base64UrlToUint8Array(payloadB64))
    );

    const now = Math.floor(Date.now() / 1000);
    if (payload.exp && payload.exp < now) {
      console.warn('[auth] Token expired');
      return null;
    }

    // FIX (security): Validate sub to prevent path traversal in /file/:key/signed
    // ownership check. Sub must be a safe alphanumeric/UUID string — no slashes,
    // dots, or directory-traversal characters.
    // FIX (security): reject tokens with no sub field, or a sub that contains
    // disallowed characters. Previously the guard used `payload.sub &&` which
    // allowed sub-less tokens through — user.sub became undefined, causing
    // file uploads to land under "uploads/undefined/..." and the ownership
    // check to pass for all such tokens.
    if (!payload.sub || typeof payload.sub !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(payload.sub)) {
      console.error('[auth] Rejected: sub is absent or contains disallowed characters');
      return null;
    }

    return payload;
  } catch (err) {
    console.error('[auth] JWT verification error:', err);
    return null;
  }
}

/**
 * Extracts and verifies the user from the Authorization header.
 * Returns null (never throws) so callers can safely do: if (!user) return 401
 */
export async function getUser(request, env) {
  const authHeader = request.headers.get('Authorization');
  // FIX (bug): guard against absent/malformed header before calling .split()
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;

  const token = authHeader.slice(7);
  const secret = env.SUPABASE_JWT_SECRET;

  if (!secret) {
    console.error('[auth] SUPABASE_JWT_SECRET is not set');
    return null;
  }

  return verifyJwt(token, secret);
}

/**
 * Safe helper used by route handlers to retrieve the raw Bearer token
 * after the request has already been authenticated by getUser().
 * Centralises the header-parsing so routes don't repeat the same
 * potentially-unsafe authHeader.split(' ')[1] pattern.
 */
export function getRawToken(request) {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  return authHeader.slice(7);
}

function base64UrlToUint8Array(base64Url) {
  const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
  const pad = base64.length % 4;
  const padded = pad ? base64 + '='.repeat(4 - pad) : base64;
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
