package store_test

import (
	"context"
	"net/url"
	"os"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/vtmocanu/uzi/api/internal/store"
)

func TestCodexHostShapeUpgradeLiveDB(t *testing.T) {
	dsn := os.Getenv("UZI_TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("requires disposable UZI_TEST_DATABASE_URL")
	}
	ctx := context.Background()
	base, err := store.OpenPool(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer base.Close()
	schema := "host_shape_" + uuid.New().String()[:8]
	if _, err := base.Exec(ctx, "CREATE DATABASE "+pgx.Identifier{schema}.Sanitize()); err != nil {
		t.Fatal(err)
	}
	defer func() { _, _ = base.Exec(ctx, "DROP DATABASE "+pgx.Identifier{schema}.Sanitize()+" WITH (FORCE)") }()
	u, err := url.Parse(dsn)
	if err != nil {
		t.Fatal(err)
	}
	u.Path = "/" + schema
	dsn = u.String()
	if err := store.MigrateTo(ctx, dsn, 404); err != nil {
		t.Fatal(err)
	}
	pool, err := store.OpenPool(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	assertValidation := func(expected int) {
		t.Helper()
		var total, validated int
		if err := pool.QueryRow(ctx, `SELECT count(*), count(*) FILTER (WHERE convalidated) FROM pg_constraint WHERE connamespace='public'::regnamespace AND conname IN ('workers_codex_host_source_shape','runs_codex_credential_source_shape')`).Scan(&total, &validated); err != nil {
			t.Fatal(err)
		}
		if total != 2 || validated != expected {
			t.Fatalf("constraint validation state: total=%d validated=%d want=%d", total, validated, expected)
		}
	}
	assertValidation(0)
	user := seedBareUser(ctx, t, pool)
	for _, column := range []string{"codex_credential_source_kind", "codex_credential_source_id", "codex_credential_source_revision", "codex_credential_source_worker_id"} {
		fields := map[string]any{"codex_credential_source_kind": "worker_host", "codex_credential_source_id": uuid.NewString(), "codex_credential_source_revision": int64(1), "codex_credential_source_worker_id": uuid.New()}
		fields[column] = nil
		_, err := pool.Exec(ctx, `INSERT INTO runs(id,user_id,kind,issue_title,issue_description,harness,codex_credential_source_kind,codex_credential_source_id,codex_credential_source_revision,codex_credential_source_worker_id) VALUES($1,$2,'chat','test','d','codex',$3,$4,$5,$6)`, uuid.New(), user, fields["codex_credential_source_kind"], fields["codex_credential_source_id"], fields["codex_credential_source_revision"], fields["codex_credential_source_worker_id"])
		pgerr, ok := err.(*pgconn.PgError)
		if !ok || pgerr.Code != "23514" || pgerr.ConstraintName != "runs_codex_credential_source_shape" {
			t.Errorf("missing %s: %v", column, err)
		}
	}
	if _, err := pool.Exec(ctx, `INSERT INTO runs(id,user_id,kind,issue_title,issue_description,harness,codex_credential_source_kind,codex_credential_source_id,codex_credential_source_revision,codex_credential_source_worker_id) VALUES($1,$2,'chat','test','d','codex','worker_host',$3,1,$4)`, uuid.New(), user, uuid.NewString(), uuid.New()); err != nil {
		t.Fatalf("valid host shape: %v", err)
	}
	if err := store.MigrateTo(ctx, dsn, 405); err != nil {
		t.Fatal(err)
	}
	assertValidation(2)
}
