# RecoverDesk

Recovery-case workspace: capture cases, assign owners/assignees, move them through a lifecycle, and keep an audit trail that clients cannot alter.

## Architecture
- **Frontend:** static ES-module site (`index.html`, `app.js`, `styles.css`, `config.js`, `favicon.svg`), no build step. `@supabase/supabase-js` is loaded from a version-pinned jsDelivr URL; a Content-Security-Policy meta tag restricts scripts/styles/network to self, that CDN and the project's Supabase host.
- **Backend:** Supabase (Postgres, Auth, RLS). Project ref `qxtevnkrbcfemyysvrzs`, region eu-central-1. The full schema (tables, constraints, RLS policies, triggers, RPCs) is in `supabase/migrations/`; applying every file in filename order to an empty Supabase project rebuilds it (see *Rebuilding the database*).
- **Hosting:** GitHub Pages via `.github/workflows/deploy.yml` at https://neuracoderepo1.github.io/RecoverDesk-/

## Configuration
`config.js` holds the Supabase URL and the **publishable** key, which is public by design. Never commit a service-role key, SMTP credentials or `.env` files; `npm run check` fails the build if one appears in the tree or git history.

## Security model
- RLS on `profiles`, `recovery_cases`, `case_events`. `anon` has no table privileges; `authenticated` has no TRUNCATE.
- **Owner:** creates cases; edits title, description, due date and source; assigns by email; changes status and priority. `owner_id` is immutable.
- **Assignee:** sees the case and its timeline; may change **status** and **priority** only. Edits to title, description, due date or source are rejected by a database trigger. Assignees cannot reassign or take ownership.
- **Audit trail:** `case_events` is written only by database triggers (actor = authenticated caller). Clients cannot insert, update or delete events, and cannot delete cases.
- Assignment by email tells signed-in users whether an account exists; acceptable for a team tool, revisit before opening to the public.

## Auth requirements (Supabase dashboard; not settable from code)
1. Authentication → Sign In / Providers → Email → **Confirm email: ON**.
2. Authentication → URL Configuration → **Site URL** and **Redirect URLs** = `https://neuracoderepo1.github.io/RecoverDesk-/` (no localhost in production).
3. Authentication → SMTP: custom SMTP provider and sender (the default sender is heavily rate-limited).
4. Authentication → Policies: **Leaked password protection** where the plan allows it; minimum password length 10.

## Testing
```
npm ci
npm test         # syntax + asset/CSP + secret scan (tree and history) + smoke tests + DOM tests (CI gate)
npm run serve    # local server on :8080
npm run e2e:live # real-browser smoke test of the deployed site (no credentials, creates no data); CI runs it after every deploy
npm run e2e      # full signed-in Playwright QA; needs BASE_URL, and Confirm email OFF for the run
```
Database regression: run `supabase/tests/rls_isolation.sql` in the SQL editor or with `psql`. It rolls itself back and prints a report; every line must say OK or match its "want". CI runs it when the `SUPABASE_DB_URL` repository secret exists.

## Rebuilding the database
Apply `supabase/migrations/*.sql` in filename order to a fresh Supabase project (`supabase db push`, or paste each file into the SQL editor). `20261002000000_baseline_schema.sql` is the baseline and is idempotent. The live project already contains it, so do not replay it there: mark it applied with `supabase migration repair --status applied 20261002000000`. The result was verified against production: columns, constraints, indexes, policies, triggers, grants and function security all match, and `supabase/tests/rls_isolation.sql` passes on the rebuilt database. Two redundant index pairs remain in production (`recovery_cases_assigned_idx` / `_assigned_to_idx`, `case_events_case_idx` / `_case_id_idx`); they are harmless and kept so a rebuild stays identical.

## Deployment
Push to `main` → `validate` must pass → `deploy` → `verify-live` compares SHA-256 of the live assets with the commit. A failing validation blocks deployment. First-time setup: Settings → Pages → Source: GitHub Actions.
