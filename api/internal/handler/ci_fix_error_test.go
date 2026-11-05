package handler

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/vtmocanu/uzi/api/internal/workersvc"
)

func TestWriteCIFixCreateErrorHostCodexRefusals(t *testing.T) {
	tests := []struct {
		name   string
		err    error
		reason string
	}{
		{"source unavailable", workersvc.ErrHostCodexSourceUnavailable, "host_codex_source_unavailable"},
		{"derived run unsupported", workersvc.ErrHostCodexDerivedRunUnsupported, "host_codex_derived_run_unsupported"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			rec := httptest.NewRecorder()
			writeCIFixCreateError(rec, tt.err)
			if rec.Code != http.StatusConflict {
				t.Fatalf("status = %d, want 409; body=%s", rec.Code, rec.Body.String())
			}
			var body map[string]any
			if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
				t.Fatal(err)
			}
			if body["reason"] != tt.reason {
				t.Fatalf("reason = %v, want %s", body["reason"], tt.reason)
			}
		})
	}
}

func TestWriteCIFixCreateErrorBranchParentChanged(t *testing.T) {
	rec := httptest.NewRecorder()
	writeCIFixCreateError(rec, workersvc.ErrCIFixBranchParentChanged)
	if rec.Code != http.StatusConflict {
		t.Fatalf("status = %d, want 409; body=%s", rec.Code, rec.Body.String())
	}
	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body["reason"] != "ci_fix_branch_parent_changed" {
		t.Fatalf("reason = %v, want ci_fix_branch_parent_changed", body["reason"])
	}
}

// These worker-route helpers are the terminal response seam for their respective
// entry points. Keep the machine-readable conflict reason identical to the manual
// CI-fix and owner-route mappings.
func TestHostCodexWorkerRouteMappings(t *testing.T) {
	tests := []struct {
		name  string
		write func(http.ResponseWriter)
	}{
		{"judge worker", func(w http.ResponseWriter) { writeAdviceClaimRefusal(w, workersvc.ErrHostCodexSourceUnavailable) }},
		{"cross-check worker", func(w http.ResponseWriter) { crossCheckError(w, workersvc.ErrHostCodexDerivedRunUnsupported) }},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			rec := httptest.NewRecorder()
			tt.write(rec)
			if rec.Code != http.StatusConflict {
				t.Fatalf("status = %d, want 409; body=%s", rec.Code, rec.Body.String())
			}
			var body map[string]any
			if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
				t.Fatal(err)
			}
			want := "host_codex_derived_run_unsupported"
			if tt.name == "judge worker" {
				want = "host_codex_source_unavailable"
			}
			if body["reason"] != want {
				t.Fatalf("reason = %v, want %s", body["reason"], want)
			}
		})
	}
}
