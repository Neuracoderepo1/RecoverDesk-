# RecoverDesk

RecoverDesk is a focused recovery-operations workspace built around structured cases, clear ownership, and an event trail.

## Stack
Static HTML/CSS/ES modules + Supabase Auth + Supabase Postgres/RLS. No build step to deploy; `@supabase/supabase-js` is vendored in `vendor/` (see `vendor/README.md`), so there is no runtime CDN dependency.

## Supabase
Project ref: `qxtevnkrbcfemyysvrzs`  
Region: `eu-central-1`

The browser uses only the Supabase publishable key. Never place a service-role or secret key in frontend code.

## Current vertical slice

- Landing page
- Email/password sign in, sign up (confirmation link returns to the app), password reset and recovery
- Authenticated workspace with search and status/priority/ownership filters
- Recovery case creation (title, description, priority, source, optional due date)
- Case lifecycle: open → in progress → resolved → closed (and reopen), priority editing
- Case detail modal with owner/assignee, overdue indicator and per-case timeline
- Assignment by assignee email (`assign_case` RPC; owner only)
- Cross-case activity feed; events are written by database triggers, never by the browser
- Hardening: 20s request timeout, friendly errors, session recovery, HTML escaping, modal focus management, strict CSP
- Responsive desktop/mobile UI

## Run
Serve the folder over HTTP, for example: `python3 -m http.server 8080`, then open `http://localhost:8080`.

## Database objects the app depends on

Tables `profiles`, `recovery_cases`, `case_events`; RPCs `assign_case(p_case, p_email)` and `case_people(p_cases)`; triggers that write `case_events`.
`supabase/migrations/` currently contains only the 2026-10-03 hardening migration; the RPCs and event triggers were created outside it.
Run `supabase/tests/schema_contract.sql` (read-only) to confirm the live project has all of them, and export their definitions into a migration so the schema is reproducible.

## Next production layers

1. Export `assign_case`, `case_people` and the event triggers into `supabase/migrations/` (schema is not yet fully reproducible from the repo).
2. Team membership and role-based assignment.
3. Notifications and due-date workflows.
4. Staging Supabase project so live QA does not write to production.

## Security model (verified 2026-10-03)
- RLS on all tables; owners and assignees read/update cases; only owners delete or reassign; `owner_id` is immutable (trigger).
- `case_events` is append-only and `actor_id` must equal the caller.
- `anon` has no table privileges; `authenticated` has no TRUNCATE/REFERENCES/TRIGGER.
- Migration: `supabase/migrations/`. Re-verify any time with `supabase/tests/rls_isolation.sql` (self-rolling-back).

## QA and deploy

- CI (`.github/workflows/ci.yml`, on push and PR): syntax check, no-privileged-key check, CSP check, static smoke tests (`node --test tests/smoke/app.smoke.mjs`), then Playwright browser smoke tests (`tests/e2e/landing.spec.mjs`, no backend needed). Add `BASE_URL=<site>` to the static smoke tests to also verify the deployed site.
- Live browser QA: `tests/e2e/workspace.spec.mjs` creates real users and cases in the Supabase project, so it is opt-in: `npm run test:live` locally, or run the CI workflow manually with `live` ticked. Requires Auth > Email > "Confirm email" off, or pre-confirmed users.
- Local: `npm ci && npx playwright install chromium && npm run test:e2e`.
- Deploy: GitHub Pages via `.github/workflows/deploy.yml` on push to `main`. Add the Pages URL to Supabase Auth → URL Configuration (Site URL + Redirect URLs).
