package workersvc

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/vtmocanu/uzi/api/internal/store"
)

func TestClaimCodexSecretsWorkerHostIsMetadataOnly(t *testing.T) {
	revision := int64(1)
	b, err := json.Marshal(ClaimCodexSecrets{
		AuthMode:           codexAuthModeSubscription,
		HostSourceID:       "11111111-1111-4111-8111-111111111111",
		HostSourceRevision: &revision,
	})
	if err != nil {
		t.Fatalf("Marshal: %v", err)
	}
	got := string(b)
	for _, forbidden := range []string{"access_token", "refresh_token", "capability", "generation", "chatgpt_account_id"} {
		if strings.Contains(got, forbidden) {
			t.Fatalf("host claim leaked %q: %s", forbidden, got)
		}
	}
	if !strings.Contains(got, `"codex_credential_source"`) || !strings.Contains(got, `"worker_host"`) {
		t.Fatalf("host claim missing source metadata: %s", got)
	}
}

func TestClaimCodexSecretsWorkerHostRejectsServerMaterial(t *testing.T) {
	revision := int64(1)
	_, err := json.Marshal(ClaimCodexSecrets{
		AuthMode: codexAuthModeSubscription, HostSourceID: "11111111-1111-4111-8111-111111111111", HostSourceRevision: &revision,
		AccessToken: "SENTINEL-ACCESS-0001",
	})
	if err == nil {
		t.Fatal("Marshal accepted server-held material on worker-host claim")
	}
}

func TestClaimCodexSecretsWorkerHostRequiresBoundWorker(t *testing.T) {
	owner := uuid.New()
	other := uuid.New()
	revision := int64(1)
	run := store.Run{
		CodexCredentialSourceKind:     pgtype.Text{String: "worker_host", Valid: true},
		CodexCredentialSourceID:       pgtype.Text{String: "11111111-1111-4111-8111-111111111111", Valid: true},
		CodexCredentialSourceRevision: pgtype.Int8{Int64: revision, Valid: true},
		CodexCredentialSourceWorkerID: pgtype.UUID{Bytes: owner, Valid: true},
	}
	wkr := store.Worker{
		ID:                      owner,
		CodexHostSourceID:       pgtype.Text{String: run.CodexCredentialSourceID.String, Valid: true},
		CodexHostSourceRevision: pgtype.Int8{Int64: revision, Valid: true},
		CodexHostSourceReady:    true,
	}
	if _, err := (&Service{}).codexClaimSecrets(context.Background(), wkr, run); err != nil {
		t.Fatalf("bound worker claim secrets: %v", err)
	}
	wkr.ID = other
	if _, err := (&Service{}).codexClaimSecrets(context.Background(), wkr, run); !errors.Is(err, ErrCodexWorkerMismatch) {
		t.Fatalf("non-owning worker err = %v, want ErrCodexWorkerMismatch", err)
	}
}
