-- Migration for Kymacache Beyond v1.1 Features

-- ─── New Tables ──────────────────────────────────────────────────────────────

-- Families / Households
create table if not exists families (
  id            uuid primary key default uuid_generate_v4(),
  name          text not null,
  owner_id      uuid not null,
  created_at    timestamptz default now()
);

-- Family Members
create table if not exists family_members (
  family_id     uuid references families(id) on delete cascade,
  user_id       uuid not null,
  role          text not null default 'member', -- 'owner', 'adult', 'child'
  display_name  text,
  joined_at     timestamptz default now(),
  primary key (family_id, user_id)
);

-- Daily AI Budget Tracking
create table if not exists daily_budget (
  day           date primary key default current_date,
  tokens_spent  bigint default 0,
  cost_cents    int default 0,
  updated_at    timestamptz default now()
);

-- User Tag Preferences (Training Feedback)
create table if not exists user_tag_preferences (
  id            uuid primary key default uuid_generate_v4(),
  user_id       uuid not null,
  entry_id      uuid references entries(id) on delete cascade,
  label         text not null,
  vote          int not null, -- 1 for "more like this", -1 for "not relevant"
  created_at    timestamptz default now()
);

-- Audit Log
create table if not exists audit_log (
  id            uuid primary key default uuid_generate_v4(),
  family_id     uuid references families(id),
  user_id       uuid,
  action        text not null,
  resource_type text,
  resource_id   uuid,
  metadata      jsonb,
  created_at    timestamptz default now()
);

-- OAuth Connections
create table if not exists oauth_connections (
  id            uuid primary key default uuid_generate_v4(),
  user_id       uuid not null,
  provider      text not null, -- 'google', 'dropbox', 'onedrive'
  access_token  text not null, -- Should be encrypted
  refresh_token text,          -- Should be encrypted
  expires_at    timestamptz,
  metadata      jsonb,
  created_at    timestamptz default now()
);

-- ─── Update Entries Table ────────────────────────────────────────────────────

alter table entries
  add column if not exists content_hash      text,
  add column if not exists phash             bigint,
  add column if not exists is_duplicate_of   uuid references entries(id),
  add column if not exists thumbnail_url     text,
  add column if not exists last_tagged_at    timestamptz,
  add column if not exists tagging_status    text default 'pending', -- 'pending', 'tagging', 'tagged', 'failed'
  add column if not exists tagging_attempts  int default 0,
  add column if not exists uploaded_by       uuid,
  add column if not exists family_id         uuid references families(id),
  add column if not exists sharing_scope     text default 'family', -- 'family', 'private', 'public'
  add column if not exists status            text default 'active', -- 'active', 'trashed', 'deleted'
  add column if not exists is_starred         boolean default false,
  add column if not exists trashed_at        timestamptz;

-- Add indexes for new columns
create index if not exists entries_content_hash_idx on entries(content_hash);
create index if not exists entries_phash_idx on entries(phash);
create index if not exists entries_family_id_idx on entries(family_id);
create index if not exists entries_status_idx on entries(status);
create index if not exists entries_tagging_status_idx on entries(tagging_status);

-- ─── Row Level Security Updates ──────────────────────────────────────────────

-- Enable RLS on new tables
alter table families enable row level security;
alter table family_members enable row level security;
alter table audit_log enable row level security;

-- Example Policies (simplified, needs adjustment based on auth setup)
-- Only family members can see family data
create policy "family_member_read" on entries
  for select using (
    auth.uid()::uuid = uploaded_by or 
    family_id in (select family_id from family_members where user_id = auth.uid()::uuid)
  );

-- Update existing policies to respect soft delete
drop policy if exists "anon_read" on entries;
create policy "anon_read_active" on entries 
  for select using (status = 'active');
