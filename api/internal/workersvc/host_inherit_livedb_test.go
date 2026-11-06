package workersvc

import (
	"errors"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"
)

// host_inherit_livedb_test.go exercises the worker-host inheritance contract through
// real create transactions.  It is skipped with the rest of workersvc's LiveDB suite
// unless UZI_TEST_DATABASE_URL is set (normally by e2e/run-store-it.sh).

type hostInheritanceFixture struct {
	env                      codexTestEnv
	userID, workerID, repoID uuid.UUID
	source                   string
}

func newHostInheritanceFixture(t *testing.T) hostInheritanceFixture {
	t.Helper()
	env := setupCodexLiveDB(t)
	userID, workerID, repoID := env.seedCodexInfra(t)
	source := "host-" + uuid.NewString()
	env.exec(`UPDATE workers SET last_heartbeat_at=now(), protocol_capabilities=ARRAY['codex_host_login_v1','codex_harness_v1','codex_runtime_v2'], codex_host_source_id=$2, codex_host_source_revision=7, codex_host_source_ready=true WHERE id=$1`, workerID, source)
	return hostInheritanceFixture{env: env, userID: userID, workerID: workerID, repoID: repoID, source: source}
}

func (f hostInheritanceFixture) parent(t *testing.T, kind, branch string) uuid.UUID {
	t.Helper()
	id := f.env.seedCodexRun(t, f.userID, f.workerID, f.repoID)
	f.env.exec(`UPDATE runs SET kind=$2, issue_iid=CASE WHEN $2='task' THEN NULL ELSE issue_iid END, status='completed', harness='codex', branch=$3,
 codex_credential_source_kind='worker_host', codex_credential_source_id=$4,
 codex_credential_source_revision=7, codex_credential_source_worker_id=$5 WHERE id=$1`, id, kind, branch, f.source, f.workerID)
	return id
}

func assertHostInherited(t *testing.T, f hostInheritanceFixture, id uuid.UUID) {
	t.Helper()
	r := mustRun(t, f.env, id)
	if !r.CodexCredentialSourceKind.Valid || r.CodexCredentialSourceKind.String != "worker_host" ||
		!r.CodexCredentialSourceID.Valid || r.CodexCredentialSourceID.String != f.source ||
		!r.CodexCredentialSourceRevision.Valid || r.CodexCredentialSourceRevision.Int64 != 7 ||
		!r.CodexCredentialSourceWorkerID.Valid || uuid.UUID(r.CodexCredentialSourceWorkerID.Bytes) != f.workerID {
		t.Fatalf("child host binding = kind=%v id=%v revision=%v worker=%v; want worker_host/%q/7/%s", r.CodexCredentialSourceKind, r.CodexCredentialSourceID, r.CodexCredentialSourceRevision, r.CodexCredentialSourceWorkerID, f.source, f.workerID)
	}
}

// TestHostInheritDerivedLanesLiveDB covers each F4 creator at its real SQL seam.
func TestHostInheritDerivedLanesLiveDB(t *testing.T) {
	t.Run("mr_rework", func(t *testing.T) {
		f := newHostInheritanceFixture(t)
		parent := f.parent(t, "issue", "agent/"+uuid.NewString())
		r, err := atomicMRReworkSvc(f.env).CreateAutoMRReworkRun(f.env.ctx, f.userID, f.repoID, "rework/"+uuid.NewString(), 9, parent, "rework", "", nil)
		if err != nil {
			t.Fatalf("CreateAutoMRReworkRun: %v", err)
		}
		assertHostInherited(t, f, r.ID)
	})
	t.Run("ci_fix", func(t *testing.T) {
		f := newHostInheritanceFixture(t)
		ref := "fix/" + uuid.NewString()
		f.parent(t, "issue", ref)
		r, err := atomicSvc(f.env).CreateAutoCIFixRun(f.env.ctx, f.userID, f.repoID, ref, "fix", "", sampleSnapshot(), nil)
		if err != nil {
			t.Fatalf("CreateAutoCIFixRun: %v", err)
		}
		assertHostInherited(t, f, r.ID)
	})
	t.Run("judge_auto", func(t *testing.T) {
		f := newHostInheritanceFixture(t)
		parent := f.parent(t, "issue", "agent/"+uuid.NewString())
		f.env.exec(`UPDATE users SET judge_enabled=true WHERE id=$1`, f.userID)
		s := atomicSvc(f.env)
		s.settings = fakeSettings{enabled: true}
		s.maybeEnqueueJudge(f.env.ctx, mustRun(t, f.env, parent))
		var child uuid.UUID
		if err := f.env.pool.QueryRow(f.env.ctx, `SELECT id FROM runs WHERE target_run_id=$1 AND kind='judge'`, parent).Scan(&child); err != nil {
			t.Fatalf("auto judge: %v", err)
		}
		assertHostInherited(t, f, child)
	})
	t.Run("judge_rerun", func(t *testing.T) {
		f := newHostInheritanceFixture(t)
		parent := f.parent(t, "issue", "agent/"+uuid.NewString())
		s := atomicSvc(f.env)
		s.settings = fakeSettings{enabled: true}
		r, err := s.RerunJudge(f.env.ctx, f.userID, false, parent)
		if err != nil {
			t.Fatalf("RerunJudge: %v", err)
		}
		assertHostInherited(t, f, r.ID)
	})
	t.Run("task_review", func(t *testing.T) {
		f := newHostInheritanceFixture(t)
		parent := f.parent(t, "task", "uzi/task/"+uuid.NewString())
		r, err := atomicSvc(f.env).CreateTaskReviewRun(f.env.ctx, f.userID, f.repoID, parent, "uzi/task/"+uuid.NewString(), "main", HarnessCodex)
		if err != nil {
			t.Fatalf("CreateTaskReviewRun: %v", err)
		}
		assertHostInherited(t, f, r.ID)
	})
	t.Run("then_fix", func(t *testing.T) {
		f := newHostInheritanceFixture(t)
		parent := f.parent(t, "task", "uzi/task/"+uuid.NewString())
		r, err := atomicSvc(f.env).CreateThenFixRun(f.env.ctx, f.userID, f.repoID, parent, "uzi/task/"+uuid.NewString(), "main", "fix", pgtype.Int4{}, pgtype.Int4{}, HarnessCodex)
		if err != nil {
			t.Fatalf("CreateThenFixRun: %v", err)
		}
		assertHostInherited(t, f, r.ID)
	})
}

// TestHostInheritExactWorkerAndAvailabilityLiveDB proves exact-host admission: another
// same-user reporter cannot substitute for an offline/stale/unready bound worker.
func TestHostInheritExactWorkerAndAvailabilityLiveDB(t *testing.T) {
	for _, tc := range []struct {
		name       string
		breakOwner string
	}{
		{"offline", "status='offline'"}, {"stale", "last_heartbeat_at=now()-interval '2 hours'"},
		{"revision", "codex_host_source_revision=8"}, {"unready", "codex_host_source_ready=false"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newHostInheritanceFixture(t)
			parent := f.parent(t, "task", "uzi/task/"+uuid.NewString())
			peer := uuid.New()
			f.env.exec(`INSERT INTO workers(id,user_id,name,token_hash,status,last_heartbeat_at,protocol_capabilities,codex_host_source_id,codex_host_source_revision,codex_host_source_ready) VALUES($1,$2,$3,$4,'online',now(),ARRAY['codex_host_login_v1','codex_harness_v1','codex_runtime_v2'],$5,7,true)`, peer, f.userID, "peer-"+peer.String(), peer[:], f.source)
			f.env.exec("UPDATE workers SET "+tc.breakOwner+" WHERE id=$1", f.workerID)
			_, err := atomicSvc(f.env).CreateTaskReviewRun(f.env.ctx, f.userID, f.repoID, parent, "uzi/task/"+uuid.NewString(), "main", HarnessCodex)
			if !errors.Is(err, ErrHostCodexSourceUnavailable) {
				t.Fatalf("err = %v, want ErrHostCodexSourceUnavailable", err)
			}
			var n int
			if err := f.env.pool.QueryRow(f.env.ctx, `SELECT count(*) FROM runs WHERE review_target_run_id=$1`, parent).Scan(&n); err != nil || n != 0 {
				t.Fatalf("children=%d err=%v, want 0", n, err)
			}
		})
	}
}

// TestHostInheritIncompleteAndCIFixOwnershipLiveDB pins fail-closed incomplete parents,
// latest-parent CI selection, and same-branch cross-user isolation.
func TestHostInheritIncompleteAndCIFixOwnershipLiveDB(t *testing.T) {
	t.Run("incomplete_never_falls_back", func(t *testing.T) {
		f := newHostInheritanceFixture(t)
		seedAnthropicToken(t, f.env, f.userID)
		alias := f.env.seedStaticAPIKey(t, f.userID, "server", codexToken("sk"))
		makeCodexDefault(t, f.env, alias)
		parent := f.parent(t, "task", "uzi/task/"+uuid.NewString())
		f.env.exec(`UPDATE runs SET codex_credential_source_worker_id=NULL WHERE id=$1`, parent)
		_, err := atomicSvc(f.env).CreateTaskReviewRun(f.env.ctx, f.userID, f.repoID, parent, "uzi/task/"+uuid.NewString(), "main", HarnessCodex)
		if !errors.Is(err, ErrHostCodexSourceUnavailable) {
			t.Fatalf("err=%v", err)
		}
		var n int
		if err := f.env.pool.QueryRow(f.env.ctx, `SELECT count(*) FROM runs WHERE review_target_run_id=$1`, parent).Scan(&n); err != nil {
			t.Fatalf("count children: %v", err)
		}
		if n != 0 {
			t.Fatalf("fallback inserted %d children", n)
		}
	})
	for _, tc := range []struct {
		name   string
		setBad string
	}{
		{"null_source_id", "codex_credential_source_id=NULL"},
		{"zero_revision", "codex_credential_source_revision=0"},
	} {
		t.Run("incomplete_"+tc.name+"_never_falls_back", func(t *testing.T) {
			f := newHostInheritanceFixture(t)
			seedAnthropicToken(t, f.env, f.userID)
			alias := f.env.seedStaticAPIKey(t, f.userID, "server", codexToken("sk"))
			makeCodexDefault(t, f.env, alias)
			parent := f.parent(t, "task", "uzi/task/"+uuid.NewString())
			f.env.exec("UPDATE runs SET "+tc.setBad+" WHERE id=$1", parent)
			_, err := atomicSvc(f.env).CreateTaskReviewRun(f.env.ctx, f.userID, f.repoID, parent, "uzi/task/"+uuid.NewString(), "main", HarnessCodex)
			if !errors.Is(err, ErrHostCodexSourceUnavailable) {
				t.Fatalf("err=%v, want ErrHostCodexSourceUnavailable", err)
			}
			var n int
			if err := f.env.pool.QueryRow(f.env.ctx, `SELECT count(*) FROM runs WHERE review_target_run_id=$1`, parent).Scan(&n); err != nil {
				t.Fatalf("count children: %v", err)
			}
			if n != 0 {
				t.Fatalf("fallback inserted %d children", n)
			}
		})
	}
	t.Run("ci_fix_uses_latest_same_user_parent", func(t *testing.T) {
		f := newHostInheritanceFixture(t)
		ref := "fix/" + uuid.NewString()
		f.parent(t, "issue", ref)
		non := f.env.seedCodexRun(t, f.userID, f.workerID, f.repoID)
		f.env.exec(`UPDATE runs SET status='completed', branch=$2, created_at=now()+interval '1 second', harness='claude' WHERE id=$1`, non, ref)
		_, err := atomicSvc(f.env).CreateAutoCIFixRun(f.env.ctx, f.userID, f.repoID, ref, "fix", "", sampleSnapshot(), nil)
		if !errors.Is(err, ErrHostCodexDerivedRunUnsupported) {
			t.Fatalf("err=%v, want historical host refusal", err)
		}
	})
	t.Run("ci_fix_ignores_other_user_host_parent", func(t *testing.T) {
		f := newHostInheritanceFixture(t)
		seedAnthropicToken(t, f.env, f.userID)
		alias := f.env.seedStaticAPIKey(t, f.userID, "server", codexToken("sk"))
		makeCodexDefault(t, f.env, alias)
		ref := "fix/" + uuid.NewString()
		otherUser := f.env.seedUser(t)
		otherWorker := uuid.New()
		f.env.exec(`INSERT INTO workers(id,user_id,name,token_hash,status,last_heartbeat_at,protocol_capabilities,codex_host_source_id,codex_host_source_revision,codex_host_source_ready)
			VALUES($1,$2,$3,$4,'online',now(),ARRAY['codex_host_login_v1','codex_harness_v1','codex_runtime_v2'],$5,7,true)`, otherWorker, otherUser, "other-"+otherWorker.String(), otherWorker[:], "host-"+uuid.NewString())
		otherParent := f.env.seedCodexRun(t, otherUser, otherWorker, f.repoID)
		f.env.exec(`UPDATE runs SET kind='issue', status='completed', harness='codex', branch=$2,
			codex_credential_source_kind='worker_host', codex_credential_source_id=$3,
			codex_credential_source_revision=7, codex_credential_source_worker_id=$4 WHERE id=$1`, otherParent, ref, "host-"+uuid.NewString(), otherWorker)
		r, err := atomicSvc(f.env).CreateAutoCIFixRun(f.env.ctx, f.userID, f.repoID, ref, "fix", "", sampleSnapshot(), nil)
		if err != nil {
			t.Fatalf("CreateAutoCIFixRun: %v", err)
		}
		if r.UserID != f.userID {
			t.Fatalf("child owner=%s", r.UserID)
		}
		if r.CodexCredentialSourceKind.Valid && r.CodexCredentialSourceKind.String == "worker_host" {
			t.Fatalf("other user's host parent bound child: %+v", r.CodexCredentialSourceKind)
		}
		if r.CodexCredentialSourceWorkerID.Valid {
			t.Fatalf("child worker-host binding=%s, want none", uuid.UUID(r.CodexCredentialSourceWorkerID.Bytes))
		}
	})
}
