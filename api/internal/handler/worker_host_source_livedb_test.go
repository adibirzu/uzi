package handler

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/google/uuid"

	mw "github.com/vtmocanu/uzi/api/internal/middleware"
	"github.com/vtmocanu/uzi/api/internal/store"
)

// The source columns are written only when source metadata is present. This needs
// the real query because Handler owns *store.Queries rather than a narrow seam.
// It self-skips with the package's other LiveDB tests outside the store runner.
func TestWorkerHostCodexSourceAbsentLeavesColumnsUntouchedLiveDB(t *testing.T) {
	ctx := context.Background()
	f := newStartRunGuardFixture(ctx, t)
	workerID, sourceID := uuid.New(), uuid.NewString()
	mustExecT(ctx, t, f.pool, `INSERT INTO workers
		(id, user_id, name, token_hash, status, codex_host_source_id, codex_host_source_revision, codex_host_source_ready)
		VALUES ($1, $2, 'host-source-absence', $3, 'online', $4, 9, true)`,
		workerID, f.owner.ID, []byte("host-source-absence-"+workerID.String()), sourceID)
	worker := store.Worker{ID: workerID, UserID: f.owner.ID}
	request := func(path, body string) *http.Request {
		r := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
		return r.WithContext(mw.ContextWithWorker(r.Context(), worker))
	}

	register := httptest.NewRecorder()
	f.h.WorkerRegister(register, request("/api/worker/register", `{"version":"test"}`))
	if register.Code != http.StatusOK {
		t.Fatalf("register status=%d: %s", register.Code, register.Body.String())
	}
	heartbeat := httptest.NewRecorder()
	f.h.WorkerHeartbeat(heartbeat, request("/api/worker/heartbeat", `{"version":"test"}`))
	if heartbeat.Code != http.StatusOK {
		t.Fatalf("heartbeat status=%d: %s", heartbeat.Code, heartbeat.Body.String())
	}

	var gotID string
	var gotRevision int64
	var gotReady bool
	if err := f.pool.QueryRow(ctx, `SELECT codex_host_source_id, codex_host_source_revision, codex_host_source_ready FROM workers WHERE id=$1`, workerID).Scan(&gotID, &gotRevision, &gotReady); err != nil {
		t.Fatalf("read source columns: %v", err)
	}
	if gotID != sourceID || gotRevision != 9 || !gotReady {
		t.Fatalf("absent source metadata changed host columns: id=%q revision=%d ready=%t", gotID, gotRevision, gotReady)
	}
}
