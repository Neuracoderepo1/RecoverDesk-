-- DRAFT — NOT APPLIED. Review, then apply to staging first, then production.
-- Rule: an assignee (non-owner) may only move a case through its status lifecycle.
-- Only the owner may edit title, description, priority, source or due date, or change assignment.
-- Replaces guard_case_update() from 20261003000000_harden_rls_grants_and_signup.sql (same trigger, stricter body).
-- Columns that are NOT locked for assignees: status, resolved_at, updated_at (maintained by existing triggers).
create or replace function public.guard_case_update()
returns trigger language plpgsql security invoker set search_path = '' as $$
declare uid uuid := auth.uid();
begin
  if uid is null then return new; end if;  -- service/internal paths, unchanged from before
  if new.owner_id is distinct from old.owner_id then
    raise exception 'owner_id is immutable' using errcode = '42501';
  end if;
  if uid <> old.owner_id then
    if new.assigned_to is distinct from old.assigned_to then
      raise exception 'only the owner can change assignment' using errcode = '42501';
    end if;
    if new.title       is distinct from old.title
    or new.description is distinct from old.description
    or new.priority    is distinct from old.priority
    or new.source      is distinct from old.source
    or new.due_at      is distinct from old.due_at then
      raise exception 'assignees can only change case status' using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;
revoke execute on function public.guard_case_update() from public, anon, authenticated;
