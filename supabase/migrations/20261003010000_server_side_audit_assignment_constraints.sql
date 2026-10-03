-- Constraints, server-written audit trail, assignment RPCs (applied to production 2026-10-03).
alter table public.recovery_cases
  add constraint recovery_cases_title_len check (char_length(btrim(title)) between 1 and 200),
  add constraint recovery_cases_desc_len check (description is null or char_length(description) <= 5000),
  add constraint recovery_cases_source_len check (source is null or char_length(source) <= 100);
alter table public.case_events
  add constraint case_events_message_len check (message is null or char_length(message) <= 1000);

-- Cases are a permanent record: no client deletes. Events are written only by the server.
drop policy if exists cases_delete_owned on public.recovery_cases;
drop policy if exists events_insert_case_access on public.case_events;
revoke delete on public.recovery_cases from authenticated;
revoke insert, update, delete, truncate on public.case_events from authenticated;
grant select on public.case_events to authenticated;

create or replace function public.log_case_events()
returns trigger language plpgsql security definer set search_path = '' as $$
declare uid uuid := auth.uid();
begin
  if tg_op = 'INSERT' then
    insert into public.case_events(case_id, actor_id, event_type, message, metadata)
    values (new.id, uid, 'case_created', 'Case created', jsonb_build_object('priority', new.priority));
    return new;
  end if;
  if new.status is distinct from old.status then
    insert into public.case_events(case_id, actor_id, event_type, message, metadata)
    values (new.id, uid, 'status_changed', 'Status changed to '||new.status, jsonb_build_object('from', old.status, 'to', new.status));
  end if;
  if new.priority is distinct from old.priority then
    insert into public.case_events(case_id, actor_id, event_type, message, metadata)
    values (new.id, uid, 'priority_changed', 'Priority changed to '||new.priority, jsonb_build_object('from', old.priority, 'to', new.priority));
  end if;
  if new.assigned_to is distinct from old.assigned_to then
    insert into public.case_events(case_id, actor_id, event_type, message, metadata)
    values (new.id, uid, case when new.assigned_to is null then 'unassigned' else 'assigned' end,
            case when new.assigned_to is null then 'Case unassigned' else 'Case assigned' end, '{}'::jsonb);
  end if;
  return new;
end;
$$;
revoke execute on function public.log_case_events() from public, anon, authenticated;
drop trigger if exists recovery_cases_log_ins on public.recovery_cases;
drop trigger if exists recovery_cases_log_upd on public.recovery_cases;
create trigger recovery_cases_log_ins after insert on public.recovery_cases for each row execute function public.log_case_events();
create trigger recovery_cases_log_upd after update on public.recovery_cases for each row execute function public.log_case_events();

create or replace function public.assign_case(p_case uuid, p_email text)
returns boolean language plpgsql security definer set search_path = '' as $$
declare uid uuid := auth.uid(); target uuid;
begin
  if uid is null then raise exception 'not authenticated' using errcode='42501'; end if;
  if not exists (select 1 from public.recovery_cases where id = p_case and owner_id = uid) then
    raise exception 'only the owner can assign this case' using errcode='42501';
  end if;
  if p_email is null or btrim(p_email) = '' then
    update public.recovery_cases set assigned_to = null where id = p_case;
    return true;
  end if;
  select id into target from auth.users where lower(email) = lower(btrim(p_email)) limit 1;
  if target is null then return false; end if;
  update public.recovery_cases set assigned_to = target where id = p_case;
  return true;
end;
$$;
revoke execute on function public.assign_case(uuid, text) from public, anon;
grant execute on function public.assign_case(uuid, text) to authenticated;

create or replace function public.case_people(p_cases uuid[])
returns table(case_id uuid, owner_email text, assignee_email text)
language sql stable security definer set search_path = '' as $$
  select c.id, o.email::text, a.email::text
  from public.recovery_cases c
  join auth.users o on o.id = c.owner_id
  left join auth.users a on a.id = c.assigned_to
  where c.id = any(p_cases) and (c.owner_id = auth.uid() or c.assigned_to = auth.uid());
$$;
revoke execute on function public.case_people(uuid[]) from public, anon;
grant execute on function public.case_people(uuid[]) to authenticated;
