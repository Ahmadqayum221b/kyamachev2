# Kymacache — Deployment Guide

## Architecture

```
Browser (PWA)  ──→  Cloudflare Worker  ──→  Supabase (DB + Auth)
    ↓                                   ↑
  Vercel                           Backblaze B2
 (static host)                    (file storage)
```

---

## Step 1 — Deploy the Cloudflare Worker

The Worker is in `worker/`. It needs to be deployed first so you have its URL.

```bash
cd worker
npm install
```

Edit `wrangler.toml` and fill in your KV namespace IDs, then:

```bash
# Set secrets (do not put these in wrangler.toml)
npx wrangler secret put SUPABASE_URL
npx wrangler secret put SUPABASE_SERVICE_KEY
npx wrangler secret put B2_KEY_ID
npx wrangler secret put B2_APP_KEY
npx wrangler secret put B2_BUCKET_ID
npx wrangler secret put PROCESS_SECRET
npx wrangler secret put WORKER_SELF_URL   # the worker's own URL, e.g. https://kymacache.yourname.workers.dev

npx wrangler deploy
```

Note the Worker URL — you'll need it in the next step.

---

## Step 2 — Configure the PWA

Open `pwa/index.html` and fill in your credentials in the config block near the bottom:

```html
<script>
window.KYMACACHE_CONFIG = {
  apiBase:     "https://kymacache.yourname.workers.dev",  // ← your Worker URL
  supabaseUrl: "https://abcxyz.supabase.co",             // ← Supabase project URL
  supabaseKey: "eyJhbGci..."                              // ← Supabase ANON key only
};
</script>
```

> ⚠️ Use the **anon** key, never the service_role key. RLS policies protect the data.

---

## Step 3 — Deploy PWA to Vercel

### Option A — Vercel CLI (fastest)

```bash
# Install Vercel CLI if needed
npm i -g vercel

# From the project root
cd pwa
vercel deploy --prod
```

When asked:
- **Root directory**: `pwa`
- **Build command**: *(leave blank — no build step)*
- **Output directory**: `.` (current directory)
- **Framework**: Other

### Option B — Vercel Dashboard (no CLI)

1. Push your repo to GitHub/GitLab
2. Go to [vercel.com/new](https://vercel.com/new) → Import your repo
3. Set **Root Directory** to `pwa`
4. Leave Build Command and Output Directory blank
5. Click **Deploy**

The `vercel.json` in the project root handles SPA routing — all paths (including `/entries/:id` share links) serve `index.html`.

---

## Step 4 — Supabase Setup

1. Create a project at [supabase.com](https://supabase.com)
2. Go to **SQL Editor** and run the files in order:
   ```
   supabase/schema.sql
   supabase/migrations/20260428_beyond_v1_1.sql
   supabase/migrations/20260428_sharing_rls.sql
   supabase/migrations/20260504_fixes.sql
   supabase/migrations/20260507_collections_and_pinning.sql
   ```
3. Enable **Google OAuth** under Authentication → Providers if you want Google sign-in
4. Set your Vercel deployment URL as an allowed redirect URL under Authentication → URL Configuration

---

## Step 5 — Update CORS on the Worker

In `wrangler.toml`, set your Vercel URL as the allowed origin:

```toml
[vars]
ALLOWED_ORIGIN = "https://your-app.vercel.app"
```

Then redeploy the worker: `npx wrangler deploy`

---

## Local Development

```bash
# Terminal 1 — Worker
cd worker
npx wrangler dev

# Terminal 2 — PWA (any static server)
cd pwa
npx serve .
# or: python3 -m http.server 3000
```

For local dev, `API_BASE` auto-detects `localhost:8787` so no config change needed.

---

## Environment Summary

| Secret/Config       | Where set              | Notes                          |
|---------------------|------------------------|--------------------------------|
| `SUPABASE_URL`      | Worker secret          | e.g. https://xxx.supabase.co   |
| `SUPABASE_SERVICE_KEY` | Worker secret       | Service role — never in client |
| `B2_KEY_ID`         | Worker secret          | Backblaze B2                   |
| `B2_APP_KEY`        | Worker secret          | Backblaze B2                   |
| `B2_BUCKET_ID`      | Worker secret          | Backblaze B2                   |
| `PROCESS_SECRET`    | Worker secret          | Internal route auth            |
| `WORKER_SELF_URL`   | Worker secret          | Worker's own public URL        |
| `supabaseUrl`       | `index.html` config    | Anon key safe in client        |
| `supabaseKey`       | `index.html` config    | Anon key only                  |
| `apiBase`           | `index.html` config    | Worker URL                     |
