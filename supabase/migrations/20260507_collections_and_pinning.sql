-- Migration: Collections and Pinning
-- Adds manual organization and pinning support

-- 1. Add is_pinned to entries
ALTER TABLE entries 
ADD COLUMN IF NOT EXISTS is_pinned boolean DEFAULT false;

-- 2. Create collections table
CREATE TABLE IF NOT EXISTS collections (
    id            uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    name          text NOT NULL,
    user_id       text NOT NULL, -- references auth.uid()::text
    family_id     uuid REFERENCES families(id) ON DELETE CASCADE,
    sharing_scope text DEFAULT 'private', -- 'private', 'family'
    created_at    timestamptz DEFAULT now(),
    updated_at    timestamptz DEFAULT now()
);

-- 3. Add collection_id to entries
ALTER TABLE entries
ADD COLUMN IF NOT EXISTS collection_id uuid REFERENCES collections(id) ON DELETE SET NULL;

-- 4. Enable RLS on collections
ALTER TABLE collections ENABLE ROW LEVEL SECURITY;

-- 5. RLS Policies for collections
DROP POLICY IF EXISTS "collections_read" ON collections;
CREATE POLICY "collections_read" ON collections
    FOR SELECT
    USING (
        user_id = auth.uid()::text
        OR (
            sharing_scope = 'family'
            AND family_id IN (
                SELECT family_id FROM family_members WHERE user_id = auth.uid()
            )
        )
    );

DROP POLICY IF EXISTS "collections_insert" ON collections;
CREATE POLICY "collections_insert" ON collections
    FOR INSERT
    WITH CHECK (auth.uid() IS NOT NULL AND (user_id = auth.uid()::text OR user_id IS NULL));

DROP POLICY IF EXISTS "collections_update" ON collections;
CREATE POLICY "collections_update" ON collections
    FOR UPDATE
    USING (user_id = auth.uid()::text);

DROP POLICY IF EXISTS "collections_delete" ON collections;
CREATE POLICY "collections_delete" ON collections
    FOR DELETE
    USING (user_id = auth.uid()::text);

-- 6. Indices
CREATE INDEX IF NOT EXISTS entries_is_pinned_idx ON entries(is_pinned);
CREATE INDEX IF NOT EXISTS entries_collection_id_idx ON entries(collection_id);
CREATE INDEX IF NOT EXISTS collections_user_id_idx ON collections(user_id);
CREATE INDEX IF NOT EXISTS collections_family_id_idx ON collections(family_id);

-- 7. updated_at trigger for collections
DROP TRIGGER IF EXISTS collections_updated_at ON collections;
CREATE TRIGGER collections_updated_at
  BEFORE UPDATE ON collections
  FOR EACH ROW EXECUTE PROCEDURE set_updated_at();
