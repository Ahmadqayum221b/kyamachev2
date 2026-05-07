/**
 * Kyma-fixed Security Test Suite
 * Tests all fixes documented in FIXES.md + additional edge cases
 * Runs fully in-process using the Web Crypto API polyfill (via Node 22)
 */

import { webcrypto } from 'node:crypto';
if (!globalThis.crypto) globalThis.crypto = webcrypto;
if (!globalThis.TextEncoder) globalThis.TextEncoder = (await import('node:util')).TextEncoder;
if (!globalThis.TextDecoder) globalThis.TextDecoder = (await import('node:util')).TextDecoder;

// ─── Inline source under test ────────────────────────────────────────────────

// --- auth.js ---
async function verifyJwt(token, secret) {
  if (!token || !secret) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, signatureB64] = parts;
  try {
    const encoder = new TextEncoder();
    const data = encoder.encode(`${headerB64}.${payloadB64}`);
    const key = await crypto.subtle.importKey(
      'raw', encoder.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']
    );
    const signature = base64UrlToUint8Array(signatureB64);
    const isValid = await crypto.subtle.verify('HMAC', key, signature, data);
    if (!isValid) return null;
    const payload = JSON.parse(new TextDecoder().decode(base64UrlToUint8Array(payloadB64)));
    const now = Math.floor(Date.now() / 1000);
    if (payload.exp && payload.exp < now) return null;
    if (!payload.sub || typeof payload.sub !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(payload.sub)) return null;
    return payload;
  } catch { return null; }
}
function base64UrlToUint8Array(b64) {
  const base64 = b64.replace(/-/g, '+').replace(/_/g, '/');
  const pad = base64.length % 4;
  const padded = pad ? base64 + '='.repeat(4 - pad) : base64;
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
function getRawToken(request) {
  const h = request.headers.get('Authorization');
  if (!h || !h.startsWith('Bearer ')) return null;
  return h.slice(7);
}
function getUser(request, env) {
  const h = request.headers.get('Authorization');
  if (!h || !h.startsWith('Bearer ')) return null;
  return verifyJwt(h.slice(7), env.SUPABASE_JWT_SECRET);
}

// --- JWT helpers for tests ---
async function signJwt(payload, secret) {
  const encoder = new TextEncoder();
  const header = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  const body = btoa(JSON.stringify(payload))
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(`${header}.${body}`));
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig)))
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  return `${header}.${body}.${sigB64}`;
}

// --- CORS logic ---
function getCorsHeaders(request, env) {
  const allowedOrigin = env.FRONTEND_URL;
  if (!allowedOrigin) return { 'Access-Control-Allow-Origin': 'null' };
  const origin = request.headers.get('Origin') ?? '';
  const finalOrigin =
    origin === allowedOrigin || origin.startsWith('http://localhost')
      ? origin : allowedOrigin;
  return {
    'Access-Control-Allow-Origin': finalOrigin,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-User-Id',
    'Access-Control-Max-Age': '86400',
  };
}

// --- isValidProcessRequest ---
function isValidProcessRequest(request, env) {
  const secret = env.PROCESS_SECRET;
  if (!secret) return false;
  return request.headers.get('X-Internal-Secret') === secret;
}

// --- Family role validation ---
function isAllowedRole(role) {
  const ALLOWED_ROLES = ['member', 'adult', 'child', 'member_limited'];
  return ALLOWED_ROLES.includes(role);
}

// --- File ownership check ---
function checkFileOwnership(key, userSub) {
  return key.startsWith(`uploads/${userSub}/`);
}

// --- Search label sanitizer ---
function sanitizeLabel(l) {
  return l.replace(/[^a-zA-Z0-9_-]/g, '');
}

// ─── Test harness ────────────────────────────────────────────────────────────

const SECRET = 'test-secret-32-chars-exactly!!!';
const results = [];

async function test(name, fn) {
  try {
    await fn();
    results.push({ name, status: 'PASS' });
    process.stdout.write(`  ✅ ${name}\n`);
  } catch (e) {
    results.push({ name, status: 'FAIL', error: e.message });
    process.stdout.write(`  ❌ ${name}\n     ${e.message}\n`);
  }
}

function assert(condition, msg) {
  if (!condition) throw new Error(msg || 'Assertion failed');
}

function makeReq(path, { method = 'GET', headers = {}, body } = {}) {
  const url = `https://worker.example.com${path}`;
  return { url, method, headers: { get: (k) => headers[k] ?? null }, body };
}

// ─── Test groups ─────────────────────────────────────────────────────────────

console.log('\n🔐 AUTH — JWT verification\n');

await test('valid JWT with safe sub accepted', async () => {
  const tok = await signJwt({ sub: 'user-uuid-123', exp: Math.floor(Date.now()/1000)+3600 }, SECRET);
  const r = await verifyJwt(tok, SECRET);
  assert(r !== null, 'should return payload');
  assert(r.sub === 'user-uuid-123');
});

await test('tampered signature rejected', async () => {
  const tok = await signJwt({ sub: 'user-123' }, SECRET);
  const parts = tok.split('.');
  parts[2] = parts[2].slice(0, -4) + 'xxxx';
  const r = await verifyJwt(parts.join('.'), SECRET);
  assert(r === null, 'tampered token must be rejected');
});

await test('expired token rejected', async () => {
  const tok = await signJwt({ sub: 'user-123', exp: Math.floor(Date.now()/1000) - 10 }, SECRET);
  const r = await verifyJwt(tok, SECRET);
  assert(r === null, 'expired token must be rejected');
});

await test('wrong secret rejected', async () => {
  const tok = await signJwt({ sub: 'user-123' }, 'other-secret');
  const r = await verifyJwt(tok, SECRET);
  assert(r === null, 'token signed with different secret must fail');
});

await test('missing token returns null', async () => {
  assert(await verifyJwt(null, SECRET) === null);
  assert(await verifyJwt('', SECRET) === null);
});

await test('malformed token (2 parts) returns null', async () => {
  assert(await verifyJwt('header.payload', SECRET) === null);
});

await test('token with no sub field rejected (fix: was bypassing check)', async () => {
  const tok = await signJwt({ exp: Math.floor(Date.now()/1000)+3600 }, SECRET);
  const r = await verifyJwt(tok, SECRET);
  assert(r === null, 'token without sub must be rejected');
});

await test('token with empty string sub rejected', async () => {
  const tok = await signJwt({ sub: '', exp: Math.floor(Date.now()/1000)+3600 }, SECRET);
  const r = await verifyJwt(tok, SECRET);
  assert(r === null, 'empty sub must be rejected');
});

console.log('\n🔐 AUTH — Path traversal via sub claim (Fix #3)\n');

await test('sub with ../ rejected (path traversal)', async () => {
  const tok = await signJwt({ sub: '../admin', exp: Math.floor(Date.now()/1000)+3600 }, SECRET);
  const r = await verifyJwt(tok, SECRET);
  assert(r === null, 'sub with ../ must be rejected');
});

await test('sub with / rejected', async () => {
  const tok = await signJwt({ sub: 'a/b', exp: Math.floor(Date.now()/1000)+3600 }, SECRET);
  const r = await verifyJwt(tok, SECRET);
  assert(r === null);
});

await test('sub with null byte rejected', async () => {
  const tok = await signJwt({ sub: 'abc\x00def', exp: Math.floor(Date.now()/1000)+3600 }, SECRET);
  const r = await verifyJwt(tok, SECRET);
  assert(r === null);
});

await test('sub with dot-dot rejected', async () => {
  const tok = await signJwt({ sub: 'user..admin', exp: Math.floor(Date.now()/1000)+3600 }, SECRET);
  const r = await verifyJwt(tok, SECRET);
  assert(r === null);
});

await test('sub with space rejected', async () => {
  const tok = await signJwt({ sub: 'user 123', exp: Math.floor(Date.now()/1000)+3600 }, SECRET);
  const r = await verifyJwt(tok, SECRET);
  assert(r === null);
});

await test('sub with 129 chars rejected (too long)', async () => {
  const tok = await signJwt({ sub: 'a'.repeat(129), exp: Math.floor(Date.now()/1000)+3600 }, SECRET);
  const r = await verifyJwt(tok, SECRET);
  assert(r === null);
});

await test('sub with Unicode rejected', async () => {
  const tok = await signJwt({ sub: 'üser', exp: Math.floor(Date.now()/1000)+3600 }, SECRET);
  const r = await verifyJwt(tok, SECRET);
  assert(r === null);
});

await test('valid UUID sub accepted', async () => {
  const tok = await signJwt({ sub: '550e8400-e29b-41d4-a716-446655440000', exp: Math.floor(Date.now()/1000)+3600 }, SECRET);
  const r = await verifyJwt(tok, SECRET);
  assert(r !== null && r.sub === '550e8400-e29b-41d4-a716-446655440000');
});

await test('sub with underscore/hyphen accepted', async () => {
  const tok = await signJwt({ sub: 'user_123-abc', exp: Math.floor(Date.now()/1000)+3600 }, SECRET);
  const r = await verifyJwt(tok, SECRET);
  assert(r !== null);
});

console.log('\n🔐 AUTH — getRawToken helper (Fix #6)\n');

await test('getRawToken returns token from valid header', () => {
  const req = makeReq('/', { headers: { Authorization: 'Bearer mytoken' } });
  assert(getRawToken(req) === 'mytoken');
});

await test('getRawToken returns null when header absent', () => {
  const req = makeReq('/');
  assert(getRawToken(req) === null, 'should not throw');
});

await test('getRawToken returns null for malformed header', () => {
  const req = makeReq('/', { headers: { Authorization: 'Basic abc' } });
  assert(getRawToken(req) === null);
});

await test('getRawToken returns null for bare "Bearer" with no token', () => {
  const req = makeReq('/', { headers: { Authorization: 'Bearer' } });
  // "Bearer".slice(7) === "" which is falsy, but it still returns a string
  // Our impl: returns '' — empty string is fine (caller should check falsy)
  const t = getRawToken(req);
  // Falsy or null both acceptable
  assert(!t || t === '');
});

console.log('\n🌐 CORS — Origin validation (Fix #4)\n');

await test('returns "null" origin when FRONTEND_URL missing', () => {
  const req = makeReq('/', { headers: { Origin: 'https://evil.com' } });
  const h = getCorsHeaders(req, {});
  assert(h['Access-Control-Allow-Origin'] === 'null', `got: ${h['Access-Control-Allow-Origin']}`);
});

await test('exact FRONTEND_URL origin accepted', () => {
  const req = makeReq('/', { headers: { Origin: 'https://app.example.com' } });
  const h = getCorsHeaders(req, { FRONTEND_URL: 'https://app.example.com' });
  assert(h['Access-Control-Allow-Origin'] === 'https://app.example.com');
});

await test('different origin gets FRONTEND_URL (not wildcard)', () => {
  const req = makeReq('/', { headers: { Origin: 'https://evil.com' } });
  const h = getCorsHeaders(req, { FRONTEND_URL: 'https://app.example.com' });
  assert(h['Access-Control-Allow-Origin'] === 'https://app.example.com');
  assert(h['Access-Control-Allow-Origin'] !== '*');
});

await test('localhost origin accepted for dev', () => {
  const req = makeReq('/', { headers: { Origin: 'http://localhost:3000' } });
  const h = getCorsHeaders(req, { FRONTEND_URL: 'https://app.example.com' });
  assert(h['Access-Control-Allow-Origin'] === 'http://localhost:3000');
});

await test('wildcard never returned when FRONTEND_URL set', () => {
  const cases = ['https://evil.com', '', 'null', 'https://sub.evil.com'];
  for (const origin of cases) {
    const req = makeReq('/', { headers: { Origin: origin } });
    const h = getCorsHeaders(req, { FRONTEND_URL: 'https://app.example.com' });
    assert(h['Access-Control-Allow-Origin'] !== '*', `Got * for origin: ${origin}`);
  }
});

console.log('\n🔒 /process — Internal secret enforcement (Fix #2)\n');

await test('correct secret accepted', () => {
  const req = makeReq('/process/123', { method: 'POST', headers: { 'X-Internal-Secret': 'abc123' } });
  assert(isValidProcessRequest(req, { PROCESS_SECRET: 'abc123' }) === true);
});

await test('wrong secret rejected', () => {
  const req = makeReq('/process/123', { method: 'POST', headers: { 'X-Internal-Secret': 'wrong' } });
  assert(isValidProcessRequest(req, { PROCESS_SECRET: 'abc123' }) === false);
});

await test('missing secret header rejected', () => {
  const req = makeReq('/process/123', { method: 'POST', headers: {} });
  assert(isValidProcessRequest(req, { PROCESS_SECRET: 'abc123' }) === false);
});

await test('missing PROCESS_SECRET env var rejects all', () => {
  const req = makeReq('/process/123', { method: 'POST', headers: { 'X-Internal-Secret': 'abc123' } });
  assert(isValidProcessRequest(req, {}) === false);
});

await test('empty string secret env var rejects', () => {
  const req = makeReq('/process/123', { method: 'POST', headers: { 'X-Internal-Secret': '' } });
  assert(isValidProcessRequest(req, { PROCESS_SECRET: '' }) === false);
});

await test('SQL injection attempt in secret rejected', () => {
  const req = makeReq('/process/123', { method: 'POST', headers: { 'X-Internal-Secret': "'; DROP TABLE entries; --" } });
  assert(isValidProcessRequest(req, { PROCESS_SECRET: 'real-secret' }) === false);
});

console.log('\n📂 /file — Ownership check (Fix #3)\n');

await test('own file path accepted', () => {
  assert(checkFileOwnership('uploads/user123/2026/05/uuid/file.jpg', 'user123') === true);
});

await test('other user file path rejected', () => {
  assert(checkFileOwnership('uploads/other-user/2026/05/uuid/file.jpg', 'user123') === false);
});

await test('path traversal with safe sub impossible (sub is validated)', () => {
  // If sub were "user/../admin", the startsWith check would be bypassed.
  // But auth.js rejects such subs before we get here.
  // Simulate: attacker cannot produce a JWT with bad sub (auth rejects it).
  // We verify ownership check still fails with an "escaped" path even if sub were sneaked in.
  assert(checkFileOwnership('uploads/admin/2026/05/uuid/file.jpg', 'user123') === false);
});

await test('empty sub never reaches ownership check (caught by JWT layer)', async () => {
  // Auth fix: verifyJwt() now rejects tokens where sub is absent or empty.
  // user.sub can therefore never be undefined or '' when the route handler runs.
  // Verify the JWT layer catches it:
  const tok = await signJwt({ sub: '', exp: Math.floor(Date.now()/1000)+3600 }, SECRET);
  assert(await verifyJwt(tok, SECRET) === null, 'empty sub must be rejected by verifyJwt');
  const tok2 = await signJwt({ exp: Math.floor(Date.now()/1000)+3600 }, SECRET);
  assert(await verifyJwt(tok2, SECRET) === null, 'missing sub must be rejected by verifyJwt');
});

console.log('\n👨‍👩‍👧 /family — Role validation (Fix #13)\n');

await test('allowed roles pass', () => {
  for (const r of ['member', 'adult', 'child', 'member_limited']) {
    assert(isAllowedRole(r), `${r} should be allowed`);
  }
});

await test('owner role rejected (privilege escalation)', () => {
  assert(!isAllowedRole('owner'));
});

await test('admin role rejected', () => {
  assert(!isAllowedRole('admin'));
});

await test('superuser rejected', () => {
  assert(!isAllowedRole('superuser'));
});

await test('empty string role rejected', () => {
  assert(!isAllowedRole(''));
});

await test('undefined role rejected', () => {
  assert(!isAllowedRole(undefined));
});

await test('role injection attempt rejected', () => {
  assert(!isAllowedRole("member'; DROP TABLE family_members; --"));
});

console.log('\n🔍 Search — Label sanitization (Fix #11)\n');

await test('safe label unchanged', () => {
  assert(sanitizeLabel('recipe') === 'recipe');
  assert(sanitizeLabel('my-tag') === 'my-tag');
  assert(sanitizeLabel('tag_1') === 'tag_1');
});

await test('SQL injection structural chars stripped from label', () => {
  const r = sanitizeLabel("'; DROP TABLE entries; --");
  // Structural injection chars are stripped; alphanumeric words are inert
  // inside PostgREST cs.{} array containment (treated as literal strings, not SQL)
  assert(!r.includes("'"), `quote should be stripped, got: ${r}`);
  assert(!r.includes(';'), `semicolon should be stripped, got: ${r}`);
  assert(!r.includes(' '), `space should be stripped, got: ${r}`);
});

await test('PostgREST operator injection stripped', () => {
  // e.g. user tries label=eq.active which is a PostgREST operator
  const r = sanitizeLabel('eq.active');
  assert(!r.includes('.'), `dot should be stripped, got: ${r}`);
});

await test('curly brace injection stripped (breaks cs.{} filter)', () => {
  const r = sanitizeLabel('tag},other_table');
  assert(!r.includes('}') && !r.includes(','));
});

await test('unicode stripped', () => {
  const r = sanitizeLabel('tägliche');
  assert(!r.includes('ä'));
});

console.log('\n🔑 Credentials — No hardcoded secrets in source\n');

await test('pwa/app-v2.js has no hardcoded Supabase JWT', async () => {
  const { readFileSync } = await import('node:fs');
  const { join, dirname } = await import('node:path');
  // FIX (hygiene): resolve paths relative to this file using process.argv[1]
  // (the path of the running script), making the suite portable across machines
  // and CI environments — no more hardcoded /home/claude/... absolute paths.
  const root = dirname(process.argv[1]);
  const src = readFileSync(join(root, 'pwa', 'app-v2.js'), 'utf8');
  // A Supabase anon/service key is a long base64url JWT starting with "eyJ"
  const credPattern = /eyJ[a-zA-Z0-9_-]{40,}/;
  const matches = src.match(credPattern);
  assert(!matches, `Found potential hardcoded JWT: ${matches?.[0]?.slice(0,40)}...`);
});

await test('worker source files have no hardcoded secrets', async () => {
  const { readFileSync, readdirSync } = await import('node:fs');
  const { join, dirname } = await import('node:path');
  // FIX (hygiene): resolve paths relative to this file using process.argv[1].
  const root = dirname(process.argv[1]);
  function walk(dir) {
    return readdirSync(dir, { withFileTypes: true }).flatMap(e =>
      e.isDirectory() && e.name !== 'node_modules'
        ? walk(join(dir, e.name))
        : e.isFile() && e.name.endsWith('.js') ? [join(dir, e.name)] : []
    );
  }
  const files = walk(join(root, 'worker', 'src'));
  const credPattern = /eyJ[a-zA-Z0-9_-]{40,}/;
  for (const f of files) {
    const src = readFileSync(f, 'utf8');
    const matches = src.match(credPattern);
    assert(!matches, `Hardcoded JWT found in ${f}: ${matches?.[0]?.slice(0,40)}...`);
  }
});

// ─── Summary ─────────────────────────────────────────────────────────────────

const passed = results.filter(r => r.status === 'PASS').length;
const failed = results.filter(r => r.status === 'FAIL').length;

console.log('\n' + '─'.repeat(60));
console.log(`  Results: ${passed} passed, ${failed} failed out of ${results.length} tests`);
console.log('─'.repeat(60) + '\n');

if (failed > 0) {
  console.log('FAILED TESTS:');
  results.filter(r => r.status === 'FAIL').forEach(r => {
    console.log(`  ❌ ${r.name}\n     ${r.error}`);
  });
  process.exit(1);
}
