-- Audit entries use the same ownership and permissions model as other
-- application tables. Latest-per-client behavior is enforced by the unique
-- client_id constraint and API transactions.
BEGIN;

COMMIT;