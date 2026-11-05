package handler

import (
	"context"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/vtmocanu/uzi/api/internal/forge"
	"github.com/vtmocanu/uzi/api/internal/store"
	"github.com/vtmocanu/uzi/api/internal/workersvc"
)

// Namespaced MR-rework ledger through the on-demand rework endpoint (ADR-1199): per-namespace
// marks, the legacy-row bootstrap and its refusals, against a real Postgres.

func nscomment(ns string, id, author int64, body string) forge.MRComment {
	c := rcomment(id, author, body)
	c.IDNamespace = ns
	return c
}

// ledgerJSON is the whole ledger row as one comparable string.
func (r *reworkRig) ledgerJSON(t *testing.T) string {
	t.Helper()
	var s string
	if err := r.pool.QueryRow(context.Background(),
		`SELECT row_to_json(l)::text FROM mr_rework_ledger l WHERE repo_id = $1 AND ref = $2`, r.repoID, reworkRef).Scan(&s); err != nil {
		t.Fatal(err)
	}
	return s
}

// Regression: a consumed issue_comment mark of 5.58e9 must not hide an eligible review_comment
// whose id (3.96e9) is lower in absolute value but unseen in its own namespace.
func TestOnDemandReworkNamespacedMarksDoNotHideALowerIDLiveDB(t *testing.T) {
	rig := newReworkRig(t, &settingsStore{}, time.Minute)
	rig.f.answers[11] = forge.AuthorEligible
	q := store.New(rig.pool)
	if _, err := q.UpsertMRReworkLedger(context.Background(), store.UpsertMRReworkLedgerParams{
		RepoID: rig.repoID, Ref: reworkRef, HighWater: 5_580_000_000, Marks: []byte(`{"issue_comment":5580000000}`),
	}); err != nil {
		t.Fatal(err)
	}
	rig.f.comments = []forge.MRComment{
		nscomment(forge.CommentNSIssueComment, 5_580_000_000, 11, "already handled"),
		nscomment(forge.CommentNSReviewComment, 3_960_000_001, 11, "please rename the helper"),
	}
	rec := rig.post(t, `{}`)
	if rec.Code != http.StatusCreated {
		t.Fatalf("status %d body %s, want 201", rec.Code, rec.Body.String())
	}
	if n := rig.reworkRuns(t); n != 1 {
		t.Fatalf("mr_rework runs = %d, want 1", n)
	}
}

// A legacy row (written by the pre-ADR-1199 binary) is bootstrapped by the request, which then
// answers from the bootstrapped state.
func TestOnDemandReworkBootstrapsALegacyRowLiveDB(t *testing.T) {
	rig := newReworkRig(t, &settingsStore{}, time.Minute)
	rig.f.answers[11] = forge.AuthorEligible
	cliMustExec(t, rig.pool,
		`INSERT INTO mr_rework_ledger (repo_id, ref, attempt_count, high_water) VALUES ($1, $2, 1, 5580000000)`, rig.repoID, reworkRef)
	rig.f.comments = []forge.MRComment{
		nscomment(forge.CommentNSIssueComment, 5_580_000_000, 11, "already handled"),
		nscomment(forge.CommentNSReviewComment, 3_960_000_001, 11, "also handled"),
	}
	var legacy bool
	check := func(want bool) {
		t.Helper()
		if err := rig.pool.QueryRow(context.Background(),
			`SELECT comment_marks IS NULL FROM mr_rework_ledger WHERE repo_id = $1 AND ref = $2`, rig.repoID, reworkRef).Scan(&legacy); err != nil {
			t.Fatal(err)
		}
		if legacy != want {
			t.Fatalf("comment_marks IS NULL = %v, want %v", legacy, want)
		}
	}
	check(true)

	// Everything listed is at or below the legacy mark: bootstrapped as consumed, nothing new.
	rec := rig.post(t, `{}`)
	if rec.Code != http.StatusConflict || !strings.Contains(rec.Body.String(), "nothing to rework") {
		t.Fatalf("status %d body %s, want the nothing-to-rework 409", rec.Code, rec.Body.String())
	}
	check(false)
	var marks string
	if err := rig.pool.QueryRow(context.Background(),
		`SELECT comment_marks::text FROM mr_rework_ledger WHERE repo_id = $1 AND ref = $2`, rig.repoID, reworkRef).Scan(&marks); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(marks, `"issue_comment": 5580000000`) || !strings.Contains(marks, `"review_comment": 3960000001`) {
		t.Fatalf("bootstrapped comment_marks = %s", marks)
	}
	if rig.reworkRuns(t) != 0 {
		t.Fatal("a run was created from already-consumed comments")
	}

	// A genuinely new comment in the bootstrapped namespace now reworks.
	rig.f.comments = append(rig.f.comments, nscomment(forge.CommentNSIssueComment, 5_580_000_002, 11, "new request"))
	rec = rig.post(t, `{}`)
	if rec.Code != http.StatusCreated {
		t.Fatalf("status %d body %s, want 201", rec.Code, rec.Body.String())
	}
}

// 5001 legacy pending ids, each present in two namespaces, expand past the pending cap: the
// request is refused and the row is left byte-for-byte as it was.
func TestOnDemandReworkBootstrapOverflowRefusesAndLeavesTheRowLiveDB(t *testing.T) {
	rig := newReworkRig(t, &settingsStore{}, time.Minute)
	rig.f.answers[11] = forge.AuthorEligible
	cliMustExec(t, rig.pool,
		`INSERT INTO mr_rework_ledger (repo_id, ref, attempt_count, high_water, pending_unknown_ids)
		 VALUES ($1, $2, 1, 100000, (SELECT array_agg(g::bigint) FROM generate_series(1, 5001) g))`, rig.repoID, reworkRef)
	comments := make([]forge.MRComment, 0, 2*5001)
	for id := int64(1); id <= 5001; id++ {
		comments = append(comments,
			nscomment(forge.CommentNSIssueComment, id, 11, "x"),
			nscomment(forge.CommentNSReviewComment, id, 11, "y"))
	}
	rig.f.comments = comments
	before := rig.ledgerJSON(t)

	rec := rig.post(t, `{}`)
	if rec.Code != http.StatusConflict || !strings.Contains(rec.Body.String(), workersvc.ErrReviewLedgerBootstrapOverflow.Error()) {
		t.Fatalf("status %d body %s, want 409 with the overflow message", rec.Code, rec.Body.String())
	}
	if rig.reworkRuns(t) != 0 {
		t.Fatal("a run was created on an overflowing legacy ledger")
	}
	if after := rig.ledgerJSON(t); after != before {
		t.Fatalf("ledger row changed on refusal:\nbefore %s\nafter  %s", before, after)
	}
}

// The legacy scalars move between the row read and the bootstrap write: the compare-and-set
// loses and the request answers ErrReworkLedgerChanged as a 409, writing nothing.
func TestOnDemandReworkBootstrapRaceIs409LiveDB(t *testing.T) {
	rig := newReworkRig(t, &settingsStore{}, time.Minute)
	rig.f.answers[11] = forge.AuthorEligible
	cliMustExec(t, rig.pool,
		`INSERT INTO mr_rework_ledger (repo_id, ref, attempt_count, high_water) VALUES ($1, $2, 1, 100)`, rig.repoID, reworkRef)
	rig.f.comments = []forge.MRComment{nscomment(forge.CommentNSReviewComment, 190, 11, "please rename the helper")}
	rig.f.onList = func() {
		cliMustExec(t, rig.pool, `UPDATE mr_rework_ledger SET high_water = 120 WHERE repo_id = $1 AND ref = $2`, rig.repoID, reworkRef)
	}
	rec := rig.post(t, `{}`)
	if rec.Code != http.StatusConflict || !strings.Contains(rec.Body.String(), workersvc.ErrReworkLedgerChanged.Error()) {
		t.Fatalf("status %d body %s, want 409 with the ledger-changed message", rec.Code, rec.Body.String())
	}
	if rig.reworkRuns(t) != 0 {
		t.Fatal("a run was created after a lost bootstrap race")
	}
}

// The row turns legacy between the read and StartMRReworkForRun's advance: the create refuses
// with ErrReworkLedgerChanged, which the handler maps to 409, and no run is left behind.
func TestOnDemandReworkRowTurnedLegacyDuringCreateIs409LiveDB(t *testing.T) {
	rig := newReworkRig(t, &settingsStore{}, time.Minute)
	rig.f.answers[11] = forge.AuthorEligible
	q := store.New(rig.pool)
	if _, err := q.UpsertMRReworkLedger(context.Background(), store.UpsertMRReworkLedgerParams{
		RepoID: rig.repoID, Ref: reworkRef, HighWater: 100, Marks: []byte(`{"review_comment":100}`),
	}); err != nil {
		t.Fatal(err)
	}
	rig.f.comments = []forge.MRComment{nscomment(forge.CommentNSReviewComment, 190, 11, "please rename the helper")}
	rig.f.onList = func() {
		cliMustExec(t, rig.pool, `UPDATE mr_rework_ledger SET comment_marks = NULL WHERE repo_id = $1 AND ref = $2`, rig.repoID, reworkRef)
	}
	rec := rig.post(t, `{}`)
	if rec.Code != http.StatusConflict || !strings.Contains(rec.Body.String(), workersvc.ErrReworkLedgerChanged.Error()) {
		t.Fatalf("status %d body %s, want 409 with the ledger-changed message", rec.Code, rec.Body.String())
	}
	if rig.reworkRuns(t) != 0 {
		t.Fatal("a run survived a refused create")
	}
}

func TestOnDemandReworkHostCodexSourceUnavailableLiveDB(t *testing.T) {
	rig := newReworkRig(t, &settingsStore{}, time.Minute)
	cliMustExec(t, rig.pool, `UPDATE runs
		SET harness = 'codex', codex_credential_source_kind = 'worker_host', codex_credential_source_id = $2,
		    codex_credential_source_revision = 1, codex_credential_source_worker_id = $3
		WHERE id = $1`, rig.runID, uuid.NewString(), uuid.New())

	rec := rig.post(t, `{"guidance":"please address this"}`)
	if rec.Code != http.StatusConflict {
		t.Fatalf("status %d body %s, want 409", rec.Code, rec.Body.String())
	}
	if !strings.Contains(rec.Body.String(), `"reason":"host_codex_source_unavailable"`) {
		t.Fatalf("body %s, want host_codex_source_unavailable reason", rec.Body.String())
	}
	if rig.reworkRuns(t) != 0 {
		t.Fatal("a rework run was created from an unavailable worker-host source")
	}
}

func TestOnDemandReworkHostCodexSourceInheritedLiveDB(t *testing.T) {
	rig := newReworkRig(t, &settingsStore{}, time.Minute)
	workerID := uuid.New()
	sourceID := uuid.NewString()
	const revision int64 = 7
	cliMustExec(t, rig.pool, `INSERT INTO workers
		(id, user_id, name, token_hash, status, last_heartbeat_at, protocol_capabilities,
		 codex_host_source_id, codex_host_source_revision, codex_host_source_ready)
		VALUES ($1, $2, $3, $4, 'online', now(),
		 ARRAY['codex_host_login_v1','codex_harness_v1','codex_runtime_v2'], $5, $6, true)`,
		workerID, rig.user.ID, "host-source-"+workerID.String(), workerID[:], sourceID, revision)
	cliMustExec(t, rig.pool, `UPDATE runs
		SET harness = 'codex', codex_credential_source_kind = 'worker_host', codex_credential_source_id = $2,
		    codex_credential_source_revision = $3, codex_credential_source_worker_id = $4
		WHERE id = $1`, rig.runID, sourceID, revision, workerID)

	rec := rig.post(t, `{"guidance":"please address this"}`)
	if rec.Code != http.StatusCreated {
		t.Fatalf("status %d body %s, want 201", rec.Code, rec.Body.String())
	}
	if rig.reworkRuns(t) != 1 {
		t.Fatal("want one rework run")
	}
	type binding struct {
		kind     string
		id       string
		revision int64
		workerID uuid.UUID
	}
	readBinding := func(runID uuid.UUID) binding {
		t.Helper()
		var got binding
		if err := rig.pool.QueryRow(context.Background(), `SELECT codex_credential_source_kind,
			codex_credential_source_id, codex_credential_source_revision, codex_credential_source_worker_id
			FROM runs WHERE id = $1`, runID).Scan(&got.kind, &got.id, &got.revision, &got.workerID); err != nil {
			t.Fatal(err)
		}
		return got
	}
	parent := readBinding(rig.runID)
	var childID uuid.UUID
	if err := rig.pool.QueryRow(context.Background(), `SELECT id FROM runs WHERE kind = 'mr_rework' AND target_run_id = $1`, rig.runID).Scan(&childID); err != nil {
		t.Fatal(err)
	}
	child := readBinding(childID)
	if child != parent {
		t.Fatalf("child binding = %+v, want parent binding %+v", child, parent)
	}
}
