-- +goose Up
SET LOCAL lock_timeout = '5s';
ALTER TABLE workers VALIDATE CONSTRAINT workers_codex_host_source_shape;
ALTER TABLE runs VALIDATE CONSTRAINT runs_codex_credential_source_shape;
-- +goose Down
SELECT 1;
