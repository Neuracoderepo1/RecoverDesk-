-- Applied to project qxtevnkrbcfemyysvrzs on 2026-10-03.
-- 1. Signup trigger must run as definer, otherwise supabase_auth_admin cannot write profiles.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, full_name)
  values (new.id, coalesce(new.raw_user_meta_data ->> 'full_name', ''))
  on conflict (id) do nothing;
  return new;
end;
$$;
revoke execute on function public.handle_new_user() from public, anon, authenticated;

-- 2. Least-privilege grants (RLS does not cover TRUNCATE/REFERENCES/TRIGGER; anon needs nothing).
revoke all on public.profiles, public.recovery_cases, public.case_events from anon;
revoke all on public.profiles, public.recovery_cases, public.case_events from authenticated;
grant select, insert, update on public.profiles to authenticated;
grant select, insert, update, delete on public.recovery_cases to authenticated;
grant select, insert on public.case_events to authenticated; -- event trail is append-only

-- 3. Ownership guard: owner immutable, only the owner may change assignment.
create or replace function public.guard_case_update()
returns trigger language plpgsql security invoker set search_path = '' as $$
declare uid uuid := auth.uid();
begin
  if uid is null then return new; end if;
  if new.owner_id is distinct from old.owner_id then
    raise exception 'owner_id is immutable' using errcode = '42501';
  end if;
  if new.assigned_to is distinct from old.assigned_to and uid <> old.owner_id then
    raise exception 'only the owner can change assignment' using errcode = '42501';
  end if;
  return new;
end;
$$;
revoke execute on function public.guard_case_update() from public, anon, authenticated;
drop trigger if exists recovery_cases_guard on public.recovery_cases;
create trigger recovery_cases_guard before update on public.recovery_cases
  for each row execute function public.guard_case_update();

-- 4. Indexes backing the RLS predicates.
create index if not exists recovery_cases_owner_idx on public.recovery_cases (owner_id);
create index if not exists recovery_cases_assigned_idx on public.recovery_cases (assigned_to) where assigned_to is not null;
create index if not exists case_events_case_idx on public.case_events (case_id, created_at desc);
