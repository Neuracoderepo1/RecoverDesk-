-- Run in the Supabase SQL editor. Always rolls back (raises at the end); results appear in the error text.
-- Expected: every line ends "OK" or matches its (want N).
do $$
declare
  a uuid := gen_random_uuid(); b uuid := gen_random_uuid(); c uuid := gen_random_uuid();
  cid uuid; n int; res text := '';
begin
  insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
  select x,'00000000-0000-0000-0000-000000000000','authenticated','authenticated',x||'@t.test','{}'::jsonb,now(),now() from unnest(array[a,b,c]) x;
  perform set_config('request.jwt.claims', json_build_object('sub',a,'role','authenticated')::text, true);
  set local role authenticated;
  insert into recovery_cases(owner_id,title) values (a,'A case') returning id into cid;
  perform set_config('request.jwt.claims', json_build_object('sub',b,'role','authenticated')::text, true);
  select count(*) into n from recovery_cases; res := res||'B sees A cases: '||n||E' (want 0)\n';
  update recovery_cases set title='x' where id=cid; get diagnostics n=row_count; res := res||'B update: '||n||E' (want 0)\n';
  delete from recovery_cases where id=cid; get diagnostics n=row_count; res := res||'B delete: '||n||E' (want 0)\n';
  begin insert into recovery_cases(owner_id,title) values (a,'spoof'); res := res||E'B spoof owner: BAD\n'; exception when others then res := res||E'B spoof owner: OK\n'; end;
  begin insert into case_events(case_id,actor_id,event_type) values (cid,b,'note'); res := res||E'B event on A case: BAD\n'; exception when others then res := res||E'B event on A case: OK\n'; end;
  perform set_config('request.jwt.claims', json_build_object('sub',a,'role','authenticated')::text, true);
  begin insert into case_events(case_id,actor_id,event_type) values (cid,b,'note'); res := res||E'A forges actor: BAD\n'; exception when others then res := res||E'A forges actor: OK\n'; end;
  begin update case_events set message='edit'; res := res||E'event update: BAD\n'; exception when others then res := res||E'event update denied: OK\n'; end;
  update recovery_cases set assigned_to=c where id=cid;
  perform set_config('request.jwt.claims', json_build_object('sub',c,'role','authenticated')::text, true);
  select count(*) into n from recovery_cases; res := res||'assignee sees: '||n||E' (want 1)\n';
  begin update recovery_cases set owner_id=c where id=cid; res := res||E'assignee takes owner: BAD\n'; exception when others then res := res||E'assignee takes owner: OK\n'; end;
  begin update recovery_cases set assigned_to=b where id=cid; res := res||E'assignee reassigns: BAD\n'; exception when others then res := res||E'assignee reassigns: OK\n'; end;
  delete from recovery_cases where id=cid; get diagnostics n=row_count; res := res||'assignee delete: '||n||E' (want 0)\n';
  reset role; set local role anon;
  begin perform 1 from recovery_cases; res := res||E'anon select: BAD\n'; exception when others then res := res||E'anon select: OK\n'; end;
  reset role; set local role authenticated;
  begin truncate recovery_cases cascade; res := res||E'TRUNCATE: BAD\n'; exception when others then res := res||E'TRUNCATE denied: OK\n'; end;
  raise exception E'RESULTS\n%', res;
end $$;
