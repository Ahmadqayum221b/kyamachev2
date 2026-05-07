/**
 * Shared response helpers
 *
 * FIX (security): route files previously each had their own json() helper
 * that fell back to Access-Control-Allow-Origin: '*' when FRONTEND_URL was
 * not set — bypassing the fail-loud CORS hardening in index.js.
 *
 * This module is the single source of truth. All routes import json() from
 * here so there is one CORS policy and one place to change it.
 */

export function getCorsHeaders(request, env) {
  const allowedOrigin = env.FRONTEND_URL;
  if (!allowedOrigin) {
    console.error('[cors] FRONTEND_URL env var is not set — refusing to serve CORS headers');
    return { 'Access-Control-Allow-Origin': 'null' };
  }

  const origin = request.headers.get('Origin') ?? '';
  const finalOrigin =
    origin === allowedOrigin || origin.startsWith('http://localhost')
      ? origin
      : allowedOrigin;

  return {
    'Access-Control-Allow-Origin':  finalOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-User-Id',
    'Access-Control-Max-Age':       '86400',
  };
}

export function json(data, status = 200, request = null, env = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...getCorsHeaders(request ?? { headers: { get: () => null } }, env),
    },
  });
}
