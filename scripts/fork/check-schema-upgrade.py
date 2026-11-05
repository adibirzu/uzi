#!/usr/bin/env python3
"""Read-only preflight for the fork's migration-401 numbering collision."""

import json
import os
import subprocess
import sys


QUERY = """
WITH latest AS (
  SELECT DISTINCT ON (version_id) version_id, is_applied
  FROM public.goose_db_version ORDER BY version_id, id DESC
)
SELECT json_build_object(
  'max_version', COALESCE(max(version_id) FILTER (WHERE is_applied), 0),
  'version401', COALESCE(bool_or(version_id = 401 AND is_applied), false),
  'version404', COALESCE(bool_or(version_id = 404 AND is_applied), false),
  'host_columns', (SELECT count(*) FROM information_schema.columns
    WHERE table_schema = 'public' AND (
      (table_name = 'workers' AND column_name IN
        ('codex_host_source_id', 'codex_host_source_revision', 'codex_host_source_ready'))
      OR (table_name = 'runs' AND column_name IN
        ('codex_credential_source_kind', 'codex_credential_source_id',
         'codex_credential_source_revision', 'codex_credential_source_worker_id')))),
  'codex_model', EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'agent_templates'
      AND column_name = 'codex_model')
) FROM latest;
"""


def collision_reason(snapshot):
    """Classify this narrow metadata contract; unknown states never pass."""
    keys = {"max_version", "version401", "version404", "host_columns", "codex_model"}
    if not isinstance(snapshot, dict) or set(snapshot) != keys:
        raise ValueError("invalid metadata")
    if any(type(snapshot[k]) is not bool for k in ("version401", "version404", "codex_model")):
        raise ValueError("invalid metadata")
    if any(type(snapshot[k]) is not int for k in ("max_version", "host_columns")):
        raise ValueError("invalid metadata")
    version, columns = snapshot["max_version"], snapshot["host_columns"]
    if version < 0 or columns < 0 or columns > 7:
        raise ValueError("invalid metadata")
    if version > 404:
        return "checker-target-outdated"
    if snapshot["version404"] != (version == 404):
        return "migration-history-mismatch"
    if snapshot["version401"] != (version >= 401):
        return "migration-history-mismatch"
    if columns and not snapshot["version404"]:
        return "legacy-host-401" if columns == 7 and snapshot["version401"] else "unrecognized-host-schema"
    if snapshot["version404"] and columns != 7:
        return "unrecognized-host-schema"
    if snapshot["version401"] != snapshot["codex_model"]:
        return "upstream-401-schema-mismatch"
    return None


def main():
    if len(sys.argv) != 1:
        print("Usage: python3 scripts/fork/check-schema-upgrade.py (uses standard PG connection environment)", file=sys.stderr)
        return 2
    environment = os.environ.copy()
    environment["PGOPTIONS"] = environment.get("PGOPTIONS", "") + (
        " -c default_transaction_read_only=on -c statement_timeout=5000 -c lock_timeout=2000"
    )
    try:
        result = subprocess.run(
            ["psql", "-X", "-w", "-A", "-t", "-q", "--set=ON_ERROR_STOP=1", "--command", QUERY],
            env=environment, capture_output=True, timeout=10, check=False,
        )
        if result.returncode != 0 or len(result.stdout) > 2048:
            raise ValueError("metadata unavailable")
        reason = collision_reason(json.loads(result.stdout))
    except (OSError, ValueError, subprocess.TimeoutExpired, RecursionError):
        # Database diagnostics may contain connection details. Do not echo them.
        print("Upgrade check inconclusive: psql or expected schema metadata unavailable. No repair attempted.", file=sys.stderr)
        return 2
    print(json.dumps({"status": "blocked" if reason else "no-known-401-collision", "reason": reason, "target_migration": 404}, sort_keys=True))
    if reason:
        print("Hold deployment; prepare a reviewed upgrade path. This check changes no database state.", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
