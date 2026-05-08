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

/**
 * Shared response helper.
 *
 * Handles both json(data, status, request, env) and json(data, status, env).
 * This flexibility prevents CORS errors when route handlers forget the request argument.
 */
export function json(data, status = 200, arg3 = null, arg4 = {}) {
  let request = null;
  let env = {};

  // Detect if arg3 is a Request object or an env object
  if (arg3 && typeof arg3.headers !== 'undefined' && typeof arg3.headers.get === 'function') {
    request = arg3;
    env = arg4;
  } else {
    // If arg3 is not a request, assume it's the env object (common in this codebase)
    env = arg3 ?? {};
    request = { headers: { get: () => null } };
  }

  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...getCorsHeaders(request, env),
    },
  });
}
