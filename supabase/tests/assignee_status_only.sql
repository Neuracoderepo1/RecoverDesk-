-- Run after applying 20261003100000_assignee_status_only.sql. Always rolls back; results appear in the error text.
-- Expected: assignee status change OK; every other assignee edit denied; owner edits still work.
do $$
declare
  a uuid := gen_random_uuid(); c uuid := gen_random_uuid(); cid uuid; n int; res text := '';
begin
  insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
  select x,'00000000-0000-0000-0000-000000000000','authenticated','authenticated',x||'@t.test','{}'::jsonb,now(),now() from unnest(array[a,c]) x;
  perform set_config('request.jwt.claims', json_build_object('sub',a,'role','authenticated')::text, true);
  set local role authenticated;
  insert into recovery_cases(owner_id,title) values (a,'A case') returning id into cid;
  update recovery_cases set assigned_to=c where id=cid;
  update recovery_cases set priority='high', title='A case 2' where id=cid; get diagnostics n=row_count; res := res||'owner edits priority+title: '||n||E' (want 1)\n';
  perform set_config('request.jwt.claims', json_build_object('sub',c,'role','authenticated')::text, true);
  update recovery_cases set status='in_progress' where id=cid; get diagnostics n=row_count; res := res||'assignee status: '||n||E' (want 1)\n';
  begin update recovery_cases set priority='low' where id=cid; res := res||E'assignee priority: BAD\n'; exception when others then res := res||E'assignee priority: OK\n'; end;
  begin update recovery_cases set title='hijack' where id=cid; res := res||E'assignee title: BAD\n'; exception when others then res := res||E'assignee title: OK\n'; end;
  begin update recovery_cases set description='x' where id=cid; res := res||E'assignee description: BAD\n'; exception when others then res := res||E'assignee description: OK\n'; end;
  begin update recovery_cases set due_at=now() where id=cid; res := res||E'assignee due date: BAD\n'; exception when others then res := res||E'assignee due date: OK\n'; end;
  begin update recovery_cases set assigned_to=a where id=cid; res := res||E'assignee reassign: BAD\n'; exception when others then res := res||E'assignee reassign: OK\n'; end;
  raise exception E'RESULTS\n%', res;
end $$;
