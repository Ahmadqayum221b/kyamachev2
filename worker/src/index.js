/**
 * Kymacache Cloudflare Worker
 * Routes: /entries  /search  /file  /process
 * All responses: JSON  |  CORS enabled
 */

import { handleEntries }   from './routes/entries.js';
import { handleSearch }    from './routes/search.js';
import { handleFile }      from './routes/file.js';
import { handleProcess }   from './routes/process.js';
import { handleBroker }    from './routes/broker.js';
import { handleFamily }    from './routes/family.js';
import { handleCollections } from './routes/collections.js';
import { handleScheduled } from './cron/tagging.js';
import { getUser }                   from './lib/auth.js';
import { getCorsHeaders, json }       from './lib/response.js';

function notFound(request, env) {
  return json({ error: 'Not found' }, 404, env);
}

// FIX (security): /process is no longer public. It requires a shared secret
// (PROCESS_SECRET env var) checked via X-Internal-Secret header.
// This prevents anyone on the internet from triggering AI classification
// (and burning Kimi API budget) on arbitrary entry IDs.
function isValidProcessRequest(request, env) {
  const secret = env.PROCESS_SECRET;
  if (!secret) {
    console.error('[process] PROCESS_SECRET is not set — rejecting all /process calls');
    return false;
  }
  return request.headers.get('X-Internal-Secret') === secret;
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: getCorsHeaders(request, env) });
    }

    const url  = new URL(request.url);
    const path = url.pathname.replace(/\/$/, '') || '/';

    try {
      let user = null;

      // FIX: /process is no longer blindly public — it requires the internal secret.
      // /health remains fully public.
      if (path !== '/health') {
        if (path.startsWith('/process')) {
          if (!isValidProcessRequest(request, env)) {
            return json({ error: 'Forbidden' }, 403, env);
          }
        } else {
          user = await getUser(request, env);
          
          // Special case: GET /entries/:id (but not /entries/bulk) can be public
          // if the database allows it (sharing_scope='public').
          // We allow the request to pass to the route handler which then queries DB.
          const isPublicEntryRequest = request.method === 'GET' && 
                                      path.startsWith('/entries/') && 
                                      !path.endsWith('/bulk');
          
          if (!user && !isPublicEntryRequest) {
            return json({ error: 'Unauthorized' }, 401, env);
          }
        }
      }

      if (path === '/entries' || path.startsWith('/entries/'))
        return await handleEntries(request, env, ctx, url, user);
      if (path === '/collections' || path.startsWith('/collections/'))
        return await handleCollections(request, env, ctx, url, user);
      if (path === '/search')
        return await handleSearch(request, env, ctx, url, user);
      if (path === '/file' || path.startsWith('/file/'))
        return await handleFile(request, env, ctx, url, user);
      if (path === '/process' || path.startsWith('/process/'))
        return await handleProcess(request, env, ctx, url);
      if (path === '/upload-init' || path === '/upload-complete')
        return await handleBroker(request, env, ctx, url, user);
      if (path === '/family' || path.startsWith('/family/'))
        return await handleFamily(request, env, ctx, url, user);
      if (path === '/health')
        return json({ 
          status: 'ok', 
          ts: Date.now(), 
          supabase_url_set: !!env.SUPABASE_URL,
          supabase_jwt_secret_set: !!env.SUPABASE_JWT_SECRET,
          environment: env.ENVIRONMENT || 'unknown'
        }, 200, env);

      return notFound(request, env);
    } catch (err) {
      console.error('[worker] unhandled error:', err);
      return json({ error: 'Internal server error', detail: err.message }, 500, env);
    }
  },

  async scheduled(event, env, ctx) {
    await handleScheduled(event, env, ctx);
  },
};
