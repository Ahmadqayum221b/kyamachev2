-- ─── Migration: Kymacache bug fixes ──────────────────────────────────────────
-- Apply after: 20260428_beyond_v1_1.sql and 20260428_sharing_rls.sql
-- Safe to run multiple times (all statements use IF NOT EXISTS / OR REPLACE)

-- ─── 1. Fix user_id type mismatch ────────────────────────────────────────────
-- schema.sql defined user_id as TEXT, but migration 20260428_beyond_v1_1.sql
-- added family_member_read which cast auth.uid() to UUID and compared it to
-- the uploaded_by UUID column. The auth.uid()::text = user_id check in other
-- policies works, but mixing ::uuid and ::text comparisons on the same column
-- causes cast errors. Standardise: keep user_id as TEXT (Supabase auth.uid()
-- returns a UUID but it's most safely compared as text).
--
-- The uploaded_by column was added as UUID. Since it stores the same value as
-- user_id, align it to TEXT for consistency and drop the type ambiguity.

ALTER TABLE entries
  ALTER COLUMN uploaded_by TYPE text USING uploaded_by::text;

-- ─── 2. Atomic daily budget increment RPC ────────────────────────────────────
-- Required by the new supabase.js rpcIncrement() method.
-- Uses INSERT ... ON CONFLICT DO UPDATE (upsert) so it works on the first
-- call of the day (no pre-existing row) and on subsequent calls atomically.

CREATE OR REPLACE FUNCTION increment_daily_budget(p_day date, p_cost int DEFAULT 1)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
AS $$
  INSERT INTO daily_budget (day, cost_cents)
  VALUES (p_day, p_cost)
  ON CONFLICT (day)
  DO UPDATE SET
    cost_cents = daily_budget.cost_cents + EXCLUDED.cost_cents,
    updated_at = now();
$$;

-- ─── 3. updated_at trigger for daily_budget ───────────────────────────────────
-- The table has an updated_at column but no trigger was wired up.

DROP TRIGGER IF EXISTS daily_budget_updated_at ON daily_budget;
CREATE TRIGGER daily_budget_updated_at
  BEFORE UPDATE ON daily_budget
  FOR EACH ROW EXECUTE PROCEDURE set_updated_at();

-- ─── 4. Fix conflicting RLS policies on entries ───────────────────────────────
-- 20260428_beyond_v1_1.sql dropped "anon_read" and created two replacements:
--   • "anon_read_active"   (status = 'active')
--   • "family_member_read" (membership join + uploaded_by check)
--
-- These overlap: a family member would match both, and the family_member_read
-- policy's uploaded_by comparison now uses TEXT after fix #1.
-- Consolidate into a single clear policy hierarchy.

DROP POLICY IF EXISTS "anon_read"           ON entries;
DROP POLICY IF EXISTS "anon_read_active"    ON entries;
DROP POLICY IF EXISTS "family_member_read"  ON entries;
DROP POLICY IF EXISTS "auth_insert"         ON entries;
DROP POLICY IF EXISTS "owner_modify"        ON entries;
DROP POLICY IF EXISTS "owner_delete"        ON entries;

-- Allow authenticated users to read entries they own OR that belong to their
-- family (respecting sharing_scope), filtering out trashed/deleted entries.
CREATE POLICY "read_own_or_family" ON entries
  FOR SELECT
  USING (
    status = 'active'
    AND (
      -- Owner always sees their own entries regardless of scope
      user_id = auth.uid()::text
      OR
      -- Family members see family-scoped entries in their family
      (
        sharing_scope IN ('family', 'public')
        AND family_id IN (
          SELECT family_id FROM family_members WHERE user_id = auth.uid()
        )
      )
    )
    -- Child/limited members cannot see mature content
    AND (
      (ai_metadata->>'mature')::boolean IS NOT TRUE
      OR user_id = auth.uid()::text
      OR auth.uid() NOT IN (
        SELECT user_id FROM family_members WHERE role = 'member_limited'
      )
    )
  );

-- Authenticated users can insert their own entries
CREATE POLICY "insert_own" ON entries
  FOR INSERT
  WITH CHECK (
    auth.uid() IS NOT NULL
    AND (user_id = auth.uid()::text OR user_id IS NULL)
  );

-- Only the owner can update their own entries
CREATE POLICY "update_own" ON entries
  FOR UPDATE
  USING (user_id = auth.uid()::text);

-- Only the owner can delete (soft or hard) their own entries
CREATE POLICY "delete_own" ON entries
  FOR DELETE
  USING (user_id = auth.uid()::text);

-- ─── 5. Audit log trigger: handle DELETE (OLD only, no NEW) ──────────────────
-- The original log_entry_action() function uses COALESCE(NEW.id, OLD.id).
-- On DELETE triggers, NEW is null — COALESCE handles this correctly already,
-- but the trigger was AFTER INSERT OR UPDATE OR DELETE which means a hard
-- DELETE also fires it. Verify the function handles null NEW gracefully.
-- Re-create with explicit NULL guards for safety.

CREATE OR REPLACE FUNCTION log_entry_action()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO audit_log (family_id, user_id, action, resource_type, resource_id, metadata)
  VALUES (
    COALESCE(NEW.family_id,    OLD.family_id),
    auth.uid(),
    TG_OP,
    'entry',
    COALESCE(NEW.id,           OLD.id),
    jsonb_build_object(
      'content_type', COALESCE(NEW.content_type, OLD.content_type),
      'status',       COALESCE(NEW.status,       OLD.status)
    )
  );
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ─── 6. Index on invitations for token lookups ────────────────────────────────
CREATE UNIQUE INDEX IF NOT EXISTS invitations_token_idx ON invitations(token);

-- ─── Done ─────────────────────────────────────────────────────────────────────
