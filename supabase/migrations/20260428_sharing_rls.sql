-- ── Role-Based Access Control (RBAC) ──────────────────────────────────────────

-- Enable RLS on all relevant tables
ALTER TABLE families ENABLE ROW LEVEL SECURITY;
ALTER TABLE family_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE entries ENABLE ROW LEVEL SECURITY;

-- ── Families ────────────────────────────────────────────────────────────────
-- Users can see families they are a member of
CREATE POLICY "Users can view their own families" 
ON families FOR SELECT 
USING (
  id IN (SELECT family_id FROM family_members WHERE user_id = auth.uid())
);

-- Only owners can update family settings
CREATE POLICY "Owners can update family" 
ON families FOR UPDATE 
USING (
  id IN (SELECT family_id FROM family_members WHERE user_id = auth.uid() AND role = 'owner')
);

-- ── Family Members ──────────────────────────────────────────────────────────
-- Users can see members of their own families
CREATE POLICY "Members can view family roster" 
ON family_members FOR SELECT 
USING (
  family_id IN (SELECT family_id FROM family_members WHERE user_id = auth.uid())
);

-- Only owners and admins can invite/remove members
CREATE POLICY "Admins can manage members" 
ON family_members FOR ALL 
USING (
  family_id IN (SELECT family_id FROM family_members WHERE user_id = auth.uid() AND role IN ('owner', 'admin'))
);

-- ── Entries ─────────────────────────────────────────────────────────────────
-- 1. Owners/Admins/Adult Members can see everything in the family
CREATE POLICY "Members can view family entries" 
ON entries FOR SELECT 
USING (
  family_id IN (SELECT family_id FROM family_members WHERE user_id = auth.uid())
  AND (
    -- If it's private, only the owner sees it
    (sharing_scope = 'private' AND user_id = auth.uid()::text)
    OR (sharing_scope = 'family')
    OR (sharing_scope = 'public')
  )
);

-- 2. Limited members (kids) can only see non-mature family content
CREATE POLICY "Limited members view restricted family entries" 
ON entries FOR SELECT 
USING (
  family_id IN (SELECT family_id FROM family_members WHERE user_id = auth.uid() AND role = 'member_limited')
  AND sharing_scope = 'family'
  AND (ai_metadata->>'mature')::boolean IS NOT TRUE
);

-- 3. Users can manage their own entries
CREATE POLICY "Users can manage own entries" 
ON entries FOR ALL 
USING (user_id = auth.uid()::text);


-- ── Audit Logging ───────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION log_entry_action() 
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO audit_log (family_id, user_id, action, resource_type, resource_id, metadata)
  VALUES (
    COALESCE(NEW.family_id, OLD.family_id),
    auth.uid(),
    TG_OP,
    'entry',
    COALESCE(NEW.id, OLD.id),
    jsonb_build_object('content_type', COALESCE(NEW.content_type, OLD.content_type))
  );
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER audit_entries_trigger
AFTER INSERT OR UPDATE OR DELETE ON entries
FOR EACH ROW EXECUTE FUNCTION log_entry_action();

-- ── Family Invitation Table ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS invitations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  family_id UUID REFERENCES families(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  role TEXT DEFAULT 'member',
  invited_by UUID REFERENCES auth.users(id),
  token TEXT UNIQUE NOT NULL,
  expires_at TIMESTAMP WITH TIME ZONE DEFAULT (now() + interval '7 days'),
  accepted_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT now()
);

ALTER TABLE invitations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins can manage invitations" 
ON invitations FOR ALL 
USING (
  family_id IN (SELECT family_id FROM family_members WHERE user_id = auth.uid() AND role IN ('owner', 'admin'))
);
