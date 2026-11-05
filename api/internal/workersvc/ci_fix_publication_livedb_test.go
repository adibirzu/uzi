package workersvc

import (
	"context"
	"errors"
	"fmt"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/vtmocanu/uzi/api/internal/store"
)

type ciPublicationRow struct {
	pgx.Row
	after func()
}

func (r ciPublicationRow) Scan(dest ...any) error {
	if err := r.Row.Scan(dest...); err != nil {
		return err
	}
	r.after()
	return nil
}

type ciPublicationDB struct {
	store.DBTX
	after func([]any)
}

func (d ciPublicationDB) QueryRow(ctx context.Context, sql string, args ...any) pgx.Row {
	return ciPublicationRow{Row: d.DBTX.QueryRow(ctx, sql, args...), after: func() { d.after(args) }}
}

type ciPublicationBeginner struct {
	TxBeginner
	after func([]any)
}

func (b ciPublicationBeginner) Begin(ctx context.Context) (pgx.Tx, error) {
	tx, err := b.TxBeginner.Begin(ctx)
	if err != nil {
		return nil, err
	}
	return ciPublicationTx{Tx: tx, after: b.after}, nil
}

type ciPublicationTx struct {
	pgx.Tx
	after func([]any)
}

func (tx ciPublicationTx) QueryRow(ctx context.Context, sql string, args ...any) pgx.Row {
	return ciPublicationRow{Row: tx.Tx.QueryRow(ctx, sql, args...), after: func() { tx.after(args) }}
}

func TestCIFixHostPublicationRaceLiveDB(t *testing.T) {
	for _, automatic := range []bool{false, true} {
		for _, stage := range []string{"preflight", "transaction"} {
			t.Run(fmt.Sprintf("auto=%t/%s", automatic, stage), func(t *testing.T) {
				env, _, userID, repoID := branchSerializeEnv(t)
				const iid int64 = 39530
				ref := agentIssueBranch(iid)
				source := uuid.New()
				seed := func() {
					env.exec(`INSERT INTO runs (id,user_id,repo_id,kind,issue_iid,issue_title,issue_description,status,harness,
						codex_credential_source_kind,codex_credential_source_id,codex_credential_source_revision,codex_credential_source_worker_id)
						VALUES ($1,$2,$3,'issue',$4,'source','d','running','codex','worker_host',$5,1,$6)`,
						source, userID, repoID, iid, uuid.NewString(), uuid.New())
				}
				published := false
				publish := func() {
					env.exec(`UPDATE runs SET status='completed', branch=$2 WHERE id=$1`, source, ref)
					published = true
				}
				if stage == "preflight" {
					seed()
				}
				reads := 0
				armed := true
				after := func(args []any) {
					if !armed || len(args) != 2 || args[0] != repoID {
						return
					}
					branch, ok := args[1].(pgtype.Text)
					if !ok || !branch.Valid || branch.String != ref {
						return
					}
					reads++
					if reads == 1 && stage == "transaction" {
						seed()
					}
					if reads == 2 {
						publish()
					}
				}
				svc := New(store.New(ciPublicationDB{DBTX: env.pool, after: after}), env.box, Params{})
				svc.SetTxBeginner(ciPublicationBeginner{TxBeginner: env.pool, after: after})
				create := svc.CreateCIFixRun
				if automatic {
					create = svc.CreateAutoCIFixRun
				}
				_, err := create(env.ctx, userID, repoID, ref, "Fix CI", "d", ciFixSnapshot(ref, 395300), nil)
				if !errors.Is(err, ErrHostCodexDerivedRunUnsupported) {
					t.Errorf("publication interleave returned %v, want typed host-derived refusal", err)
				}
				armed = false
				if stage == "transaction" && (reads < 2 || !published) {
					t.Fatalf("transaction publication barrier not reached: reads=%d published=%t", reads, published)
				}
				if !published {
					publish()
				}
				_, err = create(env.ctx, userID, repoID, ref, "Fix CI", "d", ciFixSnapshot(ref, 395301), nil)
				if !errors.Is(err, ErrHostCodexDerivedRunUnsupported) {
					t.Errorf("published source returned %v, want typed host-derived refusal", err)
				}
				var fixes int
				if err := env.pool.QueryRow(env.ctx, `SELECT count(*) FROM runs WHERE repo_id=$1 AND kind='ci_fix'`, repoID).Scan(&fixes); err != nil {
					t.Fatal(err)
				}
				if fixes != 0 {
					t.Fatalf("host publication created %d server-backed CI fixes", fixes)
				}
				env.exec(`INSERT INTO runs (id,user_id,repo_id,kind,issue_iid,issue_title,issue_description,status,branch,harness,created_at)
					VALUES ($1,$2,$3,'issue',$4,'replacement','d','completed',$5,'claude',now()+interval '1 hour')`,
					uuid.New(), userID, repoID, iid, ref)
				if _, err := create(env.ctx, userID, repoID, ref, "Fix CI", "d", ciFixSnapshot(ref, 395302), nil); err != nil {
					t.Fatalf("new server-backed source on reused branch: %v", err)
				}
			})
		}
	}
}
