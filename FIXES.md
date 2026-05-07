# Kymacache — Applied Fixes

This document describes every change made from the original codebase and why.

---

## Critical Security Fixes

### 1. Hardcoded credentials removed from PWA (`pwa/app-v2.js`)

**Problem**: `SUPABASE_URL` and `SUPABASE_KEY` (a real JWT) were embedded
directly in source code. Anyone who opened DevTools or viewed the repo could
extract them and query the Supabase database directly.

**Fix**: Credentials are now read from `window.KYMACACHE_CONFIG`, which must
be injected by the deployment platform before the script loads. Add this to
`index.html` at deploy time (via Cloudflare Pages environment transforms or
equivalent):

```html
<script>
  window.KYMACACHE_CONFIG = {
    apiBase:     "https://kymacache-worker.yourname.workers.dev",
    supabaseUrl: "https://yourproject.supabase.co",
    supabaseKey: "your-anon-key",
  };
</script>
```

The anon key is safe to ship to browsers **as long as RLS is correctly
configured** — it cannot bypass Row Level Security. What must never appear
in client code: the `service_role` key.

**Files**: `pwa/app-v2.js`

---

### 2. `/process` endpoint secured with internal secret

**Problem**: `/process/:id` was declared public in `index.js` (the
`isPublic` check included all paths starting with `/process`). Any external
caller could POST to it, trigger AI classification on any entry UUID, burn
Kimi API budget, and overwrite entry data.

**Fix**: The endpoint now requires an `X-Internal-Secret` header matching the
`PROCESS_SECRET` environment variable. All internal callers (entries.js,
broker.js, cron/tagging.js) include this header. External requests without
the correct secret receive `403 Forbidden`.

Set the secret once:
```bash
wrangler secret put PROCESS_SECRET
# use: openssl rand -hex 32
```

**Files**: `worker/src/index.js`, `worker/src/routes/entries.js`,
`worker/src/routes/broker.js`, `worker/src/cron/tagging.js`

---

### 3. JWT `sub` claim validated against path traversal

**Problem**: The `/file/:key/signed` ownership check was
`key.startsWith('uploads/${user.sub}/')`. If `user.sub` contained `../` or
other path traversal characters, the check could be bypassed.

**Fix**: `verifyJwt()` in `auth.js` now validates that `sub` matches
`/^[a-zA-Z0-9_-]{1,128}$/`. Tokens with unsafe `sub` values are rejected
outright.

**Files**: `worker/src/lib/auth.js`

---

### 4. CORS `Access-Control-Allow-Origin` hardened

**Problem**: `getCorsHeaders()` fell back to `'*'` when `FRONTEND_URL` was
not set. With authenticated endpoints, a wildcard CORS origin is a
cross-site request forgery risk.

**Fix**: If `FRONTEND_URL` is not set, the worker logs an error and returns
`'null'` as the CORS origin (which causes all cross-origin requests to fail),
making the misconfiguration immediately visible rather than silently insecure.

**Files**: `worker/src/index.js`, `worker/wrangler.toml`

---

## Bug Fixes

### 5. `POST /entries` 201 response had no CORS header

**Problem**: `return json(entry, 201)` was missing the third `env` argument.
The `json()` helper in `entries.js` used `env.FRONTEND_URL` to set the CORS
header — without `env`, the header was `'undefined'`, breaking cross-origin
POST requests from the PWA in production.

**Fix**: All `json()` call-sites in `entries.js` now pass `env`.

**Files**: `worker/src/routes/entries.js`

---

### 6. `authHeader.split(' ')[1]` replaced everywhere

**Problem**: Several route handlers called `authHeader.split(' ')[1]` directly
on the `Authorization` header. If the header was absent (or malformed), this
threw a `TypeError`, crashing the worker and returning a 500 instead of a
clean 401/403.

**Fix**: A new `getRawToken(request)` helper in `auth.js` safely extracts the
token (returns `null` instead of throwing). All route files now use it.

**Files**: `worker/src/lib/auth.js` (new export), `worker/src/routes/entries.js`,
`worker/src/routes/file.js`, `worker/src/routes/search.js`,
`worker/src/routes/broker.js`, `worker/src/routes/family.js`

---

### 7. Cron tagging query fixed

**Problem**: `tagging.js` sent `or` and `tagging_attempts` as separate
top-level PostgREST query params. PostgREST ANDs all top-level params, so the
`tagging_attempts < 5` guard applied globally (including to `pending` entries)
rather than only to `failed` ones. The `or` param syntax was also incorrect
for PostgREST.

**Fix**: Two separate queries (one for `pending`, one for `failed` with
`tagging_attempts.lt.5`) are run in parallel and deduplicated by entry ID.

**Files**: `worker/src/cron/tagging.js`

---

### 8. Daily budget increment made atomic

**Problem**: `process.js` read `budget.cost_cents`, added 1 in JavaScript, and
wrote it back. Under concurrent classification requests, two workers could
both read `N`, both write `N+1`, resulting in a lost update — the budget
counter under-counted and the cap could be exceeded.

**Fix**: A Postgres function `increment_daily_budget(p_day, p_cost)` performs
an atomic `INSERT ... ON CONFLICT DO UPDATE SET cost_cents = cost_cents + 1`.
Called via `db.rpcIncrement()` in `supabase.js`.

**Files**: `worker/src/lib/supabase.js`, `worker/src/routes/process.js`,
`supabase/migrations/20260504_fixes.sql`

---

### 9. Service worker background sync URL fixed

**Problem**: `syncPendingCaptures()` in `sw.js` constructed the API URL as
`self.registration.scope + '/api'`, producing `.../api/entries`. The Worker
has no `/api` prefix, so all offline sync requests silently 404'd.

**Fix**: API base is now `self.registration.scope` (without `/api`).

**Files**: `pwa/sw.js`

---

### 10. B2 auth token now KV-cached across requests

**Problem**: `B2Client` cached the auth token on `this._auth`, but Cloudflare
Workers are ephemeral — `makeB2()` creates a fresh instance per request, so
`_auth` was always `null` and `authorize()` was called on every upload/download.
B2 tokens are valid for ~24 hours; the per-request round-trip was wasteful and
slow.

**Fix**: The auth token is now stored in Cloudflare KV with a 23-hour TTL and
shared across all Worker instances. `makeB2(env)` passes the KV binding to the
client.

**Files**: `worker/src/lib/b2.js`

---

### 11. Search query uses safe PostgREST FTS instead of ILIKE interpolation

**Problem**: `supabase.js` search built `content.ilike.*${safeQuery}*` by
string interpolation. Although `safeQuery` stripped some punctuation, the
result was still user-controlled input injected into a PostgREST filter
string, opening operator injection.

**Fix**: Search now uses PostgREST's `fts` (full-text search) filter which
is parameterized internally. Label filters sanitize each value to
`/[^a-zA-Z0-9_-]/g` before building the containment filter.

**Files**: `worker/src/lib/supabase.js`

---

### 12. Broker file key now includes `user.sub`

**Problem**: `/upload-init` generated keys as `uploads/${year}/${month}/...`
(no user ID). The `/file/:key/signed` ownership check requires keys to start
with `uploads/${user.sub}/`, so files uploaded via the broker route could
never get signed URLs.

**Fix**: Broker key format is now `uploads/${user.sub}/${year}/${month}/...`
matching the direct-upload route.

**Files**: `worker/src/routes/broker.js`

---

### 13. Family invite missing role validation

**Problem**: `/family/invite` accepted any string as `role`, allowing a
caller to invite a member with `role = 'owner'` or `role = 'admin'` without
owning the family.

**Fix**: Role is validated against an allowlist
`['member', 'adult', 'child', 'member_limited']` before the invite is created.

**Files**: `worker/src/routes/family.js`

---

## Database Migration (`supabase/migrations/20260504_fixes.sql`)

| # | Change |
|---|--------|
| 1 | `uploaded_by` column type changed from `UUID` to `TEXT` to match `user_id` and avoid `auth.uid()::uuid` cast errors in RLS policies |
| 2 | `increment_daily_budget(p_day, p_cost)` RPC function added (atomic upsert) |
| 3 | `updated_at` trigger wired up on `daily_budget` table |
| 4 | Conflicting / overlapping RLS policies on `entries` consolidated into four clean policies: `read_own_or_family`, `insert_own`, `update_own`, `delete_own` |
| 5 | `log_entry_action()` audit trigger updated with explicit NULL guards for DELETE operations |
| 6 | Unique index added on `invitations(token)` for fast token lookups |

---

## Removed Dead Code

- `kvGetList`, `kvSetList`, `kvInvalidateList` imports removed from `entries.js`
  (functions were imported but the list-caching feature was never implemented)

---

## v4 Patch — Remaining Issues Fixed

### 1. upload-complete B2 file existence verification (broker.js)
**Was:** upload-complete trusted the client's `file_key` and `file_id` claims without verifying the file actually existed in B2. Any authenticated user could call upload-complete with arbitrary keys.
**Fix:** Added an ownership check (`file_key.startsWith('uploads/${user.sub}/')`) and a cheap B2 HEAD request to verify the file is physically present before inserting the database record. Eliminates the ability to create DB entries pointing at non-existent or other users' files.

### 2. Portable test paths (security-tests.mjs)
**Was:** Two file-scan tests hardcoded `/home/claude/kyma-fixed/...` absolute paths, causing them to fail on any machine other than the original dev box.
**Fix:** Replaced with `import.meta.url` + `dirname` resolution so paths are always relative to the test file's location. Now 50/50 tests pass on any machine.

### 3. content: null PWA display (pwa/app-v2.js)
**Was:** Feed cards fell back to `[No text content]` for any entry where `content` was null/empty — which is expected and correct for image and file entries, but misleading.
**Fix:** Fallback is now content-type-aware: image entries show "📷 Image attachment", file entries show "📎 File attachment", URL entries show the source URL, and text entries with an AI summary rely on the summary div. Generic `(no content)` only appears when truly nothing is available.

### 4. Junk brace-expansion directory removed
**Was:** `{pwa,worker` empty directory in root (failed PowerShell brace expansion).
**Fix:** Removed.

### 5. features.md removed
**Was:** Empty placeholder file committed to repo.
**Fix:** Removed. If a features roadmap is needed, it should be a real document.
