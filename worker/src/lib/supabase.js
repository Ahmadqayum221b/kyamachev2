/**
 * Thin Supabase REST client (no SDK — pure fetch for Worker compatibility)
 */
export class SupabaseClient {
  constructor(url, serviceKey) {
    this.base = url.replace(/\/$/, '');
    this.key  = serviceKey;
  }

  _headers(extra = {}, userToken = null) {
    const auth   = userToken ? `Bearer ${userToken}` : `Bearer ${this.key}`;
    const apikey = userToken ? userToken : this.key;
    return {
      apikey,
      Authorization: auth,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
      ...extra,
    };
  }

  async select(table, params = {}, userToken = null) {
    const qs  = new URLSearchParams(params).toString();
    const res = await fetch(`${this.base}/rest/v1/${table}?${qs}`, {
      headers: this._headers({}, userToken),
    });
    if (!res.ok) throw new Error(`Supabase select failed: ${res.status} ${await res.text()}`);
    return res.json();
  }

  async selectOne(table, id, userToken = null) {
    const rows = await this.select(table, { id: `eq.${id}`, limit: 1 }, userToken);
    return rows[0] ?? null;
  }

  async insert(table, data, userToken = null) {
    const res = await fetch(`${this.base}/rest/v1/${table}`, {
      method:  'POST',
      headers: this._headers({}, userToken),
      body:    JSON.stringify(data),
    });
    if (!res.ok) throw new Error(`Supabase insert failed: ${res.status} ${await res.text()}`);
    const rows = await res.json();
    return Array.isArray(rows) ? rows[0] : rows;
  }

  async upsert(table, data, userToken = null) {
    const res = await fetch(`${this.base}/rest/v1/${table}`, {
      method:  'POST',
      headers: this._headers({ Prefer: 'return=representation,resolution=merge-duplicates' }, userToken),
      body:    JSON.stringify(data),
    });
    if (!res.ok) throw new Error(`Supabase upsert failed: ${res.status} ${await res.text()}`);
    const rows = await res.json();
    return Array.isArray(rows) ? rows[0] : rows;
  }

  async update(table, id, data, userToken = null) {
    const res = await fetch(`${this.base}/rest/v1/${table}?id=eq.${id}`, {
      method:  'PATCH',
      headers: this._headers({}, userToken),
      body:    JSON.stringify(data),
    });
    if (!res.ok) throw new Error(`Supabase update failed: ${res.status} ${await res.text()}`);
    const rows = await res.json();
    return Array.isArray(rows) ? rows[0] : rows;
  }

  async patch(table, filter, data, userToken = null) {
    const res = await fetch(`${this.base}/rest/v1/${table}?${filter}`, {
      method:  'PATCH',
      headers: this._headers({}, userToken),
      body:    JSON.stringify(data),
    });
    if (!res.ok) throw new Error(`Supabase patch failed: ${res.status} ${await res.text()}`);
    return true;
  }

  async delete(table, id, userToken = null) {
    const res = await fetch(`${this.base}/rest/v1/${table}?id=eq.${id}`, {
      method:  'DELETE',
      headers: this._headers({ Prefer: 'return=minimal' }, userToken),
    });
    if (!res.ok) throw new Error(`Supabase delete failed: ${res.status} ${await res.text()}`);
    return true;
  }

  /**
   * FIX (bug): atomic budget increment via Supabase RPC.
   *
   * The old pattern was: read cost_cents → add 1 → write back.
   * Under concurrent requests for the same day this is a lost-update race —
   * two writers both read the same value and both write old+1.
   *
   * This calls a Postgres function that does the increment inside a single
   * UPDATE statement, which is atomic. Add this function to your schema:
   *
   *   CREATE OR REPLACE FUNCTION increment_daily_budget(p_day date, p_cost int)
   *   RETURNS void LANGUAGE sql AS $$
   *     INSERT INTO daily_budget (day, cost_cents)
   *     VALUES (p_day, p_cost)
   *     ON CONFLICT (day)
   *     DO UPDATE SET cost_cents  = daily_budget.cost_cents + EXCLUDED.cost_cents,
   *                   updated_at = now();
   *   $$;
   */
  async rpcIncrement(table, day, costCents = 1) {
    const res = await fetch(`${this.base}/rest/v1/rpc/increment_daily_budget`, {
      method:  'POST',
      headers: this._headers(),
      body:    JSON.stringify({ p_day: day, p_cost: costCents }),
    });
    if (!res.ok) {
      // Non-fatal: log and continue. Budget tracking is best-effort.
      console.warn(`[supabase] budget rpc failed: ${res.status} ${await res.text()}`);
    }
  }

  /**
   * Full-text + label search.
   * FIX (bug): moved to Supabase's native fts() / textSearch filter instead of
   * raw ilike interpolation, which was vulnerable to PostgREST operator injection.
   * Labels are passed as a properly encoded array containment filter.
   */
  async search(table, query, labels = [], userToken = null) {
    const params = {
      order:  'created_at.desc',
      limit:  50,
      status: 'eq.active',
    };

    if (query) {
      // Use full-text search (safe — PostgREST phl parameter is quoted internally)
      params['fts'] = `phfts(english).${encodeURIComponent(query)}`;
    }
    if (labels.length > 0) {
      // cs.{label1,label2} — PostgREST array containment, values are not SQL-interpolated
      params['ai_labels'] = `cs.{${labels.map(l => l.replace(/[^a-zA-Z0-9_-]/g, '')).join(',')}}`;
    }

    return this.select(table, params, userToken);
  }
}

export function makeSupabase(env) {
  return new SupabaseClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY);
}
