-- Read-only. Run in the Supabase SQL editor on the LIVE project and paste the result back.
-- Purpose: capture objects that exist in production but are not yet in supabase/migrations/
-- (assign_case, case_people, case_events triggers, RLS policies) so the schema can be rebuilt on a staging project.
select 'function' as kind, p.proname as name, pg_get_functiondef(p.oid) as definition
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
union all
select 'trigger', t.tgname, pg_get_triggerdef(t.oid)
from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
where not t.tgisinternal and n.nspname = 'public'
union all
select 'trigger on auth.users', t.tgname, pg_get_triggerdef(t.oid)
from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_namespace n on n.oid = c.relnamespace
where not t.tgisinternal and n.nspname = 'auth' and c.relname = 'users'
union all
select 'policy', pol.polname || ' on ' || c.relname,
  'cmd=' || pol.polcmd || E'\nUSING: ' || coalesce(pg_get_expr(pol.polqual, pol.polrelid), '-') ||
  E'\nCHECK: ' || coalesce(pg_get_expr(pol.polwithcheck, pol.polrelid), '-')
from pg_policy pol join pg_class c on c.oid = pol.polrelid join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
union all
select 'table ' || c.relname, a.attname,
  format_type(a.atttypid, a.atttypmod) || case when a.attnotnull then ' not null' else '' end ||
  coalesce(' default ' || pg_get_expr(d.adbin, d.adrelid), '')
from pg_class c join pg_namespace n on n.oid = c.relnamespace
join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
left join pg_attrdef d on d.adrelid = c.oid and d.adnum = a.attnum
where n.nspname = 'public' and c.relkind = 'r'
order by 1, 2;
