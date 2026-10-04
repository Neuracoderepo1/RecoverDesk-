-- 20261003000000 creates recovery_cases_owner_idx, which duplicates the baseline's
-- recovery_cases_owner_id_idx (same column). Production already had it dropped; this
-- makes a from-scratch rebuild match. A no-op wherever the index is already absent.
drop index if exists public.recovery_cases_owner_idx;
