package workersvc

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/vtmocanu/uzi/api/internal/store"
)

func TestReconciliationSnapshotOmitsHostCodexPlacementMetadata(t *testing.T) {
	milestones := make([]map[string]string, 96)
	for i := range milestones {
		milestones[i] = map[string]string{
			"id":    "M" + strings.Repeat("x", 8),
			"title": strings.Repeat("x", 48),
		}
	}
	frozen, err := json.Marshal(milestones)
	if err != nil {
		t.Fatal(err)
	}
	run := store.Run{
		ID:                            uuid.New(),
		MilestonesFrozen:              frozen,
		CodexCredentialSourceKind:     pgtype.Text{String: "worker_host", Valid: true},
		CodexCredentialSourceID:       pgtype.Text{String: uuid.NewString(), Valid: true},
		CodexCredentialSourceRevision: pgtype.Int8{Int64: 1, Valid: true},
		CodexCredentialSourceWorkerID: pgtype.UUID{Bytes: uuid.New(), Valid: true},
	}
	snapshot, err := reconciliationSnapshot(run)
	if err != nil {
		t.Fatal(err)
	}
	if len(snapshot) > reconciliationSnapshotBytes {
		t.Fatalf("snapshot length %d exceeds %d", len(snapshot), reconciliationSnapshotBytes)
	}
	var state map[string]json.RawMessage
	if err := json.Unmarshal(snapshot, &state); err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{
		"codex_credential_source_kind",
		"codex_credential_source_id",
		"codex_credential_source_revision",
		"codex_credential_source_worker_id",
	} {
		if _, ok := state[key]; ok {
			t.Fatalf("snapshot retained %s", key)
		}
	}
}
