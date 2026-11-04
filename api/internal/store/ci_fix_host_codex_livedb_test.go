package store_test

import (
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/vtmocanu/uzi/api/internal/store"
)

// TestHasWorkerHostCodexRunForBranchLiveDB pins the derived-run guard to the
// exact (repo, branch) pair and to a worker-host binding. A server-held Codex
// run on the same branch must not block a CI fix.
func TestHasWorkerHostCodexRunForBranchLiveDB(t *testing.T) {
	ctx, q, pool := autoEligPool(t)
	user := seedBareUser(ctx, t, pool)
	conn := uuid.New()
	mustExec(ctx, t, pool, `INSERT INTO forge_connections (id,user_id,forge_type,base_url,bot_username,bot_forge_user_id,token_ciphertext)
		VALUES ($1,$2,'github','https://forge.e2e','bot',1,$3)`, conn, user, []byte{1})
	seedRepo := func() uuid.UUID {
		id := uuid.New()
		mustExec(ctx, t, pool, `INSERT INTO repos (id,connection_id,forge_project_id,path_with_namespace,web_url,default_branch,enabled)
			VALUES ($1,$2,$3,$4,$5,'main',true)`, id, conn, int64(100+id[0]), "group/"+id.String(), "https://forge.e2e/"+id.String())
		return id
	}
	repo, otherRepo := seedRepo(), seedRepo()
	branch, otherBranch := "agent/issue-42", "agent/issue-43"
	issueIID := int64(0)
	seedRun := func(repo uuid.UUID, branch, source string) {
		id := uuid.New()
		issueIID++
		if source == "worker_host" {
			mustExec(ctx, t, pool, `INSERT INTO runs (id,user_id,repo_id,kind,issue_iid,issue_title,issue_description,status,branch,harness,
				codex_credential_source_kind,codex_credential_source_id,codex_credential_source_revision,codex_credential_source_worker_id)
				VALUES ($1,$2,$3,'issue',$4,'t','d','queued',$5,'codex','worker_host',$6,1,$7)`, id, user, repo, issueIID, branch, uuid.NewString(), uuid.New())
			return
		}
		mustExec(ctx, t, pool, `INSERT INTO runs (id,user_id,repo_id,kind,issue_iid,issue_title,issue_description,status,branch,harness)
			VALUES ($1,$2,$3,'issue',$4,'t','d','queued',$5,'codex')`, id, user, repo, issueIID, branch)
	}
	seedRun(repo, branch, "server")

	has := func(repo uuid.UUID, branch string) bool {
		t.Helper()
		got, err := q.HasWorkerHostCodexRunForBranch(ctx, store.HasWorkerHostCodexRunForBranchParams{
			RepoID: repo, Branch: pgtype.Text{String: branch, Valid: true},
		})
		if err != nil {
			t.Fatal(err)
		}
		return got
	}
	if has(repo, branch) {
		t.Fatal("server-credential run matched worker-host guard")
	}
	seedRun(repo, branch, "worker_host")
	if !has(repo, branch) {
		t.Fatal("worker-host run on the same repo and branch did not match")
	}
	if has(repo, otherBranch) {
		t.Fatal("worker-host run on another branch matched")
	}
	if has(otherRepo, branch) {
		t.Fatal("worker-host run on another repo matched")
	}
}
