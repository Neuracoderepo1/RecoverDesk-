-- Assignee permission guard (applied to production 2026-10-03).
-- Assignees may run the workflow (status, priority); only the owner edits title/description/due_at/source.
-- owner_id is immutable; only the owner can change assignment. Also maintains resolved_at/updated_at.
create or replace function public.guard_case_update()
returns trigger language plpgsql security invoker set search_path = '' as $$
declare uid uuid := auth.uid();
begin
  if uid is not null then
    if new.owner_id is distinct from old.owner_id then
      raise exception 'owner_id is immutable' using errcode = '42501';
    end if;
    if new.assigned_to is distinct from old.assigned_to and uid <> old.owner_id then
      raise exception 'only the owner can change assignment' using errcode = '42501';
    end if;
    if uid <> old.owner_id and (
         new.title       is distinct from old.title
      or new.description is distinct from old.description
      or new.due_at      is distinct from old.due_at
      or new.source      is distinct from old.source) then
      raise exception 'only the owner can edit case details' using errcode = '42501';
    end if;
  end if;
  new.updated_at := now();
  if new.status in ('resolved','closed') then
    if old.status not in ('resolved','closed') or new.resolved_at is null then new.resolved_at := now(); end if;
  else
    new.resolved_at := null;
  end if;
  return new;
end;
$$;
revoke execute on function public.guard_case_update() from public, anon, authenticated;
