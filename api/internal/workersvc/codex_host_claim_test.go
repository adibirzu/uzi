package workersvc

import (
	"encoding/json"
	"strings"
	"testing"
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
