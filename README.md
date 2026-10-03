# RecoverDesk

Recovery-case workspace: capture cases, assign owners/assignees, move them through a lifecycle, and keep a tamper-proof audit trail.

## Architecture
- **Frontend:** static ES-module site (`index.html`, `app.js`, `styles.css`, `config.js`, `favicon.svg`), no build step. `@supabase/supabase-js` is loaded from a version-pinned jsDelivr URL; a Content-Security-Policy meta tag restricts scripts/styles/network to self, that CDN and the project's Supabase host.
- **Backend:** Supabase (Postgres, Auth, RLS). Project ref `qxtevnkrbcfemyysvrzs`, region eu-central-1. Schema lives in `supabase/migrations/` (apply in filename order).
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
npm run e2e      # Playwright browser QA; needs BASE_URL, and Confirm email OFF for the run
```
Database regression: run `supabase/tests/rls_isolation.sql` in the SQL editor or with `psql`. It rolls itself back and prints a report; every line must say OK or match its "want". CI runs it when the `SUPABASE_DB_URL` repository secret exists.

## Deployment
Push to `main` → `validate` must pass → `deploy` → `verify-live` compares SHA-256 of the live assets with the commit. A failing validation blocks deployment. First-time setup: Settings → Pages → Source: GitHub Actions.
