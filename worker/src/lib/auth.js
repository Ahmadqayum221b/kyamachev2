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
/**
 * Verifies a Supabase JWT (supports HS256 and ES256)
 */
export async function verifyJwt(token, secret, env) {
  if (!token) return null;

  const parts = token.split('.');
  if (parts.length !== 3) return null;

  const [headerB64, payloadB64, signatureB64] = parts;
  
  try {
    const header = JSON.parse(new TextDecoder().decode(base64UrlToUint8Array(headerB64)));
    const payload = JSON.parse(new TextDecoder().decode(base64UrlToUint8Array(payloadB64)));
    const signature = base64UrlToUint8Array(signatureB64);
    const data = new TextEncoder().encode(`${headerB64}.${payloadB64}`);

    let isValid = false;

    if (header.alg === 'ES256') {
      // Fetch public keys from Supabase JWKS endpoint
      const jwksUrl = `${env.SUPABASE_URL.replace(/\/$/, '')}/auth/v1/jwks.json`;
      console.log('[auth] Fetching JWKS from:', jwksUrl);
      // Note: JWKS endpoint is public — no apikey header needed (and it can cause errors)
      const res = await fetch(jwksUrl);
      if (!res.ok) {
        console.error('[auth] JWKS fetch failed:', res.status, res.statusText);
        return null;
      }
      const text = await res.text();
      console.log('[auth] Raw JWKS response:', text.substring(0, 200));
      let jwks;
      try {
        jwks = JSON.parse(text);
      } catch (parseErr) {
        console.error('[auth] Failed to parse JWKS JSON:', parseErr.message, 'Raw:', text.substring(0, 200));
        return null;
      }
      
      if (!jwks?.keys || !Array.isArray(jwks.keys)) {
        console.error('[auth] Invalid JWKS response — no keys array:', JSON.stringify(jwks).substring(0, 200));
        return null;
      }

      const key = jwks.keys.find(k => k.kid === header.kid);
      
      if (!key) {
        console.error('[auth] Public key not found in JWKS');
        return null;
      }

      const publicKey = await crypto.subtle.importKey(
        'jwk', key, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']
      );
      isValid = await crypto.subtle.verify(
        { name: 'ECDSA', hash: { name: 'SHA-256' } },
        publicKey, signature, data
      );
    } else {
      // Fallback to HS256
      const encoder = new TextEncoder();
      
      // Try raw UTF-8 encoding first (most common for Supabase JWT secrets)
      const rawKey = await crypto.subtle.importKey(
        'raw', encoder.encode(secret || ''), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']
      );
      isValid = await crypto.subtle.verify('HMAC', rawKey, signature, data);

      // If that fails, try treating the secret as base64 (some Supabase projects use base64 secrets)
      if (!isValid && secret) {
        try {
          const b64Key = base64UrlToUint8Array(secret.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''));
          const importedB64Key = await crypto.subtle.importKey(
            'raw', b64Key, { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']
          );
          isValid = await crypto.subtle.verify('HMAC', importedB64Key, signature, data);
        } catch (_) { /* not valid base64 — ignore */ }
      }
    }

    console.log('[auth] Signature valid:', isValid);
    if (!isValid) return null;

    const now = Math.floor(Date.now() / 1000);
    if (payload.exp && payload.exp < now) {
      console.warn('[auth] Token expired');
      return null;
    }

    if (!payload.sub || typeof payload.sub !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(payload.sub)) {
      console.error('[auth] Rejected: sub is absent or invalid');
      return null;
    }

    return payload;
  } catch (err) {
    console.error('[auth] JWT verification error:', err);
    return null;
  }
}

export async function getUser(request, env) {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;

  const token = authHeader.slice(7);
  return verifyJwt(token, env.SUPABASE_JWT_SECRET, env);
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
