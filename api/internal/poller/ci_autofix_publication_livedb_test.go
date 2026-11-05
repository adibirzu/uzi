package poller

import (
	"context"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/vtmocanu/uzi/api/internal/capability"
	"github.com/vtmocanu/uzi/api/internal/forge"
	"github.com/vtmocanu/uzi/api/internal/secretbox"
	"github.com/vtmocanu/uzi/api/internal/store"
	"github.com/vtmocanu/uzi/api/internal/workersvc"
)

type ciPublicationCandidates struct {
	*store.Queries
	candidate store.ListCIAutofixCandidateRefsRow
}

func (q ciPublicationCandidates) ListCIAutofixCandidateRefs(context.Context, uuid.UUID) ([]store.ListCIAutofixCandidateRefsRow, error) {
	return []store.ListCIAutofixCandidateRefsRow{q.candidate}, nil
}

func TestCIAutofixPublicationRecoveryLiveDB(t *testing.T) {
	e := newMergedPollEnv(t)
	box, err := secretbox.New([]byte("0123456789abcdef0123456789abcdef"))
	if err != nil {
		t.Fatal(err)
	}
	svc := workersvc.New(e.q, box, workersvc.Params{})
	svc.SetTxBeginner(e.pool)
	svc.SetBackground(func(func()) {})
	e.exec(`INSERT INTO user_secrets(id,user_id,kind,label,ciphertext,sealed_with) VALUES($1,$2,'anthropic_token','fixture',$3,'master')`, uuid.New(), e.worker.UserID, []byte("fixture"))
	e.exec(`INSERT INTO runs(id,user_id,repo_id,kind,issue_iid,issue_title,issue_description,status,harness,branch,codex_credential_source_kind,codex_credential_source_id,codex_credential_source_revision,codex_credential_source_worker_id,status_since)
 VALUES($1,$2,$3,'issue',7,'host','d','completed','codex',$4,'worker_host',$5,1,$6,now()-interval '1 hour')`, uuid.New(), e.worker.UserID, e.repo, cfRef, uuid.NewString(), uuid.New())
	e.exec(`UPDATE runs SET kind='issue',issue_iid=7,mr_state=NULL WHERE id=$1`, e.run)
	e.worker.ProtocolCapabilities = []string{capability.RecoveryCompletedPublicationV1}
	e.exec(`UPDATE workers SET protocol_capabilities=$2 WHERE id=$1`, e.worker.ID, e.worker.ProtocolCapabilities)
	cand := cfCand(9001)
	cand.UserID = e.worker.UserID
	cand.Sha = strings.Repeat("a", 40)
	q := ciPublicationCandidates{e.q, cand}
	notifier := &cfNotifier{}
	f := &cfForge{jobs: []forge.Job{cfJob()}, logTail: "boom"}
	d := NewCIAutoFix(q, svc, notifier, cfSettings{enabled: true}, 5, 4096, 2, nil)
	repo := cfRepoRow()
	repo.ID = e.repo
	cycle := func() { d.detect(e.ctx, repo, f) }
	for range 3 {
		cycle()
	}
	var fixes, attempts int
	counts := func() {
		t.Helper()
		if err := e.pool.QueryRow(e.ctx, `SELECT count(*) FROM runs WHERE repo_id=$1 AND kind='ci_fix'`, e.repo).Scan(&fixes); err != nil {
			t.Fatal(err)
		}
		if err := e.pool.QueryRow(e.ctx, `SELECT count(*) FROM ci_autofix_attempts WHERE repo_id=$1`, e.repo).Scan(&attempts); err != nil {
			t.Fatal(err)
		}
	}
	counts()
	if fixes != 0 || attempts != 0 || len(f.notes) != 0 || len(notifier.calls) != 0 {
		t.Fatalf("refusal side effects: fixes=%d ledger=%d notes=%d notifications=%d", fixes, attempts, len(f.notes), len(notifier.calls))
	}
	gen, mr := int64(1), int64(7)
	head, branch := cand.Sha, cfRef
	result, err := svc.SetStateReportWithReconciliation(e.ctx, e.worker, e.run, workersvc.StateRequest{State: "completed", ClaimGeneration: &gen, CompletionFinalHead: &head, Branch: &branch, MrIID: &mr})
	if err != nil || !result.Applied {
		t.Fatalf("authenticated completion: %+v %v", result, err)
	}
	for range 3 {
		cycle()
	}
	counts()
	attempt, err := e.q.GetCIAutofixAttempt(e.ctx, store.GetCIAutofixAttemptParams{RepoID: e.repo, Ref: cfRef})
	if err != nil {
		t.Fatal(err)
	}
	if fixes != 1 || attempts != 1 || attempt.AttemptCount != 1 || attempt.LastPipelineID.Int64 != 9001 || len(f.notes) != 1 || len(notifier.calls) != 0 {
		t.Fatalf("recovery: fixes=%d ledger=%+v notes=%d notifications=%d", fixes, attempt, len(f.notes), len(notifier.calls))
	}
}
