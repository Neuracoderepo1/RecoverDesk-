-- Self-rolling-back regression test. Run in the Supabase SQL editor or via CI (psql).
-- It always ends by raising an exception containing the report. Every line must end in OK
-- (or equal its "want"). Any "BAD" line is a failure.
do $$
declare
  a uuid:=gen_random_uuid(); b uuid:=gen_random_uuid(); c uuid:=gen_random_uuid();
  cid uuid; n int; ok boolean; r text:=''; t timestamptz;
begin
  insert into auth.users (id, instance_id, aud, role, email, raw_user_meta_data, created_at, updated_at)
  select x,'00000000-0000-0000-0000-000000000000','authenticated','authenticated',nm||'@t.test','{}'::jsonb,now(),now()
  from (values (a,'a'),(b,'b'),(c,'c')) v(x,nm);

  -- Owner A
  perform set_config('request.jwt.claims', json_build_object('sub',a,'role','authenticated')::text, true);
  set local role authenticated;
  insert into recovery_cases(owner_id,title,description,due_at) values (a,'A case','desc',now()+interval '1 day') returning id into cid;
  select count(*) into n from case_events where case_id=cid and event_type='case_created' and actor_id=a; r:=r||'owner create logs event: '||n||E' (want 1)\n';
  begin update recovery_cases set title='A renamed', description='new', due_at=now()+interval '2 day' where id=cid; r:=r||E'owner edits details: OK\n'; exception when others then r:=r||E'owner edits details: BAD\n'; end;
  begin insert into recovery_cases(owner_id,title) values (b,'spoof'); r:=r||E'owner_id spoof on insert: BAD\n'; exception when others then r:=r||E'owner_id spoof on insert blocked: OK\n'; end;
  begin update recovery_cases set owner_id=b where id=cid; r:=r||E'owner reassigns owner_id: BAD\n'; exception when others then r:=r||E'owner_id immutable: OK\n'; end;
  begin insert into case_events(case_id,actor_id,event_type) values (cid,a,'forged'); r:=r||E'forge audit event: BAD\n'; exception when others then r:=r||E'forge audit event blocked: OK\n'; end;
  begin update case_events set message='x'; r:=r||E'edit audit event: BAD\n'; exception when others then r:=r||E'edit audit event blocked: OK\n'; end;
  begin delete from recovery_cases where id=cid; r:=r||E'delete case: BAD\n'; exception when others then r:=r||E'delete case blocked: OK\n'; end;
  ok := public.assign_case(cid,'c@t.test'); r:=r||'owner assigns C: '||ok||E' (want true)\n';

  -- Stranger B
  perform set_config('request.jwt.claims', json_build_object('sub',b,'role','authenticated')::text, true);
  select count(*) into n from recovery_cases; r:=r||'B reads A cases: '||n||E' (want 0)\n';
  select count(*) into n from case_events; r:=r||'B reads A events: '||n||E' (want 0)\n';
  update recovery_cases set status='closed' where id=cid; get diagnostics n=row_count; r:=r||'B modifies A case rows: '||n||E' (want 0)\n';
  begin perform public.assign_case(cid,'b@t.test'); r:=r||E'B assigns A case: BAD\n'; exception when others then r:=r||E'B assigns A case blocked: OK\n'; end;
  select count(*) into n from case_people(array[cid]); r:=r||'B case_people leak: '||n||E' (want 0)\n';

  -- Assignee C
  perform set_config('request.jwt.claims', json_build_object('sub',c,'role','authenticated')::text, true);
  select count(*) into n from recovery_cases; r:=r||'C sees assigned case: '||n||E' (want 1)\n';
  update recovery_cases set status='in_progress' where id=cid; get diagnostics n=row_count; r:=r||'C changes status rows: '||n||E' (want 1)\n';
  update recovery_cases set priority='urgent' where id=cid; get diagnostics n=row_count; r:=r||'C changes priority rows: '||n||E' (want 1)\n';
  select count(*) into n from case_events where case_id=cid and actor_id=c and event_type in ('status_changed','priority_changed'); r:=r||'C actions audited as C: '||n||E' (want 2)\n';
  begin update recovery_cases set title='hijack' where id=cid; r:=r||E'C edits title: BAD\n'; exception when others then r:=r||E'C edits title blocked: OK\n'; end;
  begin update recovery_cases set description='hijack' where id=cid; r:=r||E'C edits description: BAD\n'; exception when others then r:=r||E'C edits description blocked: OK\n'; end;
  begin update recovery_cases set due_at=now() where id=cid; r:=r||E'C edits due_at: BAD\n'; exception when others then r:=r||E'C edits due_at blocked: OK\n'; end;
  begin update recovery_cases set source='hijack' where id=cid; r:=r||E'C edits source: BAD\n'; exception when others then r:=r||E'C edits source blocked: OK\n'; end;
  begin update recovery_cases set assigned_to=b where id=cid; r:=r||E'C reassigns: BAD\n'; exception when others then r:=r||E'C reassign blocked: OK\n'; end;
  begin update recovery_cases set owner_id=c where id=cid; r:=r||E'C takes ownership: BAD\n'; exception when others then r:=r||E'C takes ownership blocked: OK\n'; end;
  begin perform public.assign_case(cid,'c@t.test'); r:=r||E'C calls assign_case: BAD\n'; exception when others then r:=r||E'C calls assign_case blocked: OK\n'; end;
  begin delete from recovery_cases where id=cid; r:=r||E'C deletes: BAD\n'; exception when others then r:=r||E'C delete blocked: OK\n'; end;

  -- Owner still has rights after assignment
  perform set_config('request.jwt.claims', json_build_object('sub',a,'role','authenticated')::text, true);
  update recovery_cases set title='A final' where id=cid; get diagnostics n=row_count; r:=r||'owner edits after assignment rows: '||n||E' (want 1)\n';

  -- Anonymous
  reset role; set local role anon;
  begin perform 1 from recovery_cases; r:=r||E'anon reads cases: BAD\n'; exception when others then r:=r||E'anon reads cases denied: OK\n'; end;
  begin perform 1 from case_events; r:=r||E'anon reads events: BAD\n'; exception when others then r:=r||E'anon reads events denied: OK\n'; end;
  begin perform public.assign_case(cid,'x'); r:=r||E'anon assign_case: BAD\n'; exception when others then r:=r||E'anon assign_case denied: OK\n'; end;
  begin perform public.case_people(array[cid]); r:=r||E'anon case_people: BAD\n'; exception when others then r:=r||E'anon case_people denied: OK\n'; end;
  reset role; set local role authenticated;
  begin truncate recovery_cases cascade; r:=r||E'TRUNCATE: BAD\n'; exception when others then r:=r||E'TRUNCATE denied: OK\n'; end;
  raise exception E'RESULTS\n%', r;
end $$;
