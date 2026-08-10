from __future__ import annotations

import importlib.util
import json
import os
import subprocess
import tempfile
import unittest
import unittest.mock
from pathlib import Path

MODULE_PATH = Path(__file__).parents[1] / "scripts" / "okf_autosave.py"
SPEC = importlib.util.spec_from_file_location("okf_autosave", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class AutosaveBodyTests(unittest.TestCase):
    def test_demotes_heading_lines_to_bold_text(self) -> None:
        text = "- Did work.\n# Next steps\n- Follow up.\n  ## Indented ##\nplain # not a heading"
        self.assertEqual(
            MODULE.demote_heading_lines(text),
            "- Did work.\n**Next steps**\n- Follow up.\n  **Indented**\nplain # not a heading",
        )

    def test_splits_frontmatter_without_reformatting_it(self) -> None:
        raw = b"---\ntype: Workstream\n---\n# Current state\n"
        prefix, body = MODULE.split_frontmatter(raw)
        self.assertEqual(prefix, b"---\ntype: Workstream\n---\n")
        self.assertEqual(body, b"# Current state\n")

    def test_rejects_an_escaping_concept_id(self) -> None:
        with self.assertRaises(MODULE.AutosaveError):
            MODULE.safe_concept_path(Path("/tmp/wiki"), "../outside")

    def test_reads_codex_event_messages_from_a_transcript(self) -> None:
        records = [
            {
                "type": "event_msg",
                "payload": {"type": "user_message", "message": "Implement Codex hooks."},
            },
            {
                "type": "event_msg",
                "payload": {"type": "agent_message", "message": "Implemented and tested."},
            },
        ]
        with tempfile.TemporaryDirectory() as temporary:
            transcript = Path(temporary) / "rollout.jsonl"
            transcript.write_text(
                "".join(json.dumps(record) + "\n" for record in records),
                encoding="utf-8",
            )
            messages = MODULE.transcript_tail(MODULE.read_transcript_bytes(str(transcript)))
        self.assertEqual(
            messages,
            [
                {"role": "user", "content": "Implement Codex hooks."},
                {"role": "assistant", "content": "Implemented and tested."},
            ],
        )

    def test_falls_back_to_codex_response_items(self) -> None:
        record = {
            "type": "response_item",
            "payload": {
                "type": "message",
                "role": "assistant",
                "content": [{"type": "output_text", "text": "Finished."}],
            },
        }
        with tempfile.TemporaryDirectory() as temporary:
            transcript = Path(temporary) / "rollout.jsonl"
            transcript.write_text(json.dumps(record) + "\n", encoding="utf-8")
            messages = MODULE.transcript_tail(MODULE.read_transcript_bytes(str(transcript)))
        self.assertEqual(messages, [{"role": "assistant", "content": "Finished."}])


class WorklogTests(unittest.TestCase):
    def test_starts_a_new_day_heading_after_an_older_day(self) -> None:
        body = "## 2026-08-06\n\n- Started the task.\n"
        updated = MODULE.append_worklog_entry(body, "2026-08-07", "Finished the task.")
        self.assertEqual(
            updated,
            "## 2026-08-06\n\n- Started the task.\n\n"
            "## 2026-08-07\n\n- Finished the task.\n",
        )

    def test_appends_a_bullet_under_the_current_day_heading(self) -> None:
        body = "## 2026-08-07\n\n- First step.\n"
        updated = MODULE.append_worklog_entry(body, "2026-08-07", "Second step.")
        self.assertEqual(updated, "## 2026-08-07\n\n- First step.\n- Second step.\n")

    def test_legacy_timestamp_heading_gets_a_fresh_day_heading(self) -> None:
        body = "## 2026-08-07 09:30\n\nOld-format entry.\n"
        updated = MODULE.append_worklog_entry(body, "2026-08-07", "New entry.")
        self.assertEqual(
            updated,
            "## 2026-08-07 09:30\n\nOld-format entry.\n\n"
            "## 2026-08-07\n\n- New entry.\n",
        )

    def test_appends_the_first_entry_to_an_empty_body(self) -> None:
        updated = MODULE.append_worklog_entry("", "2026-08-07", "First entry.")
        self.assertEqual(updated, "## 2026-08-07\n\n- First entry.\n")

    def test_normalizes_entry_line_endings_and_indents_continuations(self) -> None:
        updated = MODULE.append_worklog_entry("", "2026-08-07", "One.\r\nTwo.")
        self.assertEqual(updated, "## 2026-08-07\n\n- One.\n  Two.\n")

    def test_keeps_entries_that_are_already_bullets(self) -> None:
        updated = MODULE.append_worklog_entry("", "2026-08-07", "- One.\n- Two.")
        self.assertEqual(updated, "## 2026-08-07\n\n- One.\n- Two.\n")

    def test_demotes_heading_lines_inside_entries(self) -> None:
        updated = MODULE.append_worklog_entry("", "2026-08-07", "- One.\n# Next steps\n- Two.")
        self.assertEqual(updated, "## 2026-08-07\n\n- One.\n**Next steps**\n- Two.\n")

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

    def test_schema_requires_material_change_and_worklog(self) -> None:
        schema = MODULE.update_schema()
        self.assertEqual(schema["required"], ["material_change", "worklog"])
        self.assertNotIn("operations", schema["properties"])

    def test_schema_entry_is_a_structured_object(self) -> None:
        worklog = MODULE.update_schema()["properties"]["worklog"]
        entry = next(item for item in worklog["anyOf"] if item.get("type") == "object")
        entry = entry["properties"]["entry"]
        self.assertEqual(entry["type"], "object")
        self.assertEqual(entry["required"], ["scope", "summary", "refs"])
        self.assertEqual(entry["properties"]["refs"]["items"]["type"], "string")

    def test_schema_worklog_is_nullable_via_anyof(self) -> None:
        worklog = MODULE.update_schema()["properties"]["worklog"]
        self.assertNotIn("type", worklog)
        variants = {json.dumps(item.get("type")) for item in worklog["anyOf"]}
        self.assertEqual(variants, {'"object"', '"null"'})

    def test_prompt_spells_out_the_noop_plan(self) -> None:
        prompt = MODULE.planner_prompt()
        self.assertIn('{"material_change": false, "worklog": null}', prompt)
        self.assertNotIn("operations", prompt)

    def test_prompt_asks_for_self_contained_entry_fields(self) -> None:
        prompt = MODULE.planner_prompt()
        for field in ('"scope"', '"summary"', '"refs"'):
            self.assertIn(field, prompt)
        self.assertIn("readable on its own", prompt)


class WorklogEntryRenderTests(unittest.TestCase):
    def test_renders_a_scope_tag_summary_and_refs(self) -> None:
        rendered = MODULE.render_worklog_entry(
            {
                "scope": "suggestions GEPA v4",
                "summary": "cand9를 최종 채택했다.",
                "refs": ["PR #1651", "SEARCH-4955"],
            }
        )
        self.assertEqual(
            rendered,
            "- `[suggestions GEPA v4]` cand9를 최종 채택했다. (PR #1651 · SEARCH-4955)",
        )

    def test_omits_the_trailer_when_there_are_no_refs(self) -> None:
        rendered = MODULE.render_worklog_entry(
            {"scope": "autosave hook", "summary": "Reworked the entry schema.", "refs": []}
        )
        self.assertEqual(rendered, "- `[autosave hook]` Reworked the entry schema.")

    def test_collapses_newlines_and_strips_backticks(self) -> None:
        rendered = MODULE.render_worklog_entry(
            {
                "scope": "okf `autosave`",
                "summary": "First line.\n\n- Second line.",
                "refs": ["`main`"],
            }
        )
        self.assertEqual(rendered, "- `[okf autosave]` First line. - Second line. (main)")

    def test_drops_refs_that_are_not_strings_and_caps_the_list(self) -> None:
        rendered = MODULE.render_worklog_entry(
            {
                "scope": "scope",
                "summary": "Summary.",
                "refs": [None, "  ", *[f"PR #{index}" for index in range(MODULE.MAX_WORKLOG_REFS + 3)]],
            }
        )
        self.assertEqual(rendered.count(" · "), MODULE.MAX_WORKLOG_REFS - 1)
        self.assertIn("(PR #0 · ", rendered)

    def test_truncates_oversized_fields(self) -> None:
        rendered = MODULE.render_worklog_entry(
            {"scope": "s" * 500, "summary": "m" * 5_000, "refs": ["r" * 500]}
        )
        self.assertIn("`[" + "s" * MODULE.MAX_WORKLOG_SCOPE_CHARS + "]`", rendered)
        self.assertIn("m" * MODULE.MAX_WORKLOG_SUMMARY_CHARS, rendered)
        self.assertIn("(" + "r" * MODULE.MAX_WORKLOG_REF_CHARS + ")", rendered)

    def test_rejects_an_entry_missing_a_scope_or_summary(self) -> None:
        self.assertEqual(MODULE.render_worklog_entry({"summary": "Only a summary."}), "")
        self.assertEqual(MODULE.render_worklog_entry({"scope": "Only a scope."}), "")
        self.assertEqual(MODULE.render_worklog_entry({"scope": " ", "summary": " "}), "")

    def test_a_rendered_entry_appends_as_a_single_bullet(self) -> None:
        rendered = MODULE.render_worklog_entry(
            {"scope": "autosave hook", "summary": "Reworked the schema.", "refs": ["a1b2c3d"]}
        )
        self.assertEqual(
            MODULE.append_worklog_entry("", "2026-08-10", rendered),
            "## 2026-08-10\n\n- `[autosave hook]` Reworked the schema. (a1b2c3d)\n",
        )


def user_record(text: str, origin_kind: str | None, prompt_source: str | None, **extra) -> str:
    record: dict = {
        "type": "user",
        "message": {"role": "user", "content": [{"type": "text", "text": text}]},
        "promptSource": prompt_source,
    }
    if origin_kind is not None:
        record["origin"] = {"kind": origin_kind}
    record.update(extra)
    return json.dumps(record) + "\n"


class SystemTriggeredTurnTests(unittest.TestCase):
    def test_human_typed_prompt_is_not_system_triggered(self) -> None:
        raw = user_record("fix the bug", "human", "typed").encode("utf-8")
        self.assertFalse(MODULE.system_triggered_turn(raw))

    def test_task_notification_prompt_is_system_triggered(self) -> None:
        raw = user_record("<task-notification>...</task-notification>", "task-notification", "system").encode("utf-8")
        self.assertTrue(MODULE.system_triggered_turn(raw))

    def test_the_newest_prompt_decides(self) -> None:
        raw = (
            user_record("start the run", "human", "typed")
            + user_record("<task-notification>monitor event</task-notification>", "task-notification", "system")
        ).encode("utf-8")
        self.assertTrue(MODULE.system_triggered_turn(raw))
        raw = (
            user_record("<task-notification>monitor event</task-notification>", "task-notification", "system")
            + user_record("stop and summarize", "human", "queued")
        ).encode("utf-8")
        self.assertFalse(MODULE.system_triggered_turn(raw))

    def test_meta_and_sidechain_records_are_ignored(self) -> None:
        raw = (
            user_record("<task-notification>event</task-notification>", "task-notification", "system")
            + user_record("skill content", None, None, isMeta=True)
            + user_record("subagent prompt", None, "typed", isSidechain=True)
        ).encode("utf-8")
        self.assertTrue(MODULE.system_triggered_turn(raw))

    def test_missing_origin_falls_back_to_prompt_source(self) -> None:
        self.assertTrue(MODULE.system_triggered_turn(user_record("event", None, "system").encode("utf-8")))
        self.assertFalse(MODULE.system_triggered_turn(user_record("hello", None, None).encode("utf-8")))

    def test_codex_rollouts_count_as_human(self) -> None:
        record = {
            "type": "event_msg",
            "payload": {"type": "user_message", "message": "Implement Codex hooks."},
        }
        raw = (json.dumps(record) + "\n").encode("utf-8")
        self.assertFalse(MODULE.system_triggered_turn(raw))

class GitContextTests(unittest.TestCase):
    def test_skips_commands_that_time_out(self) -> None:
        def fake_run(command, **kwargs):
            if command[1] == "status":
                raise subprocess.TimeoutExpired(command, kwargs["timeout"])
            return subprocess.CompletedProcess(command, 0, "clean\n", "")

        with unittest.mock.patch.object(MODULE.shutil, "which", return_value="/usr/bin/git"):
            with unittest.mock.patch.object(MODULE, "run_process", side_effect=fake_run):
                context = MODULE.git_context(Path("/tmp"))
        self.assertNotIn("status", context)
        self.assertEqual(context["branch"], "clean")


class PlannerRuntimeTests(unittest.TestCase):
    def test_auto_runtime_uses_codex_for_a_codex_plugin_hook(self) -> None:
        with unittest.mock.patch.dict(
            os.environ,
            {"PLUGIN_ROOT": "/tmp/plugin", "OKF_AUTOSAVE_CLI": "auto"},
        ):
            self.assertEqual(MODULE.planner_runtime(), "codex")

    def test_auto_runtime_keeps_claude_compatibility(self) -> None:
        with unittest.mock.patch.dict(os.environ, {"OKF_AUTOSAVE_CLI": "auto"}):
            os.environ.pop("PLUGIN_ROOT", None)
            self.assertEqual(MODULE.planner_runtime(), "claude")

    def test_runtime_can_be_overridden(self) -> None:
        with unittest.mock.patch.dict(
            os.environ,
            {"PLUGIN_ROOT": "/tmp/plugin", "OKF_AUTOSAVE_CLI": "claude"},
        ):
            self.assertEqual(MODULE.planner_runtime(), "claude")

    def test_codex_planner_uses_isolated_read_only_structured_run(self) -> None:
        expected = {"material_change": False, "worklog": None}

        def fake_run(command, **kwargs):
            schema_path = Path(command[command.index("--output-schema") + 1])
            schema = json.loads(schema_path.read_text(encoding="utf-8"))
            self.assertEqual(schema["required"], ["material_change", "worklog"])
            self.assertTrue(kwargs["cwd"].is_dir())
            self.assertEqual(kwargs["input_text"], '{"evidence":{}}')
            self.assertEqual(kwargs["env"]["OKF_AUTOSAVE_CHILD"], "1")
            self.assertNotIn("OPENAI_API_KEY", kwargs["env"])
            return subprocess.CompletedProcess(command, 0, json.dumps(expected), "")

        with unittest.mock.patch.object(MODULE.shutil, "which", return_value="/usr/bin/codex"):
            with unittest.mock.patch.object(MODULE, "run_process", side_effect=fake_run) as run:
                with unittest.mock.patch.dict(
                    os.environ,
                    {
                        "OPENAI_API_KEY": "secret",
                        "OKF_AUTOSAVE_CODEX_MODEL": "codex-test-model",
                    },
                ):
                    actual = MODULE.request_codex_plan(
                        "Return JSON.",
                        '{"evidence":{}}',
                        MODULE.update_schema(),
                    )

        self.assertEqual(actual, expected)
        command = run.call_args.args[0]
        self.assertEqual(command[:2], ["/usr/bin/codex", "exec"])
        self.assertIn("--ephemeral", command)
        self.assertIn("--ignore-user-config", command)
        self.assertIn("read-only", command)
        self.assertEqual(command[command.index("--model") + 1], "codex-test-model")

    def test_claude_planner_keeps_structured_output_wrapper(self) -> None:
        expected = {"material_change": False, "worklog": None}
        response = json.dumps({"structured_output": expected})
        completed = subprocess.CompletedProcess([], 0, response, "")
        with unittest.mock.patch.object(MODULE.shutil, "which", return_value="/usr/bin/claude"):
            with unittest.mock.patch.object(MODULE, "run_process", return_value=completed) as run:
                with unittest.mock.patch.dict(
                    os.environ,
                    {"OKF_AUTOSAVE_CLAUDE_MODEL": "claude-test-model"},
                ):
                    actual = MODULE.request_claude_plan(
                        Path("/tmp/wiki"),
                        "Return JSON.",
                        '{"evidence":{}}',
                        MODULE.update_schema(),
                    )

        self.assertEqual(actual, expected)
        command = run.call_args.args[0]
        self.assertEqual(command[0], "/usr/bin/claude")
        self.assertEqual(command[command.index("--model") + 1], "claude-test-model")


class WorklogRolloverTests(unittest.TestCase):
    def build(self, days: dict[str, int]) -> str:
        return "".join(f"## {day}\n\n- {'x' * size}\n\n" for day, size in days.items())

    def day_names(self, body: str) -> list[str]:
        return [day for day, _ in MODULE.worklog_day_blocks(body)[1]]

    def test_keeps_a_body_that_fits_the_budget(self) -> None:
        body = self.build({"2026-01-01": 100, "2026-01-02": 100})
        self.assertEqual(MODULE.split_worklog_body(body, 16_000), ([], body))

    def test_seals_oldest_days_until_the_body_fits(self) -> None:
        body = self.build({f"2026-01-{day:02d}": 400 for day in range(1, 11)})
        sealed, active = MODULE.split_worklog_body(body, 1_000)
        self.assertTrue(sealed)
        self.assertLessEqual(len(active), 1_000)
        preserved = [day for group in sealed for day, _ in group] + self.day_names(active)
        self.assertEqual(preserved, [f"2026-01-{day:02d}" for day in range(1, 11)])

    def test_never_divides_a_single_day(self) -> None:
        body = self.build({"2026-01-01": 50, "2026-01-02": 5_000, "2026-01-03": 50})
        sealed, active = MODULE.split_worklog_body(body, 1_000)
        oversized = [group for group in sealed if any(len(text) > 1_000 for _, text in group)]
        self.assertEqual(len(oversized), 1)
        self.assertEqual([day for day, _ in oversized[0]], ["2026-01-02"])
        self.assertEqual(self.day_names(active), ["2026-01-03"])

    def test_always_keeps_the_most_recent_day_active(self) -> None:
        body = self.build({"2026-01-01": 4_000, "2026-01-02": 4_000})
        sealed, active = MODULE.split_worklog_body(body, 100)
        self.assertEqual(len(sealed), 1)
        self.assertEqual(self.day_names(active), ["2026-01-02"])

    def test_a_body_without_day_headings_is_untouched(self) -> None:
        body = "Preamble with no day heading.\n"
        self.assertEqual(MODULE.split_worklog_body(body, 10), ([], body))

    def test_preamble_stays_with_the_active_worklog(self) -> None:
        body = "Intro line.\n\n" + self.build({"2026-01-01": 900, "2026-01-02": 900})
        sealed, active = MODULE.split_worklog_body(body, 1_000)
        self.assertTrue(sealed)
        self.assertTrue(active.startswith("Intro line."))

    def test_cuts_by_position_so_out_of_order_days_keep_their_order(self) -> None:
        body = self.build({"2026-03-01": 900, "2026-01-05": 900, "2026-03-02": 900})
        sealed, active = MODULE.split_worklog_body(body, 1_000)
        preserved = [day for group in sealed for day, _ in group] + self.day_names(active)
        self.assertEqual(preserved, ["2026-03-01", "2026-01-05", "2026-03-02"])

    def test_rollover_is_idempotent_once_the_body_fits(self) -> None:
        body = self.build({f"2026-01-{day:02d}": 400 for day in range(1, 11)})
        _, active = MODULE.split_worklog_body(body, 1_000)
        self.assertEqual(MODULE.split_worklog_body(active, 1_000), ([], active))

    def test_budget_defaults_and_can_be_disabled(self) -> None:
        with unittest.mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop("OKF_AUTOSAVE_WORKLOG_MAX_BYTES", None)
            self.assertEqual(MODULE.worklog_budget(), MODULE.DEFAULT_WORKLOG_MAX_BYTES)
        with unittest.mock.patch.dict(os.environ, {"OKF_AUTOSAVE_WORKLOG_MAX_BYTES": ""}):
            self.assertIsNone(MODULE.worklog_budget())
        with unittest.mock.patch.dict(os.environ, {"OKF_AUTOSAVE_WORKLOG_MAX_BYTES": "nope"}):
            with self.assertRaises(MODULE.AutosaveError):
                MODULE.worklog_budget()

    def test_partition_index_continues_after_existing_partitions(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "worklog").mkdir()
            for name in ("columbus.md", "columbus-1.md", "columbus-7.md", "columbus-demo.md"):
                (root / "worklog" / name).write_text("---\ntype: Worklog\n---\n")
            self.assertEqual(MODULE.next_partition_index(root, "worklog", "columbus"), 8)

    def test_partition_keeps_topic_tags_but_drops_the_head_marker(self) -> None:
        tags = MODULE.worklog_partition_tags(
            {"tags": ["columbus", MODULE.WORKLOG_TAG, MODULE.WORKLOG_HEAD_TAG]}
        )
        self.assertEqual(tags, ["columbus", MODULE.WORKLOG_TAG])

    def test_partition_tags_add_the_worklog_tag_when_missing(self) -> None:
        self.assertEqual(
            MODULE.worklog_partition_tags({"tags": ["columbus"]}),
            ["columbus", MODULE.WORKLOG_TAG],
        )

    def test_the_planner_index_is_built_from_head_tagged_worklogs(self) -> None:
        listed: list[tuple[str, ...]] = []

        def fake_run_okf(root, *arguments):
            listed.append(arguments)
            if arguments[0] == "list":
                return [
                    {
                        "id": "worklog/columbus",
                        "title": "Columbus",
                        "tags": [MODULE.WORKLOG_TAG, MODULE.WORKLOG_HEAD_TAG],
                    }
                ]
            return {"frontmatter": {"title": "Shown"}, "body": "Body."}

        with unittest.mock.patch.object(MODULE, "run_okf", side_effect=fake_run_okf):
            with unittest.mock.patch.object(MODULE, "worklog_modified_at", return_value=0.0):
                context = MODULE.load_worklog_context(Path("/tmp/wiki"), "worklog", "columbus")
        self.assertEqual(listed[0], ("list", "--tag", MODULE.WORKLOG_HEAD_TAG))
        self.assertEqual([item["slug"] for item in context["index"]], ["columbus"])


if __name__ == "__main__":
    unittest.main()
