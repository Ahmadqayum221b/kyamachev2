/**
 * Background Tagging Cron
 *
 * Triggered by a Cloudflare Cron scheduled event.
 * Finds entries that are pending or failed (with < 5 attempts)
 * and re-queues them through the /process pipeline.
 */

import { makeSupabase } from '../lib/supabase.js';

export async function handleScheduled(event, env, ctx) {
  const db = makeSupabase(env);

  // FIX (bug): the original query sent `or` and `tagging_attempts` as two
  // separate top-level params. PostgREST ANDs all top-level params, so the
  // attempts limit was applied to ALL rows, not just the 'failed' branch.
  // More importantly, the `or` string was passed as a plain key=value param
  // rather than using PostgREST's `or=()` syntax correctly.
  //
  // Correct query: entries where
  //   tagging_status = 'pending'
  //   OR (tagging_status = 'failed' AND tagging_attempts < 5)
  //
  // PostgREST doesn't support nested AND inside OR via query params alone,
  // so we fetch both buckets separately and deduplicate.
  const [pending, failed] = await Promise.all([
    db.select('entries', {
      tagging_status: 'eq.pending',
      limit:          10,
    }),
    db.select('entries', {
      tagging_status:   'eq.failed',
      tagging_attempts: 'lt.5',
      limit:            10,
    }),
  ]);

  // Deduplicate by id in case an entry somehow matches both
  const seen    = new Set();
  const entries = [...pending, ...failed].filter(e => {
    if (seen.has(e.id)) return false;
    seen.add(e.id);
    return true;
  });

  if (entries.length === 0) {
    console.log('[tagging] No entries needing tagging.');
    return;
  }

  console.log(`[tagging] Found ${entries.length} entries to process.`);

  for (const entry of entries) {
    const processUrl = `${env.WORKER_SELF_URL || 'http://localhost'}/process/${entry.id}`;

    ctx.waitUntil((async () => {
      try {
        // FIX (security): include X-Internal-Secret on all /process self-calls
        const res = await fetch(processUrl, {
          method:  'POST',
          headers: {
            'Content-Type':      'application/json',
            'X-Internal-Secret': env.PROCESS_SECRET ?? '',
          },
          body: JSON.stringify({ trigger: 'cron' }),
        });
        if (!res.ok)
          console.warn(`[tagging] Failed to trigger process for ${entry.id}: ${res.status}`);
      } catch (err) {
        console.error(`[tagging] Error triggering process for ${entry.id}:`, err.message);
      }
    })());
  }
}
