from __future__ import annotations

import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path


PLUGIN_ROOT = Path(__file__).parents[1]
HOOK = PLUGIN_ROOT / "hooks" / "english-lecturer.sh"


class EnglishLecturerHookTests(unittest.TestCase):
    def run_hook(
        self,
        executable_name: str,
        response: dict,
        *,
        codex: bool,
    ) -> tuple[dict, str]:
        with tempfile.TemporaryDirectory() as temporary:
            temporary_path = Path(temporary)
            executable = temporary_path / executable_name
            arguments_path = temporary_path / "arguments.txt"
            executable.write_text(
                "#!/usr/bin/env bash\n"
                "printf '%s\\n' \"$@\" > \"$FAKE_ARGUMENTS\"\n"
                f"printf '%s' '{json.dumps(response)}'\n",
                encoding="utf-8",
            )
            executable.chmod(0o755)
            environment = os.environ.copy()
            environment["PATH"] = f"{temporary}:{environment['PATH']}"
            environment["FAKE_ARGUMENTS"] = str(arguments_path)
            if codex:
                environment["PLUGIN_ROOT"] = str(PLUGIN_ROOT)
                environment["ENGLISH_LECTURER_CODEX_MODEL"] = "codex-test-model"
            else:
                environment.pop("PLUGIN_ROOT", None)
                environment["ENGLISH_LECTURER_CLAUDE_MODEL"] = "claude-test-model"
            result = subprocess.run(
                [str(HOOK)],
                input=json.dumps({"prompt": "Can you improves this?"}),
                text=True,
                capture_output=True,
                env=environment,
                check=False,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            return json.loads(result.stdout), arguments_path.read_text(encoding="utf-8")

    def test_codex_hook_uses_ephemeral_read_only_exec(self) -> None:
        response = {
            "enhanced_prompt": "Can you improve this?",
            "has_corrections": True,
            "corrections": [],
            "tip": "Use the base verb after can.",
        }
        output, arguments = self.run_hook("codex", response, codex=True)
        self.assertIn("Can you improve this?", output["systemMessage"])
        self.assertNotIn("suppressOutput", output)
        self.assertIn("exec\n", arguments)
        self.assertIn("--ephemeral\n", arguments)
        self.assertIn("read-only\n", arguments)
        self.assertIn("--output-schema\n", arguments)
        self.assertIn("codex-test-model\n", arguments)

    def test_claude_hook_keeps_safe_structured_invocation(self) -> None:
        structured = {
            "enhanced_prompt": "Can you improve this?",
            "has_corrections": False,
            "corrections": [],
            "tip": "Use the base verb after can.",
        }
        output, arguments = self.run_hook(
            "claude",
            {"structured_output": structured},
            codex=False,
        )
        self.assertIn("Can you improve this?", output["systemMessage"])
        self.assertIn("--safe-mode\n", arguments)
        self.assertIn("--json-schema\n", arguments)
        self.assertIn("claude-test-model\n", arguments)


if __name__ == "__main__":
    unittest.main()
