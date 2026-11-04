package workersvc

import (
	"errors"
	"slices"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/vtmocanu/uzi/api/internal/capability"
	"github.com/vtmocanu/uzi/api/internal/store"
)

// PRD #1332 M5A (D3) LiveDB coverage of the fail-closed Codex-harness claim placement gate. A
// CODEX-INDICATING run (harness='codex', or a surviving M1 binding sentinel) is claimable /
// peer-deferrable / counted-available ONLY by a worker advertising the 'codex_harness_v1' protocol
// capability, so an old worker that would ignore the unknown Codex JSON and silently run Claude can
// never receive it. These mirror the completion_interlock_v1 LiveDB tests exactly (claimant admission,
// fleet-spread peer mirror, fleet-count queued reason) and reuse the interlockLiveDB harness. This is
// a credential-routing SECURITY boundary, so it runs against a real throwaway Postgres — skipped
// unless UZI_TEST_DATABASE_URL points at one (run via ./e2e/run-store-it.sh). A package that prints
// `ok` with PASS=0 is INVALID, not green.

// seedCodexQueuedRun inserts a queued issue run with harness='codex' — the primary Codex-indicating
// shape (the binding-coherence CHECK, migration 00226, allows harness='codex' with NULL sentinels).
// worker_id NULL so affinity never pins it; required_capabilities '{}' so fn_worker_can_claim is
// trivially satisfiable and the D3 Codex clause is the ONLY thing that can block.
func (e interlockLiveDB) seedCodexQueuedRun(t *testing.T) uuid.UUID {
	t.Helper()
	id := uuid.New()
	iid := *e.nextIID
	*e.nextIID++
	e.exec(t, `INSERT INTO runs (id, user_id, repo_id, issue_iid, issue_title, issue_description, kind, status, worker_id, harness)
	           VALUES ($1, $2, $3, $4, 't', 'd', 'issue', 'queued', NULL, 'codex')`,
		id, e.userID, e.repoID, iid)
	return id
}

// codexIndicatingQueuedRow builds the ListActiveRunsForHealth row queuedReason consumes for a
// CODEX-INDICATING queued run: harness='codex', no required_capabilities (so the ordinary caps rung
// is skipped) and no repo_id (so the docker-allowlist rung is skipped) and no completion contract (so
// the completion rung is skipped), isolating the Codex-capability rung as the deciding one.
func (e interlockLiveDB) codexIndicatingQueuedRow(runID [16]byte) store.ListActiveRunsForHealthRow {
	return store.ListActiveRunsForHealthRow{
		ID:      runID,
		UserID:  e.userID,
		Status:  "queued",
		Health:  healthOK,
		Harness: harnessCodex,
	}
}

// TestClaimCodexHardClauseBlocksIncapableWorkerLiveDB is the core D3 assertion, mirroring
// TestClaimInterlockHardClauseBlocksIncapableWorkerLiveDB: a CODEX-INDICATING run is NOT claimable by
// a worker whose protocol_capabilities lacks 'codex_harness_v1' — and NEITHER the @capability_aware
// kill-switch (false) NOR the owner ClearRunRequiredCapabilities override can bypass it. A CAPABLE
// worker then claims it.
//
// CALIBRATION (claimant clause): delete the claimant Codex clause in runtime.sql (the
// `AND (NOT (r.harness = 'codex' OR ...) OR 'codex_harness_v1' = ANY(@worker_protocol_caps))` added
// after the completion clause) and regenerate — step (1) then lets the incapable worker claim and this
// test fails.
func TestClaimCodexHardClauseBlocksIncapableWorkerLiveDB(t *testing.T) {
	e := setupInterlockLiveDB(t)

	incapable := e.seedWorker(t, nil)                                                          // protocol_capabilities '{}'
	capable := e.seedWorker(t, []string{capability.CodexHarnessV1, capability.CodexRuntimeV2}) // advertises codex_harness_v1
	runID := e.seedCodexQueuedRun(t)                                                           // harness='codex', required_capabilities '{}'

	// (1) capability_aware=false does NOT bypass: the incapable worker still cannot claim.
	if _, err := e.q.ClaimRun(e.ctx, e.claimParams(incapable, []string{}, false)); !errors.Is(err, pgx.ErrNoRows) {
		t.Fatalf("codex-indicating run claimed by an incapable worker with capability_aware=false (err=%v); the D3 clause must block regardless of the kill-switch", err)
	}
	if s := e.runStatus(t, runID); s != "queued" {
		t.Fatalf("run must stay queued after the blocked claim; status = %q", s)
	}

	// (2) the owner override (ClearRunRequiredCapabilities) does NOT bypass either. Park the run at
	// awaiting_approval, set a required cap, clear it via the real owner-clear path, re-queue, and
	// re-attempt. The Codex clause is OUTSIDE required_capabilities, so clearing it changes nothing.
	e.exec(t, `UPDATE runs SET status = 'awaiting_approval', required_capabilities = '{docker}' WHERE id = $1`, runID)
	cleared, err := e.q.ClearRunRequiredCapabilities(e.ctx, store.ClearRunRequiredCapabilitiesParams{ID: runID, UserID: e.userID})
	if err != nil {
		t.Fatalf("ClearRunRequiredCapabilities: %v", err)
	}
	if cleared != 1 {
		t.Fatalf("ClearRunRequiredCapabilities affected %d rows, want 1 (the override must fire)", cleared)
	}
	e.exec(t, `UPDATE runs SET status = 'queued' WHERE id = $1`, runID)
	if _, err := e.q.ClaimRun(e.ctx, e.claimParams(incapable, []string{}, false)); !errors.Is(err, pgx.ErrNoRows) {
		t.Fatalf("codex-indicating run claimed by an incapable worker AFTER ClearRunRequiredCapabilities (err=%v); the D3 clause is outside the override and must still block", err)
	}
	if s := e.runStatus(t, runID); s != "queued" {
		t.Fatalf("run must stay queued after the override+blocked claim; status = %q", s)
	}

	// (3) a CAPABLE worker claims it — the clause admits a worker advertising codex_harness_v1.
	run, err := e.q.ClaimRun(e.ctx, e.claimParams(capable, []string{capability.CodexHarnessV1, capability.CodexRuntimeV2}, false))
	if err != nil {
		t.Fatalf("capable worker must claim the codex-indicating run: %v", err)
	}
	if run.ID != runID {
		t.Fatalf("capable worker claimed %v, want %v", run.ID, runID)
	}
	if run.Status != "claimed" {
		t.Fatalf("claimed run status = %q, want claimed", run.Status)
	}
}

// TestClaimOrdinaryClaudeRunUnaffectedByCodexGateLiveDB proves the byte-compatible guarantee: an
// ordinary Claude run (harness='claude', no codex fields) remains claimable by an empty-protocol-caps
// (old) worker — the D3 clause exempts a non-Codex-indicating row, so old workers keep taking Claude
// work exactly as before. This is the too-broad-gate guard for the claimant clause above.
func TestClaimOrdinaryClaudeRunUnaffectedByCodexGateLiveDB(t *testing.T) {
	e := setupInterlockLiveDB(t)
	incapable := e.seedWorker(t, nil)     // no protocol capabilities (an old worker)
	runID := e.seedQueuedRun(t, nil, nil) // ordinary Claude run: harness defaults to 'claude'

	run, err := e.q.ClaimRun(e.ctx, e.claimParams(incapable, []string{}, false))
	if err != nil {
		t.Fatalf("ordinary Claude run must be claimable by an old (no-protocol-cap) worker: %v", err)
	}
	if run.ID != runID {
		t.Fatalf("claimed %v, want %v", run.ID, runID)
	}
	if run.Harness != harnessClaude {
		t.Fatalf("ordinary run harness = %q, want claude", run.Harness)
	}
}

// TestClaimWorkerHostCodexSourcePlacementLiveDB keeps the host-owned source as a
// hard exact-worker gate. It uses ClaimRun's generated SQL against Postgres because
// the EXISTS predicate cannot be meaningfully proven by a fake store.
func TestClaimWorkerHostCodexSourcePlacementLiveDB(t *testing.T) {
	for _, tc := range []struct {
		name       string
		ready      bool
		revision   int64
		capability bool
		owner      bool
		wantClaim  bool
	}{
		{"own ready exact source", true, 7, true, true, true},
		{"unready source", false, 7, true, true, false},
		{"revision mismatch", true, 8, true, true, false},
		{"another ready worker reports the same source", true, 7, true, false, false},
		{"host capability absent", true, 7, false, true, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			e := setupInterlockLiveDB(t)
			caps := []string{capability.CodexHarnessV1, capability.CodexRuntimeV2}
			if tc.capability {
				caps = append(caps, capability.CodexHostLoginV1)
			}
			claimant := e.seedWorker(t, caps)
			owner := claimant
			if !tc.owner {
				owner = e.seedWorker(t, append(caps, capability.CodexHostLoginV1))
			}
			sourceID := uuid.NewString()
			e.exec(t, `UPDATE workers
			           SET codex_host_source_id=$2, codex_host_source_revision=$3, codex_host_source_ready=$4
			           WHERE id=$1`, owner, sourceID, int64(7), tc.ready)
			if !tc.owner {
				e.exec(t, `UPDATE workers
				           SET codex_host_source_id=$2, codex_host_source_revision=$3, codex_host_source_ready=true
				           WHERE id=$1`, claimant, sourceID, int64(7))
			}
			runID := e.seedCodexQueuedRun(t)
			e.exec(t, `UPDATE runs
			           SET codex_credential_source_kind='worker_host',
			               codex_credential_source_id=$2,
			               codex_credential_source_revision=$3,
			               codex_credential_source_worker_id=$4
			           WHERE id=$1`, runID, sourceID, tc.revision, owner)

			run, err := e.q.ClaimRun(e.ctx, e.claimParams(claimant, caps, false))
			if tc.wantClaim {
				if err != nil {
					t.Fatalf("own ready source must claim: %v", err)
				}
				if run.ID != runID {
					t.Fatalf("claimed %v, want %v", run.ID, runID)
				}
				return
			}
			if !errors.Is(err, pgx.ErrNoRows) {
				t.Fatalf("host-gated run claimed by ineligible worker: run=%v err=%v", run.ID, err)
			}
			if status := e.runStatus(t, runID); status != "queued" {
				t.Fatalf("blocked host run status=%q, want queued", status)
			}
		})
	}
}

func TestClaimWorkerHostCodexSourceRejectsNonOwnerBeforeClaimLiveDB(t *testing.T) {
	e := setupInterlockLiveDB(t)
	caps := []string{capability.CodexHarnessV1, capability.CodexRuntimeV2, capability.CodexHostLoginV1}
	owner := e.seedWorker(t, caps)
	nonOwner := e.seedWorker(t, caps)
	sourceID := uuid.NewString()
	e.exec(t, `UPDATE workers
	           SET codex_host_source_id=$2, codex_host_source_revision=7, codex_host_source_ready=true
	           WHERE id=$1`, owner, sourceID)
	e.exec(t, `UPDATE workers
	           SET codex_host_source_id=$2, codex_host_source_revision=7, codex_host_source_ready=true
	           WHERE id=$1`, nonOwner, sourceID)
	runID := e.seedCodexQueuedRun(t)
	e.exec(t, `UPDATE runs
	           SET codex_credential_source_kind='worker_host',
	               codex_credential_source_id=$2,
	               codex_credential_source_revision=7,
	               codex_credential_source_worker_id=$3
	           WHERE id=$1`, runID, sourceID, owner)

	if _, err := e.q.ClaimRun(e.ctx, e.claimParams(nonOwner, caps, false)); !errors.Is(err, pgx.ErrNoRows) {
		t.Fatalf("non-owning worker claim error=%v, want no rows", err)
	}
	if status := e.runStatus(t, runID); status != "queued" {
		t.Fatalf("non-owner claim status=%q, want queued", status)
	}
	claimed, err := e.q.ClaimRun(e.ctx, e.claimParams(owner, caps, false))
	if err != nil {
		t.Fatalf("owning worker claim: %v", err)
	}
	if claimed.ID != runID {
		t.Fatalf("claimed %v, want %v", claimed.ID, runID)
	}
}

func TestClaimWorkerHostCodexSourcePeerSpreadLiveDB(t *testing.T) {
	e := setupInterlockLiveDB(t)
	caps := []string{capability.CodexHarnessV1, capability.CodexRuntimeV2, capability.CodexHostLoginV1}
	owner := e.seedSpreadWorker(t, caps, 2)
	e.seedActiveRunOwnedBy(t, owner)
	e.seedSpreadWorker(t, caps, 2)
	sourceID := uuid.NewString()
	e.exec(t, `UPDATE workers
	           SET codex_host_source_id=$2, codex_host_source_revision=7, codex_host_source_ready=true
	           WHERE id=$1`, owner, sourceID)
	runID := e.seedCodexQueuedRun(t)
	e.exec(t, `UPDATE runs
	           SET codex_credential_source_kind='worker_host',
	               codex_credential_source_id=$2,
	               codex_credential_source_revision=7,
	               codex_credential_source_worker_id=$3
	           WHERE id=$1`, runID, sourceID, owner)

	run, err := e.q.ClaimRun(e.ctx, e.claimParams(owner, caps, false))
	if err != nil {
		t.Fatalf("busy owning worker must claim when the idle peer cannot use its host source: %v", err)
	}
	if run.ID != runID {
		t.Fatalf("claimed %v, want %v", run.ID, runID)
	}
}

func TestWorkerHostCodexSourcePlacementReadersLiveDB(t *testing.T) {
	caps := []string{capability.CodexHarnessV1, capability.CodexRuntimeV2, capability.CodexHostLoginV1}

	placement := func(t *testing.T, e interlockLiveDB, runID uuid.UUID) (bool, bool) {
		t.Helper()
		now := time.Now()
		common := store.ListUnplaceableQueuedRunsForEphemeralParams{
			CrossCheckEvaluatedAt:    pgtype.Timestamptz{Time: now, Valid: true},
			CrossCheckAffinityCutoff: pgtype.Timestamptz{Time: now.Add(-time.Minute), Valid: true},
			BackgroundGraceCutoff:    pgtype.Timestamptz{Time: now.Add(-time.Minute), Valid: true},
			CodexCuratedModels:       codexCuratedModelsSlice(), DockerRepoAllowlist: []uuid.UUID{},
			EphemeralLease: pgtype.Interval{Valid: true}, MaxPerUser: 1000, MaxRows: 1000,
		}
		gaps, err := e.q.ListUnplaceableQueuedRunsForEphemeral(e.ctx, common)
		if err != nil {
			t.Fatal(err)
		}
		saturated, err := e.q.ListSaturationQueuedRunsForEphemeral(e.ctx, store.ListSaturationQueuedRunsForEphemeralParams{
			AffinityCutoff: common.AffinityCutoff, StaleRequeueCutoff: common.StaleRequeueCutoff,
			CrossCheckEvaluatedAt: common.CrossCheckEvaluatedAt, CrossCheckAffinityCutoff: common.CrossCheckAffinityCutoff,
			BackgroundGraceCutoff: common.BackgroundGraceCutoff, CodexCuratedModels: common.CodexCuratedModels,
			DockerRepoAllowlist: common.DockerRepoAllowlist, EphemeralLease: common.EphemeralLease,
			SaturationDelay: pgtype.Interval{Valid: true}, MaxPerUser: common.MaxPerUser, MaxRows: common.MaxRows,
		})
		if err != nil {
			t.Fatal(err)
		}
		in := func(rows []store.ListUnplaceableQueuedRunsForEphemeralRow) bool {
			return slices.ContainsFunc(rows, func(row store.ListUnplaceableQueuedRunsForEphemeralRow) bool { return row.ID == runID })
		}
		inSaturation := slices.ContainsFunc(saturated, func(row store.ListSaturationQueuedRunsForEphemeralRow) bool { return row.ID == runID })
		return in(gaps), inSaturation
	}

	t.Run("ready owner is the only claimable worker", func(t *testing.T) {
		e := setupInterlockLiveDB(t)
		e.exec(t, `UPDATE users SET ephemeral_workers_enabled=true WHERE id=$1`, e.userID)
		owner := e.seedSpreadWorker(t, caps, 1)
		e.seedSpreadWorker(t, caps, 1)
		sourceID := uuid.NewString()
		e.exec(t, `UPDATE workers SET codex_host_source_id=$2, codex_host_source_revision=7, codex_host_source_ready=true WHERE id=$1`, owner, sourceID)
		runID := e.seedCodexQueuedRun(t)
		e.exec(t, `UPDATE runs SET codex_credential_source_kind='worker_host', codex_credential_source_id=$2, codex_credential_source_revision=7, codex_credential_source_worker_id=$3 WHERE id=$1`, runID, sourceID, owner)
		now := time.Now()
		count, err := e.q.CountOnlineWorkersClaimableForRun(e.ctx, store.CountOnlineWorkersClaimableForRunParams{
			RunID: runID, HeartbeatCutoff: pgtype.Timestamptz{Time: now.Add(-time.Minute), Valid: true},
			AffinityCutoff:        pgtype.Timestamptz{Time: now.Add(-time.Minute), Valid: true},
			CrossCheckEvaluatedAt: pgtype.Timestamptz{Time: now, Valid: true}, CrossCheckAffinityCutoff: pgtype.Timestamptz{Time: now.Add(-time.Minute), Valid: true},
			CapabilityAware: true, CodexCuratedModels: codexCuratedModelsSlice(), DockerRepoAllowlist: []uuid.UUID{}, EphemeralLease: pgtype.Interval{Valid: true},
		})
		if err != nil {
			t.Fatal(err)
		}
		if count.Claimable != 1 {
			t.Fatalf("host-bound claimable workers=%d, want only owner", count.Claimable)
		}
		gap, _ := placement(t, e, runID)
		if gap {
			t.Fatal("ready host-bound owner must not be reported as a capability gap")
		}
	})

	t.Run("offline owner is neither provisioning demand nor peer-claimable", func(t *testing.T) {
		e := setupInterlockLiveDB(t)
		e.exec(t, `UPDATE users SET ephemeral_workers_enabled=true WHERE id=$1`, e.userID)
		owner := e.seedSpreadWorker(t, caps, 1)
		peer := e.seedSpreadWorker(t, caps, 1)
		sourceID := uuid.NewString()
		e.exec(t, `UPDATE workers SET codex_host_source_id=$2, codex_host_source_revision=7, codex_host_source_ready=true, status='offline' WHERE id=$1`, owner, sourceID)
		runID := e.seedCodexQueuedRun(t)
		e.exec(t, `UPDATE runs SET codex_credential_source_kind='worker_host', codex_credential_source_id=$2, codex_credential_source_revision=7, codex_credential_source_worker_id=$3, status_since=now()-interval '1 hour' WHERE id=$1`, runID, sourceID, owner)
		gap, saturated := placement(t, e, runID)
		if gap || saturated {
			t.Fatalf("offline host owner placement gap=%t saturation=%t, want false false", gap, saturated)
		}
		if _, err := e.q.ClaimRun(e.ctx, e.claimParams(peer, caps, false)); !errors.Is(err, pgx.ErrNoRows) {
			t.Fatalf("peer claim error=%v, want no rows", err)
		}
	})

	t.Run("busy owner is excluded from saturation despite an idle non-owning peer", func(t *testing.T) {
		e := setupInterlockLiveDB(t)
		e.exec(t, `UPDATE users SET ephemeral_workers_enabled=true WHERE id=$1`, e.userID)
		owner := e.seedSpreadWorker(t, caps, 1)
		e.seedActiveRunOwnedBy(t, owner)
		e.seedSpreadWorker(t, caps, 1)
		sourceID := uuid.NewString()
		e.exec(t, `UPDATE workers SET codex_host_source_id=$2, codex_host_source_revision=7, codex_host_source_ready=true WHERE id=$1`, owner, sourceID)
		runID := e.seedCodexQueuedRun(t)
		e.exec(t, `UPDATE runs SET codex_credential_source_kind='worker_host', codex_credential_source_id=$2, codex_credential_source_revision=7, codex_credential_source_worker_id=$3, status_since=now()-interval '1 hour' WHERE id=$1`, runID, sourceID, owner)
		gap, saturated := placement(t, e, runID)
		if gap || saturated {
			t.Fatalf("busy host owner placement gap=%t saturation=%t, want false false", gap, saturated)
		}
		ordinary := e.seedQueuedRun(t, nil, nil)
		gap, saturated = placement(t, e, ordinary)
		if gap || saturated {
			t.Fatalf("ordinary run placement gap=%t saturation=%t, want false false", gap, saturated)
		}
	})
}

func TestGetReadyWorkerCodexHostSourceLiveDB(t *testing.T) {
	e := setupInterlockLiveDB(t)
	readySource := uuid.NewString()
	unreadySource := uuid.NewString()
	noCapabilitySource := uuid.NewString()
	ready := e.seedHeartbeatWorker(t, []string{capability.CodexHostLoginV1, capability.CodexHarnessV1, capability.CodexRuntimeV2})
	secondReady := e.seedHeartbeatWorker(t, []string{capability.CodexHostLoginV1, capability.CodexHarnessV1, capability.CodexRuntimeV2})
	highID := uuid.MustParse("ffffffff-ffff-4fff-8fff-ffffffffffff")
	lowID := uuid.MustParse("00000000-0000-4000-8000-000000000001")
	e.exec(t, `UPDATE workers SET id=$2 WHERE id=$1`, ready, highID)
	e.exec(t, `UPDATE workers SET id=$2 WHERE id=$1`, secondReady, lowID)
	ready = highID
	secondReady = lowID
	unready := e.seedHeartbeatWorker(t, []string{capability.CodexHostLoginV1, capability.CodexHarnessV1, capability.CodexRuntimeV2})
	noCapability := e.seedHeartbeatWorker(t, []string{capability.CodexHostLoginV1, capability.CodexHarnessV1})
	e.exec(t, `UPDATE workers SET codex_host_source_id=$2, codex_host_source_revision=3,
	           codex_host_source_ready=true WHERE id=$1`, ready, readySource)
	e.exec(t, `UPDATE workers SET codex_host_source_id=$2, codex_host_source_revision=3,
	           codex_host_source_ready=true WHERE id=$1`, secondReady, readySource)
	e.exec(t, `UPDATE workers SET codex_host_source_id=$2, codex_host_source_revision=3,
	           codex_host_source_ready=false WHERE id=$1`, unready, unreadySource)
	e.exec(t, `UPDATE workers SET codex_host_source_id=$2, codex_host_source_revision=3,
	           codex_host_source_ready=true WHERE id=$1`, noCapability, noCapabilitySource)
	for _, tc := range []struct {
		name string
		user uuid.UUID
		id   string
		rev  int64
		want bool
	}{
		{"ready own source", e.userID, readySource, 3, true},
		{"unready source", e.userID, unreadySource, 3, false},
		{"revision mismatch", e.userID, readySource, 2, false},
		{"other owner", uuid.New(), readySource, 3, false},
		{"missing runtime capability", e.userID, noCapabilitySource, 3, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, err := e.q.GetReadyWorkerCodexHostSource(e.ctx, store.GetReadyWorkerCodexHostSourceParams{
				UserID: tc.user, SourceID: tc.id, SourceRevision: tc.rev, HeartbeatCutoff: pgtype.Timestamptz{Time: time.Now().Add(-time.Minute), Valid: true},
			})
			if tc.want {
				if err != nil {
					t.Fatalf("GetReadyWorkerCodexHostSource: %v", err)
				}
				if got != secondReady {
					t.Fatalf("ready worker=%v, want lowest matching worker=%v", got, secondReady)
				}
				return
			}
			if !errors.Is(err, pgx.ErrNoRows) {
				t.Fatalf("GetReadyWorkerCodexHostSource error=%v, want no rows", err)
			}
		})
	}
}

// TestClaimCodexPeerSpreadMirrorLiveDB covers the D3 peer fleet-spread MIRROR clause. Fleet-aware
// spread (PRD #216) defers a queued run to a strictly-better idle peer instead of a busy claimant
// taking it — but for a CODEX-INDICATING run that peer must ALSO advertise codex_harness_v1, or the
// run would be deferred to a peer that can never claim it (the D3 claimant clause blocks the peer),
// making the run permanently unclaimable by being preferred. The two sub-cases differ ONLY in the idle
// peer's protocol_capabilities, isolating the mirror clause.
//
// CALIBRATION (peer clause): delete the peer Codex mirror clause in runtime.sql (the mirrored
// `AND (NOT (r.harness = 'codex' OR ...) OR 'codex_harness_v1' = ANY(p.protocol_capabilities))` inside
// the NOT EXISTS peer block) and regenerate — the incapable-peer sub-case then defers to the incapable
// peer (ErrNoRows) instead of the busy claimant claiming, and that sub-case fails.
func TestClaimCodexPeerSpreadMirrorLiveDB(t *testing.T) {
	e := setupInterlockLiveDB(t)

	// A busy CAPABLE claimant: cap=2 with 1 active run, so it is NOT minimum-loaded and the spread rule
	// CAN defer its claim to a strictly-better (idle) peer. It advertises codex_harness_v1, so the
	// claimant's OWN D3 clause never blocks it — isolating the PEER clause.
	newBusyClaimant := func() uuid.UUID {
		me := e.seedSpreadWorker(t, []string{capability.CodexHarnessV1, capability.CodexRuntimeV2}, 2)
		e.seedActiveRunOwnedBy(t, me)
		return me
	}

	t.Run("incapable idle peer is NOT a spread target; busy claimant claims", func(t *testing.T) {
		me := newBusyClaimant()
		e.seedSpreadWorker(t, nil, 2) // idle, cap=2, but advertises no protocol capability
		runID := e.seedCodexQueuedRun(t)

		run, err := e.q.ClaimRun(e.ctx, e.claimParams(me, []string{capability.CodexHarnessV1, capability.CodexRuntimeV2}, false))
		if err != nil {
			t.Fatalf("busy claimant must claim the codex-indicating run — the incapable peer is not a valid deferral target (err=%v); the mirror clause must exclude it", err)
		}
		if run.ID != runID {
			t.Fatalf("claimed %v, want %v", run.ID, runID)
		}
		if run.Status != "claimed" {
			t.Fatalf("claimed run status = %q, want claimed", run.Status)
		}
	})

	t.Run("capable idle peer IS a spread target; busy claimant defers", func(t *testing.T) {
		me := newBusyClaimant()
		e.seedSpreadWorker(t, []string{capability.CodexHarnessV1, capability.CodexRuntimeV2}, 2) // idle, cap=2, advertises codex_harness_v1
		runID := e.seedCodexQueuedRun(t)

		if _, err := e.q.ClaimRun(e.ctx, e.claimParams(me, []string{capability.CodexHarnessV1, capability.CodexRuntimeV2}, false)); !errors.Is(err, pgx.ErrNoRows) {
			t.Fatalf("busy claimant must DEFER the codex-indicating run to the capable idle peer (err=%v); the mirror clause admits a capable peer as a spread target", err)
		}
		if s := e.runStatus(t, runID); s != "queued" {
			t.Fatalf("deferred run must stay queued; status = %q", s)
		}
	})
}

// TestQueuedReasonNoCodexCapableWorkerLiveDB drives the real Service.queuedReason: a CODEX-INDICATING
// queued run whose owner has NO online worker advertising codex_harness_v1 surfaces the D3-fixed prose
// reasonNoCodexCapableWorker ("no Codex-capable worker is online"), one WITH a capable worker falls
// through, and an ordinary Claude run never reaches this rung. This pins the new
// CountOnlineWorkersSatisfyingCodexHarness SQL and the health-rung wiring together.
//
// CALIBRATION (fleet-count / queued-reason rung): delete the Codex rung in health.go (the
// `if r.Harness == harnessCodex || ... { CountOnlineWorkersSatisfyingCodexHarness ... }` block) — the
// first sub-case then falls through to a generic wait and this test fails.
func TestQueuedReasonNoCodexCapableWorkerLiveDB(t *testing.T) {
	e := setupInterlockLiveDB(t)
	svc := e.permitService(t)

	t.Run("no codex-capable worker online -> reasonNoCodexCapableWorker", func(t *testing.T) {
		e.seedWorker(t, nil) // one ONLINE worker with no protocol capabilities
		runID := e.seedCodexQueuedRun(t)
		got := svc.queuedReason(e.ctx, time.Now(), e.codexIndicatingQueuedRow(runID), thWithLimit(testCustodyLimit))
		if got != reasonNoCodexCapableWorker {
			t.Fatalf("queuedReason = %q, want %q — a codex-indicating queued run with no codex-capable worker online must surface the Codex-capability block", got, reasonNoCodexCapableWorker)
		}
		// Pin the exact D3 user-visible prose so a copy-edit here is a deliberate, reviewed change.
		if reasonNoCodexCapableWorker != "no Codex-capable worker is online" {
			t.Fatalf("reasonNoCodexCapableWorker = %q, want the D3-fixed prose", reasonNoCodexCapableWorker)
		}
	})

	t.Run("codex-capable worker online -> falls through", func(t *testing.T) {
		e.seedWorker(t, []string{capability.CodexHarnessV1, capability.CodexRuntimeV2}) // an ONLINE codex-capable worker
		runID := e.seedCodexQueuedRun(t)
		got := svc.queuedReason(e.ctx, time.Now(), e.codexIndicatingQueuedRow(runID), thWithLimit(testCustodyLimit))
		if got != reasonWaitingWorker {
			t.Fatalf("queuedReason = %q, want %q", got, reasonWaitingWorker)
		}
	})

	t.Run("ordinary Claude run never gets the Codex reason", func(t *testing.T) {
		e.seedWorker(t, nil) // no codex-capable worker
		runID := e.seedQueuedRun(t, nil, nil)
		row := e.codexIndicatingQueuedRow(runID)
		row.Harness = harnessClaude // an ordinary Claude run is not codex-indicating
		if got := svc.queuedReason(e.ctx, time.Now(), row, thWithLimit(testCustodyLimit)); got != reasonWaitingWorker {
			t.Fatalf("queuedReason = %q, want %q", got, reasonWaitingWorker)
		}
	})
}

// TestClaimCodexVocabularyRemovalCalibrationLiveDB registers a worker through the REAL Service.Register
// path (which runs capability.FilterProtocol over the self-reported protocol capabilities) and proves
// that a worker registered advertising codex_harness_v1 then claims a codex-indicating run.
//
// CALIBRATION (protocol vocabulary): remove CodexHarnessV1 from capability.protocolVocabulary — because
// FilterProtocol silently DROPS a string that is not in the vocabulary, Register then stores no
// codex_harness_v1 for the worker, the stored-set assertion fails, and (were it not for that) the claim
// would fail with ErrNoRows. That is exactly the D3-required calibrated failure ("removing
// codex_harness_v1 must make the capable-worker claim test fail").
func TestClaimCodexVocabularyRemovalCalibrationLiveDB(t *testing.T) {
	e := setupInterlockLiveDB(t)
	svc := e.permitService(t)

	// A bare worker row Register can UPDATE (RegisterWorker is an UPDATE-by-id).
	workerID := e.seedWorker(t, nil)
	if _, _, err := svc.Register(e.ctx, store.Worker{ID: workerID, UserID: e.userID}, "v-test", "base", nil, nil, []string{capability.CodexHarnessV1, capability.CodexRuntimeV2}, nil); err != nil {
		t.Fatalf("Register: %v", err)
	}

	// Read back the STORED protocol_capabilities (what FilterProtocol persisted). This assertion is the
	// calibration tripwire: with the capability removed from the vocabulary, the stored set is empty.
	stored := e.workerProtocolCaps(t, workerID)
	if !slices.Contains(stored, capability.CodexHarnessV1) {
		t.Fatalf("registered worker stored protocol_capabilities = %v, want to contain %q (FilterProtocol dropped it — codex_harness_v1 missing from the protocol vocabulary?)", stored, capability.CodexHarnessV1)
	}

	// The worker claims the codex-indicating run using its STORED caps, exactly as the production claim
	// path threads wkr.ProtocolCapabilities into @worker_protocol_caps.
	runID := e.seedCodexQueuedRun(t)
	run, err := e.q.ClaimRun(e.ctx, e.claimParams(workerID, stored, false))
	if err != nil {
		t.Fatalf("a worker registered with codex_harness_v1 must claim the codex-indicating run: %v", err)
	}
	if run.ID != runID {
		t.Fatalf("claimed %v, want %v", run.ID, runID)
	}
}

// workerProtocolCaps reads a worker's stored protocol_capabilities column.
func (e interlockLiveDB) workerProtocolCaps(t *testing.T, workerID uuid.UUID) []string {
	t.Helper()
	var caps []string
	if err := e.pool.QueryRow(e.ctx, `SELECT protocol_capabilities FROM workers WHERE id = $1`, workerID).Scan(&caps); err != nil {
		t.Fatalf("read worker protocol_capabilities: %v", err)
	}
	return caps
}
