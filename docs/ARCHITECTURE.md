# RecoverDesk architecture

Browser → Supabase Auth → Postgres/RLS.

Core tables already provisioned in the RecoverDesk Supabase project:
- `profiles`
- `recovery_cases`
- `case_events`

The frontend writes recovery cases with the authenticated user's id as `owner_id` and records creation/status events. Reads and updates are scoped to the authenticated owner.

The first release deliberately keeps the workflow narrow. Team membership, assignment, notification orchestration and richer audit controls are subsequent layers.

Security note: the publishable key is intended for browser use when paired with correctly configured RLS. Service-role credentials must never ship to the browser.
