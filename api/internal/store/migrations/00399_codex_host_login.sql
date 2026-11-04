-- +goose Up
-- Non-secret worker-held Codex login placement metadata.  No credential material,
-- account identity, or path is stored in these columns.
ALTER TABLE workers
    ADD COLUMN codex_host_source_id text,
    ADD COLUMN codex_host_source_revision bigint,
    ADD COLUMN codex_host_source_ready boolean NOT NULL DEFAULT false,
    ADD CONSTRAINT workers_codex_host_source_shape CHECK (
        (codex_host_source_id IS NULL AND codex_host_source_revision IS NULL AND NOT codex_host_source_ready)
        OR (codex_host_source_id IS NOT NULL AND codex_host_source_revision IS NOT NULL
            AND codex_host_source_revision > 0)
    );

ALTER TABLE runs
    ADD COLUMN codex_credential_source_kind text,
    ADD COLUMN codex_credential_source_id text,
    ADD COLUMN codex_credential_source_revision bigint,
    ADD COLUMN codex_credential_source_worker_id uuid,
    ADD CONSTRAINT runs_codex_credential_source_shape CHECK (
        (codex_credential_source_kind IS NULL AND codex_credential_source_id IS NULL
            AND codex_credential_source_revision IS NULL AND codex_credential_source_worker_id IS NULL)
        OR (codex_credential_source_kind = 'worker_host' AND codex_credential_source_id IS NOT NULL
            AND codex_credential_source_revision > 0 AND codex_credential_source_worker_id IS NOT NULL)
    );

-- +goose Down
ALTER TABLE runs
    DROP CONSTRAINT runs_codex_credential_source_shape,
    DROP COLUMN codex_credential_source_worker_id,
    DROP COLUMN codex_credential_source_revision,
    DROP COLUMN codex_credential_source_id,
    DROP COLUMN codex_credential_source_kind;
ALTER TABLE workers
    DROP CONSTRAINT workers_codex_host_source_shape,
    DROP COLUMN codex_host_source_ready,
    DROP COLUMN codex_host_source_revision,
    DROP COLUMN codex_host_source_id;
