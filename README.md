# Kymacache

AI-powered knowledge capture platform.
**Stack**: PWA (Vanilla JS) → Cloudflare Worker → Supabase + KV + Backblaze B2 + Kimi K2.5

---

## Architecture

```
PWA (Vanilla JS)
  │  REST/JSON
  ▼
Cloudflare Worker  (orchestration)
  ├─ Supabase       → primary database (source of truth)
  ├─ Cloudflare KV  → cache only (recent entries, fast reads)
  ├─ Backblaze B2   → file storage (images, PDFs, attachments)
  └─ Kimi K2.5 AI   → async classification (non-blocking pipeline)
```

---

## Quick Start

### 1. Supabase

1. Create a new project at https://supabase.com
2. Go to **SQL Editor** and run `supabase/schema.sql`
3. Note your **Project URL** and **service_role key** (Settings → API)

### 2. Backblaze B2

1. Create an account at https://backblaze.com
2. Create a **Private** bucket (e.g. `kymacache-files`)
3. Go to **App Keys** → Add a New Application Key with access to that bucket
4. Note: **keyID**, **applicationKey**, **bucketId**, **bucketName**

### 3. Kimi API

1. Sign up at https://platform.moonshot.cn
2. Create an API key
3. Note the key

### 4. Cloudflare Worker

```bash
cd worker
npm install

# Create KV namespace
wrangler kv namespace create KYMACACHE_KV
# → Copy the `id` into wrangler.toml

# Set secrets (one-time)
wrangler secret put SUPABASE_URL         # e.g. https://xxx.supabase.co
wrangler secret put SUPABASE_SERVICE_KEY
wrangler secret put B2_KEY_ID
wrangler secret put B2_APP_KEY
wrangler secret put B2_BUCKET_ID
wrangler secret put B2_BUCKET_NAME
wrangler secret put KIMI_API_KEY
wrangler secret put WORKER_SELF_URL      # your deployed worker URL e.g. https://kymacache.yourname.workers.dev

# Local dev
wrangler dev

# Deploy
wrangler deploy
```

### 5. PWA

The PWA is static HTML/CSS/JS — no build step.

**For local testing:**
```bash
cd pwa
npx serve .
# or: python3 -m http.server 8080
```

**For production**: Deploy the `pwa/` folder to Cloudflare Pages, Netlify, or any static host.

In `pwa/app.js`, update `API_BASE` to point to your deployed Worker URL:
```js
const API_BASE = 'https://kymacache.yourname.workers.dev';
```

Or set it via `window.KYMACACHE_API` in a `<script>` tag in `index.html`.

---

## API Reference

All endpoints return `application/json`. CORS is fully open.

### `GET /health`
```json
{ "status": "ok", "ts": 1710000000000 }
```

### `GET /entries`
Query params: `limit` (default 20), `offset` (default 0)
Returns array of entry objects.

### `GET /entries/:id`
Returns single entry. KV-cached.

### `POST /entries`
Body:
```json
{
  "content":      "Your text, URL, or note",
  "content_type": "text|url|image|file",
  "source":       "optional origin app",
  "user_id":      "optional user identifier",
  "file_url":     "optional B2 public URL",
  "file_key":     "optional B2 object key"
}
```
Returns created entry with `ai_status: "pending"`.
AI classification runs **asynchronously** (non-blocking).

### `DELETE /entries/:id`
Deletes entry from Supabase, KV, and B2 (if file attached).

### `GET /search?q=term&labels=tag1,tag2&limit=20`
Full-text + label search via Supabase PostgREST.

### `POST /file`
`multipart/form-data` with field `file` (and optional `mime_type`).
Returns:
```json
{
  "file_url":  "https://...",
  "file_key":  "uploads/2024/01/uuid/filename.pdf",
  "file_id":   "b2-file-id",
  "mime_type": "image/jpeg",
  "size":      123456
}
```

### `GET /file/:key/signed`
Returns a 1-hour signed download URL for a private B2 file.

### `POST /process/:id`
Triggers AI classification for an entry. Returns `202 Accepted` immediately.
The classification runs in `ctx.waitUntil()` — fully non-blocking.

---

## Entry Schema

| Field          | Type       | Description                            |
|----------------|------------|----------------------------------------|
| `id`           | uuid       | Primary key                            |
| `user_id`      | text       | Optional user identifier               |
| `content`      | text       | Raw captured content                   |
| `content_type` | text       | text / url / image / file              |
| `source`       | text       | Origin app or share-target metadata    |
| `file_url`     | text       | Backblaze B2 public URL                |
| `file_key`     | text       | B2 object key                          |
| `ai_summary`   | text       | Kimi-generated 1-2 sentence summary    |
| `ai_labels`    | text[]     | 2-5 classification tags                |
| `ai_metadata`  | jsonb      | Extended AI metadata (topics, etc.)    |
| `ai_status`    | text       | pending / processing / done / failed   |
| `created_at`   | timestamptz| Creation time                          |
| `updated_at`   | timestamptz| Last update time                       |

---

## Async AI Pipeline

```
POST /entries  →  201 Created  (instant, user sees result immediately)
     │
     └─ ctx.waitUntil(POST /process/:id)
                │
                ├─ Fetch entry from Supabase
                ├─ Mark ai_status = 'processing'
                ├─ Call Kimi K2.5 API (classify content)
                ├─ PATCH Supabase: ai_summary, ai_labels, ai_metadata, ai_status='done'
                └─ Update KV cache with enriched entry
```

The user gets a `201` response within ~100ms.
AI results appear automatically when the entry is next fetched (~2-5s later).

---

## Development Notes

- **KV is cache only.** If a KV key expires or is missing, the Worker falls back to Supabase. Never write business logic that depends on KV having data.
- **Service role key** bypasses Supabase RLS. Never expose it client-side.
- **B2 bucket** can be public (direct URLs) or private (use `/file/:key/signed`). Private is recommended for user files.
- **Wrangler dev** proxies KV locally. Set `--local` flag for fully offline dev.
- **Share Target** requires HTTPS + installed PWA. Test on mobile after deploying.

---

## Deployment Checklist

- [ ] Supabase schema applied (`schema.sql`)
- [ ] KV namespace created and id in `wrangler.toml`
- [ ] All 7 secrets set via `wrangler secret put`
- [ ] `WORKER_SELF_URL` set to your `.workers.dev` URL
- [ ] Worker deployed: `wrangler deploy`
- [ ] PWA `API_BASE` updated to Worker URL
- [ ] PWA deployed to static host (Cloudflare Pages recommended)
- [ ] Tested: capture → entry created → AI enriched within ~5s
- [ ] Tested: file upload → B2 URL in entry
- [ ] Tested: search returns results
- [ ] Tested on mobile: share-to-app flow works
