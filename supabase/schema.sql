-- Kymacache Supabase Schema
-- Run this once in your Supabase SQL editor or via CLI: supabase db push

create extension if not exists "uuid-ossp";
create extension if not exists "pg_trgm";

-- ─── Entries ───────────────────────────────────────────────────────────────
create table if not exists entries (
  id            uuid primary key default uuid_generate_v4(),
  user_id       text,                          -- optional auth; null = anonymous
  content       text,                          -- raw captured text / URL / note (cleared after processing)
  content_type  text default 'text',           -- 'text' | 'url' | 'file' | 'image'
  source        text,                          -- origin app / share target metadata
  file_url      text,                          -- Backblaze B2 public URL (if any)
  file_key      text,                          -- B2 object key for deletion / signed URLs
  artifact_url  text,                          -- B2 public URL for the JSON artifact

  -- AI-enriched fields (filled async by Kimi)
  ai_summary    text,
  ai_labels     text[] default '{}',
  ai_metadata   jsonb  default '{}',
  ai_status     text   default 'pending',      -- 'pending' | 'done' | 'failed'

  created_at    timestamptz default now(),
  updated_at    timestamptz default now()
);

-- Full-text search index
create index if not exists entries_fts_idx
  on entries using gin(to_tsvector('english', coalesce(content,'') || ' ' || coalesce(ai_summary,'')));

-- Trigram index for fast ILIKE / similarity search
create index if not exists entries_content_trgm_idx
  on entries using gin(content gin_trgm_ops);

-- Label array index
create index if not exists entries_labels_idx
  on entries using gin(ai_labels);

-- Updated_at trigger
create or replace function set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists entries_updated_at on entries;
create trigger entries_updated_at
  before update on entries
  for each row execute procedure set_updated_at();

-- ─── Row Level Security (optional, enable if using Supabase Auth) ──────────
alter table entries enable row level security;

-- Allow anonymous reads (remove if you want private entries)
create policy "anon_read" on entries for select using (true);

-- Authenticated users can insert
create policy "auth_insert" on entries for insert
  with check (auth.uid()::text = user_id or user_id is null);

-- Only owner can update/delete
create policy "owner_modify" on entries for update
  using (auth.uid()::text = user_id or user_id is null);

create policy "owner_delete" on entries for delete
  using (auth.uid()::text = user_id or user_id is null);

-- Service role (Worker) bypasses RLS by using the service_role key
