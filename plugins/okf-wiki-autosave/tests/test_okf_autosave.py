from __future__ import annotations

import importlib.util
import os
import unittest
import unittest.mock
from pathlib import Path

MODULE_PATH = Path(__file__).parents[1] / "scripts" / "okf_autosave.py"
SPEC = importlib.util.spec_from_file_location("okf_autosave", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class AutosaveBodyTests(unittest.TestCase):
    def test_replaces_one_section_and_preserves_the_next(self) -> None:
        body = "# Current state\n\nOld.\n\n# Decisions\n\nKeep.\n"
        updated = MODULE.replace_section(body, "Current state", "New.")
        self.assertEqual(updated, "# Current state\n\nNew.\n\n# Decisions\n\nKeep.\n")

    def test_appends_a_missing_section(self) -> None:
        body = "# Current state\n\nReady.\n"
        updated = MODULE.replace_section(body, "Next steps", "Ship it.")
        self.assertEqual(
            updated,
            "# Current state\n\nReady.\n\n# Next steps\n\nShip it.\n",
        )

    def test_splits_frontmatter_without_reformatting_it(self) -> None:
        raw = b"---\ntype: Workstream\n---\n# Current state\n"
        prefix, body = MODULE.split_frontmatter(raw)
        self.assertEqual(prefix, b"---\ntype: Workstream\n---\n")
        self.assertEqual(body, b"# Current state\n")

    def test_rejects_an_escaping_concept_id(self) -> None:
        with self.assertRaises(MODULE.AutosaveError):
            MODULE.safe_concept_path(Path("/tmp/wiki"), "../outside")


class WorklogTests(unittest.TestCase):
    def test_appends_a_timestamped_entry_after_existing_content(self) -> None:
        body = "## 2026-08-06 10:00\n\nStarted the task.\n"
        updated = MODULE.append_worklog_entry(body, "2026-08-07 09:30", "Finished the task.")
        self.assertEqual(
            updated,
            "## 2026-08-06 10:00\n\nStarted the task.\n\n"
            "## 2026-08-07 09:30\n\nFinished the task.\n",
        )

    def test_appends_the_first_entry_to_an_empty_body(self) -> None:
        updated = MODULE.append_worklog_entry("", "2026-08-07 09:30", "First entry.")
        self.assertEqual(updated, "## 2026-08-07 09:30\n\nFirst entry.\n")

    def test_normalizes_entry_line_endings(self) -> None:
        updated = MODULE.append_worklog_entry("", "2026-08-07 09:30", "One.\r\nTwo.")
        self.assertEqual(updated, "## 2026-08-07 09:30\n\nOne.\nTwo.\n")

    def test_default_worklog_directory(self) -> None:
        with unittest.mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop("OKF_AUTOSAVE_WORKLOG_DIR", None)
            self.assertEqual(MODULE.worklog_directory(Path("/tmp/wiki")), "worklog")

    def test_empty_worklog_directory_disables_journaling(self) -> None:
        with unittest.mock.patch.dict(os.environ, {"OKF_AUTOSAVE_WORKLOG_DIR": ""}):
            self.assertIsNone(MODULE.worklog_directory(Path("/tmp/wiki")))

    def test_rejects_an_escaping_worklog_directory(self) -> None:
        with unittest.mock.patch.dict(os.environ, {"OKF_AUTOSAVE_WORKLOG_DIR": "../logs"}):
            with self.assertRaises(MODULE.AutosaveError):
                MODULE.worklog_directory(Path("/tmp/wiki"))

    def test_slug_pattern_rejects_path_segments(self) -> None:
        self.assertIsNone(MODULE.WORKLOG_SLUG_PATTERN.fullmatch("a/b"))
        self.assertIsNone(MODULE.WORKLOG_SLUG_PATTERN.fullmatch(".."))
        self.assertIsNone(MODULE.WORKLOG_SLUG_PATTERN.fullmatch("-leading"))
        self.assertIsNotNone(MODULE.WORKLOG_SLUG_PATTERN.fullmatch("fix-autosave-hook"))

    def test_ranks_relevant_worklogs_before_recent_ones(self) -> None:
        records = [
            {"id": "worklog/misc-chore", "title": "Misc chore", "tags": []},
            {"id": "worklog/fix-auth-token", "title": "Fix auth token refresh", "tags": []},
        ]
        mtimes = {"worklog/misc-chore": 200.0, "worklog/fix-auth-token": 100.0}
        ranked = MODULE.rank_worklog_records(
            records,
            "debugged the auth token refresh path",
            lambda concept_id: mtimes[concept_id],
        )
        self.assertEqual(ranked[0]["id"], "worklog/fix-auth-token")

    def test_ranks_by_recency_when_nothing_is_relevant(self) -> None:
        records = [
            {"id": "worklog/older", "title": "Older", "tags": []},
            {"id": "worklog/newer", "title": "Newer", "tags": []},
        ]
        mtimes = {"worklog/older": 100.0, "worklog/newer": 200.0}
        ranked = MODULE.rank_worklog_records(
            records,
            "completely unrelated evidence",
            lambda concept_id: mtimes[concept_id],
        )
        self.assertEqual(ranked[0]["id"], "worklog/newer")

    def test_worklog_context_indexes_all_and_details_top_ranked(self) -> None:
        records = [
            {"id": f"worklog/task-{i}", "title": f"Task {i}", "tags": []} for i in range(10)
        ]

        def fake_run_okf(root, *arguments):
            if arguments[0] == "list":
                return records
            return {"frontmatter": {"title": "Shown"}, "body": "Body text."}

        with unittest.mock.patch.object(MODULE, "run_okf", side_effect=fake_run_okf):
            with unittest.mock.patch.object(MODULE, "worklog_modified_at", return_value=0.0):
                context = MODULE.load_worklog_context(Path("/tmp/wiki"), "worklog", "task-3")
        self.assertEqual(len(context["index"]), 10)
        self.assertEqual(len(context["details"]), MODULE.MAX_WORKLOG_DETAILS)
        self.assertEqual(context["details"][0]["slug"], "task-3")
        self.assertEqual(context["details"][0]["body_tail"], "Body text.")

    def test_schema_requires_worklog_only_when_enabled(self) -> None:
        without = MODULE.update_schema([], False)
        self.assertNotIn("worklog", without["properties"])
        with_worklog = MODULE.update_schema([], True)
        self.assertIn("worklog", with_worklog["properties"])
        self.assertIn("worklog", with_worklog["required"])
        self.assertNotIn("operations", with_worklog["properties"])


if __name__ == "__main__":
    unittest.main()
