# RecoverDesk

RecoverDesk is a focused recovery-operations workspace built around structured cases, clear ownership, and an event trail.

## Stack
Static HTML/CSS/ES modules + Supabase Auth + Supabase Postgres/RLS. No build step.

## Supabase
Project ref: `qxtevnkrbcfemyysvrzs`  
Region: `eu-central-1`

The browser uses only the Supabase publishable key. Never place a service-role or secret key in frontend code.

## Current vertical slice
- Landing page
- Email/password sign in and sign up
- Authenticated workspace
- Recovery case creation
- Priority/source capture
- Case lifecycle: open → in progress → resolved → closed
- Case event trail
- Owner-scoped reads/updates
- Responsive desktop/mobile UI

## Run
Serve the folder over HTTP, for example: `python3 -m http.server 8080`, then open `http://localhost:8080`.

## Next production layers
1. Verify exact RLS policies and cross-user isolation.
2. Add team membership and role-based assignment.
3. Add filtering/search and richer case timeline.
4. Add notifications and due-date workflows.
5. Add automated browser QA and deployment.

## Security model (verified 2026-10-03)
- RLS on all tables; owners and assignees read/update cases; only owners delete or reassign; `owner_id` is immutable (trigger).
- `case_events` is append-only and `actor_id` must equal the caller.
- `anon` has no table privileges; `authenticated` has no TRUNCATE/REFERENCES/TRIGGER.
- Migration: `supabase/migrations/`. Re-verify any time with `supabase/tests/rls_isolation.sql` (self-rolling-back).

## QA and deploy
- Browser QA: `tests/e2e/workspace.spec.mjs` (Playwright).
- Deploy: GitHub Pages via `.github/workflows/deploy.yml`. After first deploy, add the Pages URL to Supabase Auth → URL Configuration (Site URL + Redirect URLs).
