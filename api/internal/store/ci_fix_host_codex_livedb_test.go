package store_test

import (
	"testing"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"

	"github.com/vtmocanu/uzi/api/internal/store"
)

func TestCIFixBranchEligibilityLiveDB(t *testing.T) {
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
	seedRun := func(repo uuid.UUID, branch, source string) uuid.UUID {
		id := uuid.New()
		issueIID++
		if source == "worker_host" {
			mustExec(ctx, t, pool, `INSERT INTO runs (id,user_id,repo_id,kind,issue_iid,issue_title,issue_description,status,branch,harness,
				codex_credential_source_kind,codex_credential_source_id,codex_credential_source_revision,codex_credential_source_worker_id)
				VALUES ($1,$2,$3,'issue',$4,'t','d','queued',$5,'codex','worker_host',$6,1,$7)`, id, user, repo, issueIID, branch, uuid.NewString(), uuid.New())
			return id
		}
		mustExec(ctx, t, pool, `INSERT INTO runs (id,user_id,repo_id,kind,issue_iid,issue_title,issue_description,status,branch,harness)
			VALUES ($1,$2,$3,'issue',$4,'t','d','queued',$5,'codex')`, id, user, repo, issueIID, branch)
		return id
	}
	seedRun(repo, branch, "server")

	has := func(repo uuid.UUID, branch string) bool {
		t.Helper()
		got, err := q.GetCIFixBranchEligibility(ctx, store.GetCIFixBranchEligibilityParams{
			PipelineSha: "abc1234", RepoID: repo, Branch: pgtype.Text{String: branch, Valid: true},
		})
		if err != nil {
			t.Fatal(err)
		}
		return got.HostBound
	}
	if has(repo, branch) {
		t.Fatal("server-credential run matched worker-host guard")
	}
	host := seedRun(repo, branch, "worker_host")
	if !has(repo, branch) {
		t.Fatal("worker-host run on the same repo and branch did not match")
	}
	if has(repo, otherBranch) {
		t.Fatal("worker-host run on another branch matched")
	}
	if has(otherRepo, branch) {
		t.Fatal("worker-host run on another repo matched")
	}
	server := seedRun(repo, branch, "server")
	mustExec(ctx, t, pool, `UPDATE runs SET created_at = now() - interval '1 day' WHERE id = $1`, host)
	mustExec(ctx, t, pool, `UPDATE runs SET created_at = now(),status='completed',status_since=now()+interval '1 second' WHERE id = $1`, server)
	if !has(repo, branch) {
		t.Fatal("legacy branch metadata without a completion head excluded host custody")
	}
	mustExec(ctx, t, pool, `UPDATE runs SET created_at = now() + interval '1 day',status_since=now()+interval '2 seconds' WHERE id = $1`, host)
	if !has(repo, branch) {
		t.Fatal("current host-backed source run was not refused after branch reuse")
	}
	mustExec(ctx, t, pool, `UPDATE runs SET status='completed',status_since=now()-interval '1 hour' WHERE repo_id=$1`, repo)
	publishing := uuid.New()
	mustExec(ctx, t, pool, `INSERT INTO runs (id,user_id,repo_id,kind,issue_iid,issue_title,issue_description,status,harness,
		codex_credential_source_kind,codex_credential_source_id,codex_credential_source_revision,codex_credential_source_worker_id,created_at)
		VALUES ($1,$2,$3,'issue',42,'publishing','d','running','codex','worker_host',$4,1,$5,now()+interval '2 days')`,
		publishing, user, repo, uuid.NewString(), uuid.New())
	eligibility := func(ref string, host, active bool) {
		t.Helper()
		got, err := q.GetCIFixBranchEligibility(ctx, store.GetCIFixBranchEligibilityParams{
			PipelineSha: "abc1234", RepoID: repo, Branch: pgtype.Text{String: ref, Valid: true},
		})
		if err != nil {
			t.Fatal(err)
		}
		if got.HostBound != host || got.Active != active {
			t.Fatalf("ref=%s eligibility=%+v, want host=%t active=%t", ref, got, host, active)
		}
	}
	eligibility(branch, true, true)
	eligibility("agent/issue-042", false, false)
	mustExec(ctx, t, pool, `UPDATE runs SET status='completed',branch=$2 WHERE id=$1`, publishing, branch)
	eligibility(branch, true, false)
	for _, status := range []string{"cancelled", "failed"} {
		attempt := uuid.New()
		mustExec(ctx, t, pool, `INSERT INTO runs (id,user_id,repo_id,kind,issue_iid,issue_title,issue_description,status,harness,created_at)
			VALUES ($1,$2,$3,'issue',42,'unstarted','d',$4,'claude',now()+interval '3 days')`, attempt, user, repo, status)
		eligibility(branch, true, false)
	}
	serverPublishing := uuid.New()
	mustExec(ctx, t, pool, `INSERT INTO runs (id,user_id,repo_id,kind,issue_iid,issue_title,issue_description,status,harness,created_at)
		VALUES ($1,$2,$3,'issue',42,'replacement','d','running','claude',now()+interval '3 days')`, serverPublishing, user, repo)
	eligibility(branch, true, true)
	mustExec(ctx, t, pool, `UPDATE runs SET status='completed',branch=$2,status_since=now()+interval '1 second' WHERE id=$1`, serverPublishing, branch)
	eligibility(branch, true, false)

}
