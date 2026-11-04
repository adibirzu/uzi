package handler

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/vtmocanu/uzi/api/internal/workersvc"
)

func TestWriteCIFixCreateErrorHostCodexDerivedRunUnsupported(t *testing.T) {
	rec := httptest.NewRecorder()
	writeCIFixCreateError(rec, workersvc.ErrHostCodexDerivedRunUnsupported)
	if rec.Code != http.StatusConflict {
		t.Fatalf("status = %d, want 409; body=%s", rec.Code, rec.Body.String())
	}
	var body map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body["reason"] != "host_codex_derived_run_unsupported" {
		t.Fatalf("reason = %v, want host_codex_derived_run_unsupported", body["reason"])
	}
}

// These worker-route helpers are the terminal response seam for their respective
// entry points. Keep the machine-readable conflict reason identical to the manual
// CI-fix and owner-route mappings.
func TestHostCodexDerivedRunUnsupportedWorkerRouteMappings(t *testing.T) {
	tests := []struct {
		name  string
		write func(http.ResponseWriter)
	}{
		{"judge worker", func(w http.ResponseWriter) { writeAdviceClaimRefusal(w, workersvc.ErrHostCodexDerivedRunUnsupported) }},
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
			if body["reason"] != "host_codex_derived_run_unsupported" {
				t.Fatalf("reason = %v, want host_codex_derived_run_unsupported", body["reason"])
			}
		})
	}
}
