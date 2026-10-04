-- Baseline schema for RecoverDesk (project qxtevnkrbcfemyysvrzs).
--
-- Captures the objects that existed before the later migrations: tables, keys,
-- base indexes, RLS enablement, the policies that are still in force, the
-- profile-on-signup trigger and the updated_at triggers. Later migrations then
-- add grants, constraints, the audit/guard triggers and the RPCs, so applying
-- every file in filename order rebuilds the production schema from scratch.
--
-- Safe to re-run: every statement is idempotent.
--
-- The live project already has all of this. Do NOT replay it there; mark it applied:
--   supabase migration repair --status applied 20261002000000
--
-- Requires Supabase's `auth` schema (auth.users, auth.uid()).

-- ---------------------------------------------------------------- profiles
create table if not exists public.profiles (
  id           uuid primary key references auth.users (id) on delete cascade,
  full_name    text,
  company_name text,
  avatar_url   text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- ---------------------------------------------------------------- recovery_cases
create table if not exists public.recovery_cases (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null references auth.users (id) on delete cascade,
  title       text not null,
  description text,
  status      text not null default 'open',
  priority    text not null default 'normal',
  source      text,
  assigned_to uuid references auth.users (id) on delete set null,
  due_at      timestamptz,
  resolved_at timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint recovery_cases_status_check
    check (status = any (array['open', 'in_progress', 'resolved', 'closed'])),
  constraint recovery_cases_priority_check
    check (priority = any (array['low', 'normal', 'high', 'urgent']))
);

-- ---------------------------------------------------------------- case_events
create table if not exists public.case_events (
  id         uuid primary key default gen_random_uuid(),
  case_id    uuid not null references public.recovery_cases (id) on delete cascade,
  actor_id   uuid references auth.users (id) on delete set null,
  event_type text not null,
  message    text,
  metadata   jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------- base indexes
create index if not exists recovery_cases_owner_id_idx    on public.recovery_cases (owner_id);
create index if not exists recovery_cases_assigned_to_idx on public.recovery_cases (assigned_to);
create index if not exists recovery_cases_status_idx      on public.recovery_cases (status);
create index if not exists case_events_case_id_idx        on public.case_events (case_id);
create index if not exists case_events_actor_id_idx       on public.case_events (actor_id);
create index if not exists case_events_created_at_idx     on public.case_events (created_at);

-- ---------------------------------------------------------------- updated_at maintenance
create or replace function public.set_updated_at()
returns trigger language plpgsql set search_path = 'public' as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists profiles_set_updated_at on public.profiles;
create trigger profiles_set_updated_at before update on public.profiles
  for each row execute function public.set_updated_at();

drop trigger if exists recovery_cases_set_updated_at on public.recovery_cases;
create trigger recovery_cases_set_updated_at before update on public.recovery_cases
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------- profile on signup
-- Hardened (security definer, empty search_path) by the next migration; the
-- definition here is the same so the trigger can be created first.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, full_name)
  values (new.id, coalesce(new.raw_user_meta_data ->> 'full_name', ''))
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------- row level security
alter table public.profiles       enable row level security;
alter table public.recovery_cases enable row level security;
alter table public.case_events    enable row level security;

-- profiles: a user sees and edits only their own row
drop policy if exists profiles_select_own on public.profiles;
create policy profiles_select_own on public.profiles
  for select to authenticated using ((select auth.uid()) = id);

drop policy if exists profiles_insert_own on public.profiles;
create policy profiles_insert_own on public.profiles
  for insert to authenticated with check ((select auth.uid()) = id);

drop policy if exists profiles_update_own on public.profiles;
create policy profiles_update_own on public.profiles
  for update to authenticated
  using ((select auth.uid()) = id) with check ((select auth.uid()) = id);

-- recovery_cases: owners and assignees read/update; only owners create (as themselves).
-- There is deliberately no DELETE policy: cases are a permanent record.
drop policy if exists cases_select_owned_or_assigned on public.recovery_cases;
create policy cases_select_owned_or_assigned on public.recovery_cases
  for select to authenticated
  using ((select auth.uid()) = owner_id or (select auth.uid()) = assigned_to);

drop policy if exists cases_insert_owned on public.recovery_cases;
create policy cases_insert_owned on public.recovery_cases
  for insert to authenticated with check ((select auth.uid()) = owner_id);

drop policy if exists cases_update_owned_or_assigned on public.recovery_cases;
create policy cases_update_owned_or_assigned on public.recovery_cases
  for update to authenticated
  using ((select auth.uid()) = owner_id or (select auth.uid()) = assigned_to)
  with check ((select auth.uid()) = owner_id or (select auth.uid()) = assigned_to);

-- case_events: readable by anyone with access to the case. Writes come only from
-- the log_case_events() trigger (security definer); clients get no write policy.
drop policy if exists events_select_case_access on public.case_events;
create policy events_select_case_access on public.case_events
  for select to authenticated
  using (exists (
    select 1 from public.recovery_cases c
    where c.id = case_events.case_id
      and ((select auth.uid()) = c.owner_id or (select auth.uid()) = c.assigned_to)
  ));
