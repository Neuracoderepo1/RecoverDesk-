# Staging Supabase project

Goal: live browser QA must never write to the production project.

1. Create a second Supabase project (new projects may incur cost on your plan; confirm before creating).
2. Apply, in order: tables and policies (to be exported with `supabase/export_definitions.sql` — not yet in the repo), then everything in `supabase/migrations/`.
3. Auth settings on staging only: Email → "Confirm email" OFF; add `http://localhost:8080` as a redirect URL.
4. Point a local copy at staging without touching `config.js` in git: copy `config.js` to `config.staging.js` (gitignored), set the staging URL and publishable key, and serve with that file in place of `config.js`.
5. Run: `E2E_LIVE=1 npx playwright test` against the local server.
6. Run `supabase/tests/rls_isolation.sql` and `supabase/tests/assignee_status_only.sql` on staging before production.

Never put a service-role key in the repo or in `config*.js`.
