/**
 * /process route — async AI classification pipeline
 *
 * POST /process/:id   → classify entry with Kimi, update Supabase + KV
 *
 * Called:
 *   1. Automatically via ctx.waitUntil() after entry creation (non-blocking)
 *   2. By the cron tagging job for failed/pending retries
 *
 * FIX (security): this route is no longer public. index.js enforces that
 * the X-Internal-Secret header matches env.PROCESS_SECRET before the
 * request reaches here. This prevents external callers from burning
 * Kimi API budget or overwriting entry data.
 */

import { makeSupabase }     from '../lib/supabase.js';
import { classifyWithKimi } from '../lib/kimi.js';
import { kvSet, kvDelete }  from '../lib/kv.js';
import { makeB2 }           from '../lib/b2.js';
import { json } from '../lib/response.js';


export async function handleProcess(request, env, ctx, url) {
  if (request.method !== 'POST')
    return json({ error: 'Method not allowed' }, 405, env);

  const parts   = url.pathname.split('/').filter(Boolean);
  const entryId = parts[1];
  if (!entryId) return json({ error: 'Missing entry id' }, 400, env);

  const db = makeSupabase(env);

  const entry = await db.selectOne('entries', entryId);
  if (!entry) return json({ error: 'Entry not found' }, 404, env);

  await db.update('entries', entryId, {
    ai_status:      'processing',
    tagging_status: 'tagging',
  });

  const classifyPromise = (async () => {
    try {
      // 1. Content hash
      let contentHash = null;
      if (entry.content) {
        const msgUint8  = new TextEncoder().encode(entry.content);
        const hashBuf   = await crypto.subtle.digest('SHA-256', msgUint8);
        contentHash = Array.from(new Uint8Array(hashBuf))
          .map(b => b.toString(16).padStart(2, '0')).join('');
      }

      // 2. Budget check
      const today  = new Date().toISOString().split('T')[0];
      const budget = await db.selectOne('daily_budget', today) || { tokens_spent: 0, cost_cents: 0 };
      const MAX_COST_CENTS = Number(env.DAILY_BUDGET_CENTS ?? 100);

      if (budget.cost_cents >= MAX_COST_CENTS) {
        console.warn(`[process] budget exceeded for ${today}: ${budget.cost_cents}¢`);
        await db.update('entries', entryId, {
          ai_status:      'failed',
          tagging_status: 'failed',
          ai_metadata:    { ...entry.ai_metadata, error: 'Budget exceeded' },
        });
        return;
      }

      // 3. AI classification
      const context = [
        entry.content,
        entry.source   ? `[Source: ${entry.source}]`      : '',
        entry.file_url ? `[Attachment: ${entry.file_url}]` : '',
      ].filter(Boolean).join('\n\n');

      const ai = await classifyWithKimi(context, env.KIMI_API_KEY);

      // FIX (bug): budget increment was a read-modify-write (race condition).
      // Use a Supabase RPC for an atomic increment instead. If the RPC is not
      // available, fall back to upsert with a server-side expression via rpcIncrement().
      await db.rpcIncrement('daily_budget', today);

      // 4. Upload JSON artifact to B2
      const artifact = {
        id: entryId,
        type: entry.content_type,
        content: entry.content,
        classification: {
          summary: ai.summary ?? null,
          labels:  ai.labels  ?? [],
          metadata: {
            content_type:         ai.content_type,
            language:             ai.language,
            sentiment:            ai.sentiment,
            topics:               ai.topics,
            entities:             ai.entities,
            reading_time_seconds: ai.reading_time_seconds,
          },
        },
        timestamp: new Date().toISOString(),
      };

      const artifactBytes = new TextEncoder().encode(JSON.stringify(artifact));
      const b2       = makeB2(env);
      const b2Result = await b2.upload(`artifacts/${entryId}.json`, artifactBytes, 'application/json');

      // 5. Persist to Supabase
      const updated = await db.update('entries', entryId, {
        content_hash:   contentHash,
        artifact_url:   b2Result.publicUrl,
        ai_summary:     ai.summary  ?? null,
        ai_labels:      ai.labels   ?? [],
        last_tagged_at: new Date().toISOString(),
        tagging_status: 'tagged',
        ai_metadata: {
          content_type:         ai.content_type,
          language:             ai.language,
          sentiment:            ai.sentiment,
          topics:               ai.topics,
          entities:             ai.entities,
          reading_time_seconds: ai.reading_time_seconds,
          b2_artifact_file_id:  b2Result.fileId,
        },
        ai_status: 'done',
      });

      if (updated) await kvSet(env.KYMACACHE_KV, updated, Number(env.KV_TTL ?? 3600));

      console.log(`[process] classified ${entryId}: labels=${ai.labels?.join(',')}`);
    } catch (err) {
      console.error(`[process] failed for ${entryId}:`, err.message);
      const fresh = await db.selectOne('entries', entryId);
      await db.update('entries', entryId, {
        ai_status:        'failed',
        tagging_status:   'failed',
        tagging_attempts: (fresh?.tagging_attempts || 0) + 1,
      });
      await kvDelete(env.KYMACACHE_KV, entryId);
    }
  })();

  ctx.waitUntil(classifyPromise);

  return json({ accepted: true, entry_id: entryId, message: 'AI classification queued' }, 202, env);
}
