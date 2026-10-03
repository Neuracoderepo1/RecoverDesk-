# RecoverDesk architecture

Browser (static, vendored supabase-js) → Supabase Auth → Postgres/RLS.

## Tables
- `profiles` — one row per user, created by the `handle_new_user` signup trigger.
- `recovery_cases` — owned by `owner_id` (immutable); optionally `assigned_to`.
- `case_events` — append-only audit trail; `actor_id` must equal the caller.

## RPCs
- `assign_case(p_case, p_email)` — owner-only assignment; returns false when no account matches the email.
- `case_people(p_cases)` — resolves owner/assignee display info for a list of cases.

## Write path
UI action → mutation on `recovery_cases` → database trigger → `case_events` row → timeline/activity views.
The browser never inserts `case_events`.

## Access model
RLS: owners and assignees read/update cases; only owners delete or reassign. `anon` has no table privileges. Details and tests: `supabase/migrations/` and `supabase/tests/`.

## Not yet in the repo
Definitions of `assign_case`, `case_people` and the event triggers (created in the Supabase project directly). Export them to a migration.

Security note: the publishable key is intended for browser use when paired with correct RLS. Service-role credentials must never ship to the browser (CI fails if one appears).
