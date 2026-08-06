from __future__ import annotations

import importlib.util
import unittest
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


if __name__ == "__main__":
    unittest.main()
