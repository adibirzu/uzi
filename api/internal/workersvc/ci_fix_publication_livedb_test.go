package workersvc

import (
	"context"
	"errors"
	"fmt"
	"github.com/vtmocanu/uzi/api/internal/capability"
	"strings"
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
					if !armed || len(args) < 2 || args[0] != repoID {
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
				_, err := create(env.ctx, userID, repoID, ref, "Fix CI", "d", ciFixReceiptSnapshot(ref, 395300), nil)
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
				_, err = create(env.ctx, userID, repoID, ref, "Fix CI", "d", ciFixReceiptSnapshot(ref, 395301), nil)
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
				for _, status := range []string{"cancelled", "failed"} {
					env.exec(`INSERT INTO runs (id,user_id,repo_id,kind,issue_iid,issue_title,issue_description,status,harness,created_at)
						VALUES ($1,$2,$3,'issue',$4,'unstarted','d',$5,'claude',now()+interval '30 minutes')`, uuid.New(), userID, repoID, iid, status)
					if _, err := create(env.ctx, userID, repoID, ref, "Fix CI", "d", ciFixReceiptSnapshot(ref, 395301), nil); !errors.Is(err, ErrHostCodexDerivedRunUnsupported) {
						t.Fatalf("unstarted %s replacement superseded host provenance: %v", status, err)
					}
				}
				env.exec(`INSERT INTO runs (id,user_id,repo_id,kind,issue_iid,issue_title,issue_description,status,branch,harness,created_at)
					VALUES ($1,$2,$3,'issue',$4,'replacement','d','completed',$5,'claude',now()+interval '1 hour')`,
					uuid.New(), userID, repoID, iid, ref)
				var server uuid.UUID
				if err := env.pool.QueryRow(env.ctx, `SELECT id FROM runs WHERE repo_id=$1 AND harness='claude' AND status='completed' ORDER BY created_at DESC LIMIT 1`, repoID).Scan(&server); err != nil {
					t.Fatal(err)
				}
				stampCIFixPublication(t, env, userID, repoID, server, ref)
				if _, err := create(env.ctx, userID, repoID, ref, "Fix CI", "d", ciFixReceiptSnapshot(ref, 395302), nil); err != nil {
					t.Fatalf("new server-backed source on reused branch: %v", err)
				}
			})
		}
	}
}

func TestCIFixUnpublishedStartedReplacementLiveDB(t *testing.T) {
	for _, automatic := range []bool{false, true} {
		for _, host := range []bool{false, true} {
			for _, terminal := range []string{"cancelled", "failed"} {
				for _, stage := range []string{"preflight", "transaction"} {
					t.Run(fmt.Sprintf("auto=%t/host=%t/%s/%s", automatic, host, terminal, stage), func(t *testing.T) {
						env, _, user, repo := branchSerializeEnv(t)
						const iid int64 = 39531
						ref := agentIssueBranch(iid)
						seed := func() {
							published, replacement := uuid.New(), uuid.New()
							env.exec(`INSERT INTO runs (id,user_id,repo_id,kind,issue_iid,issue_title,issue_description,status,branch,harness,created_at)
        VALUES ($1,$2,$3,'issue',$4,'published','d','completed',$5,'claude',now()-interval '1 hour'),
        ($6,$2,$3,'issue',$4,'unpublished','d',$7,NULL,'claude',now())`, published, user, repo, iid, ref, replacement, terminal)
							env.exec(`UPDATE runs SET started_at=now()-interval '5 minutes' WHERE id=$1`, replacement)
							bound := published
							if !host {
								bound = replacement
							}
							env.exec(`UPDATE runs SET harness='codex',codex_credential_source_kind='worker_host',codex_credential_source_id=$2,
        codex_credential_source_revision=1,codex_credential_source_worker_id=$3 WHERE id=$1`, bound, uuid.NewString(), uuid.New())
						}
						if stage == "preflight" {
							seed()
						}
						seeded := stage == "preflight"
						after := func(args []any) {
							if seeded || len(args) < 2 || args[0] != repo {
								return
							}
							branch, ok := args[1].(pgtype.Text)
							if !ok || branch.String != ref {
								return
							}
							seeded = true
							seed()
						}
						svc := New(store.New(ciPublicationDB{DBTX: env.pool, after: after}), env.box, Params{})
						svc.SetTxBeginner(ciPublicationBeginner{TxBeginner: env.pool, after: after})
						create := svc.CreateCIFixRun
						if automatic {
							create = svc.CreateAutoCIFixRun
						}
						_, err := create(env.ctx, user, repo, ref, "Fix CI", "d", ciFixReceiptSnapshot(ref, 395310), nil)
						if host {
							if !errors.Is(err, ErrHostCodexDerivedRunUnsupported) {
								t.Fatalf("published host superseded by unpublished replacement: %v", err)
							}
						} else {
							if !errors.Is(err, ErrHostCodexDerivedRunUnsupported) {
								t.Fatalf("unproven custody was not refused: %v", err)
							}
							var server uuid.UUID
							if err := env.pool.QueryRow(env.ctx, `SELECT id FROM runs WHERE repo_id=$1 AND branch=$2`, repo, ref).Scan(&server); err != nil {
								t.Fatal(err)
							}
							stampCIFixPublication(t, env, user, repo, server, ref)
							if _, err := create(env.ctx, user, repo, ref, "Fix CI", "d", ciFixReceiptSnapshot(ref, 395311), nil); err != nil {
								t.Fatalf("proved server publication: %v", err)
							}
						}
						if !seeded {
							t.Fatal("publication boundary was not reached")
						}
					})
				}
			}
		}
	}
}

func TestCIFixFailedPushAndRepublishLiveDB(t *testing.T) {
	for _, automatic := range []bool{false, true} {
		t.Run(fmt.Sprint(automatic), func(t *testing.T) {
			env, svc, user, repo := branchSerializeEnv(t)
			const iid int64 = 39532
			ref := agentIssueBranch(iid)
			server, host := uuid.New(), uuid.New()
			env.exec(`INSERT INTO runs(id,user_id,repo_id,kind,issue_iid,issue_title,issue_description,status,branch,harness,completion_final_head,status_since)
 VALUES($1,$2,$3,'issue',$4,'published','d','completed',$5,'claude',NULL,now()-interval '1 hour'),
 ($6,$2,$3,'issue',$4,'push then PR failure','d','failed',NULL,'codex',NULL,now())`, server, user, repo, iid, ref, host)
			env.exec(`UPDATE runs SET codex_credential_source_kind='worker_host',codex_credential_source_id=$2,codex_credential_source_revision=1,codex_credential_source_worker_id=$3 WHERE id=$1`, host, uuid.NewString(), uuid.New())
			create := svc.CreateCIFixRun
			if automatic {
				create = svc.CreateAutoCIFixRun
			}
			snapshot := ciFixReceiptSnapshot(ref, 395320)
			if _, err := create(env.ctx, user, repo, ref, "Fix CI", "d", snapshot, nil); !errors.Is(err, ErrHostCodexDerivedRunUnsupported) {
				t.Fatalf("unknown post-push custody: %v", err)
			}
			stampCIFixPublication(t, env, user, repo, server, ref)
			run, err := create(env.ctx, user, repo, ref, "Fix CI", "d", snapshot, nil)
			if err != nil {
				t.Fatal(err)
			}
			env.exec(`UPDATE runs SET status='completed' WHERE id=$1`, run.ID)
			env.exec(`UPDATE runs SET status_since=now()+interval '2 minutes',created_at=now()-interval '2 hours' WHERE id=$1`, host)
			if _, err := create(env.ctx, user, repo, ref, "Fix CI", "d", snapshot, nil); !errors.Is(err, ErrHostCodexDerivedRunUnsupported) {
				t.Fatalf("older resumed publisher ignored: %v", err)
			}
		})
	}
}

func ciFixReceiptSnapshot(ref string, pipeline int64) FailureSnapshot {
	snapshot := ciFixSnapshot(ref, pipeline)
	snapshot.SHA = strings.Repeat("a", 40)
	return snapshot
}

func stampCIFixPublication(t *testing.T, env codexTestEnv, user, repo, run uuid.UUID, branch string) {
	t.Helper()
	e := interlockLiveDB{ctx: env.ctx, pool: env.pool, q: env.q, userID: user, repoID: repo}
	wid := e.seedWorker(t, []string{capability.RecoveryCompletedPublicationV1})
	env.exec(`UPDATE runs SET status='running',worker_id=$2,claim_generation=1,claim_released_at=NULL WHERE id=$1`, run, wid)
	env.exec(`INSERT INTO recovery_custody_holds(id,user_id,repo_id,run_id,generation,state,original_worker_id,original_worker_identity,live_worker_id,live_run_id,inventory_guarded)
 VALUES($1,$2,$3,$4,1,'open',$5,'fixture',$5,$4,true)`, uuid.New(), user, repo, run, wid)
	svc := e.permitService(t)
	gen := int64(1)
	mr := int64(7)
	head := strings.Repeat("a", 40)
	result, err := svc.SetStateReportWithReconciliation(env.ctx, store.Worker{ID: wid, UserID: user, ProtocolCapabilities: []string{capability.RecoveryCompletedPublicationV1}}, run, StateRequest{State: "completed", ClaimGeneration: &gen, CompletionFinalHead: &head, Branch: &branch, MrIID: &mr})
	if err != nil || !result.Applied {
		t.Fatalf("authenticated publication: %+v %v", result, err)
	}
}
