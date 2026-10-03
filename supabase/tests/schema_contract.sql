-- Read-only. Run in the Supabase SQL editor to confirm the live database has every object app.js depends on.
-- Every row should show ok = true. Safe to run repeatedly (changes nothing).
select 'table recovery_cases'  as object, to_regclass('public.recovery_cases') is not null as ok
union all select 'table case_events',     to_regclass('public.case_events') is not null
union all select 'table profiles',        to_regclass('public.profiles') is not null
union all select 'rpc assign_case',       exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='assign_case')
union all select 'rpc case_people',       exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='case_people')
union all select 'trigger recovery_cases_guard', exists (select 1 from pg_trigger where tgrelid='public.recovery_cases'::regclass and tgname='recovery_cases_guard' and not tgisinternal)
union all select 'event-writing trigger(s) on recovery_cases (need >= 2: insert + update)',
       (select count(*) from pg_trigger where tgrelid='public.recovery_cases'::regclass and not tgisinternal and tgname <> 'recovery_cases_guard') >= 2
union all select 'RLS enabled: ' || c.relname, c.relrowsecurity
  from pg_class c join pg_namespace n on n.oid=c.relnamespace
  where n.nspname='public' and c.relname in ('recovery_cases','case_events','profiles')
union all select 'anon has no privileges on public tables',
       not exists (select 1 from information_schema.role_table_grants where grantee='anon' and table_schema='public' and table_name in ('recovery_cases','case_events','profiles'));
