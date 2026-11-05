"""Exercise the preflight CLI and its psql process contract without a real login."""

import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


SCRIPT = Path(__file__).with_name("check-schema-upgrade.py")


class UpgradeCheckTest(unittest.TestCase):
    def invoke(self, snapshot=None, *, psql_rc=0, raw=None):
        with tempfile.TemporaryDirectory(prefix="cdr-schema-check-") as directory:
            root = Path(directory)
            psql = root / "psql"
            psql.write_text(
                "#!" + sys.executable + "\n"
                "import json, os, sys\n"
                "from pathlib import Path\n"
                "Path(os.environ['PROBE']).write_text(json.dumps({'args':sys.argv[1:], 'options':os.environ['PGOPTIONS']}))\n"
                "sys.stdout.write(os.environ['RESPONSE'])\n"
                "sys.stderr.write('private database diagnostic')\n"
                "sys.exit(int(os.environ['PSQL_RC']))\n"
            )
            psql.chmod(0o700)
            env = {**os.environ, "PATH": directory + os.pathsep + os.environ.get("PATH", ""),
                   "RESPONSE": raw if raw is not None else json.dumps(snapshot),
                   "PSQL_RC": str(psql_rc), "PROBE": str(root / "probe.json")}
            result = subprocess.run([sys.executable, str(SCRIPT)], env=env, capture_output=True, text=True, check=False)
            self.assertNotIn("private database diagnostic", result.stdout + result.stderr)
            probe = json.loads((root / "probe.json").read_text())
            self.assertIn("-X", probe["args"])
            self.assertIn("-w", probe["args"])
            self.assertIn("default_transaction_read_only=on", probe["options"])
            return result

    def test_expected_upgrade_states(self):
        for version, columns, model, expected in (
            (400, 0, False, None),
            (401, 0, True, None),
            (403, 0, True, None),
            (404, 7, True, None),
            (401, 7, False, "legacy-host-401"),
            (403, 7, False, "legacy-host-401"),
            (403, 7, True, "legacy-host-401"),
            (404, 7, False, "upstream-401-schema-mismatch"),
            (400, 1, False, "unrecognized-host-schema"),
            (404, 0, True, "unrecognized-host-schema"),
            (405, 7, True, "checker-target-outdated"),
        ):
            with self.subTest(version=version, columns=columns, model=model):
                snapshot = {"max_version": version, "version401": version >= 401,
                            "version404": version >= 404, "host_columns": columns, "codex_model": model}
                result = self.invoke(snapshot)
                self.assertEqual(result.returncode, 1 if expected else 0)
                self.assertEqual(json.loads(result.stdout)["reason"], expected)

    def test_unknown_or_unavailable_metadata_never_passes(self):
        for payload in (None, [], {}, {"private": "do not export"}, "not metadata"):
            with self.subTest(payload=payload):
                result = self.invoke(payload)
                self.assertEqual(result.returncode, 2)
                self.assertEqual(result.stdout, "")
                self.assertNotIn("do not export", result.stderr)
        self.assertEqual(self.invoke(raw="not json").returncode, 2)
        self.assertEqual(self.invoke(raw="x" * 2049).returncode, 2)
        self.assertEqual(self.invoke(psql_rc=1).returncode, 2)

    def test_bad_types_and_inconsistent_history(self):
        valid = {"max_version": 404, "version401": True, "version404": True,
                 "host_columns": 7, "codex_model": True}
        for key, value in (("max_version", True), ("max_version", -1), ("host_columns", "7"),
                           ("version401", 1), ("host_columns", 8)):
            with self.subTest(key=key, value=value):
                self.assertEqual(self.invoke({**valid, key: value}).returncode, 2)
        for key in ("version401", "version404"):
            self.assertEqual(json.loads(self.invoke({**valid, key: False}).stdout)["reason"], "migration-history-mismatch")


if __name__ == "__main__":
    unittest.main()
