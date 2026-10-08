-- Over Two — multiplayer schema
-- Run this once in your Supabase project's SQL editor (Database > SQL Editor).
-- Then go to Database > Replication and make sure the "rooms" table has
-- Realtime enabled (or run the publication line at the bottom).

-- An earlier placeholder "rooms" table (id/created_at/status, no rows) exists
-- on this project with the wrong shape for this app — replace it.
drop table if exists rooms cascade;

create table rooms (
  code text primary key,
  data jsonb not null,
  updated_at timestamptz not null default now()
);

-- keep updated_at fresh on every write (handy for later cleanup jobs)
create or replace function touch_rooms_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_touch_rooms on rooms;
create trigger trg_touch_rooms
  before update on rooms
  for each row execute function touch_rooms_updated_at();

-- This is a casual party game with no accounts, so the anon/publishable
-- key needs open read/write access to this one table. Do not reuse this
-- pattern for anything that holds real user data.
alter table rooms enable row level security;

drop policy if exists "rooms public read" on rooms;
create policy "rooms public read" on rooms for select using (true);

drop policy if exists "rooms public insert" on rooms;
create policy "rooms public insert" on rooms for insert with check (true);

drop policy if exists "rooms public update" on rooms;
create policy "rooms public update" on rooms for update using (true) with check (true);

-- Enable Realtime for this table (safe to run even if already enabled).
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and tablename = 'rooms'
  ) then
    alter publication supabase_realtime add table rooms;
  end if;
end $$;
