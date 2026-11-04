#!/usr/bin/env python3
"""Hooks and MCP server of okf-wiki-handoff.

The hooks keep the agent writing a per-session OKF handoff note and bring that
note back after a context compaction. The MCP server gives the agent the tools
to read and write the note and to recall archived transcript segments.
"""

from __future__ import annotations

import argparse
import fcntl
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

VERSION = "0.1.0"
SERVER_NAME = "okf-handoff"
MARKER = "[okf-wiki-handoff]"
HANDOFF_DIR = "handoff"
HANDOFF_TAG = "autosave-handoff"
HANDOFF_TYPE = "Handoff"
BUNDLE_NAME = "okf-handoff"
GENERATED_BY = "process:okf-wiki-handoff"
DESCRIPTION = "Handoff note an agent keeps current so its session survives context compaction."
ARCHIVE_HEADING = "# Archived segments"
ARCHIVE_PATTERN = re.compile(r"(?m)^# Archived segments[ \t]*$")
NOTE_PATTERN = re.compile(r"^handoff/[A-Za-z0-9-]+/[a-z0-9][a-z0-9-]{0,63}$")
SESSION_PATTERN = re.compile(r"^[A-Za-z0-9_-]{1,128}$")

OKF_TIMEOUT_SECONDS = 30
USAGE_TAIL_BYTES = 1_000_000
USAGE_WIDE_TAIL_BYTES = 16_000_000
DEFAULT_REMIND_TOKENS = 25_000
MAX_INJECTED_NOTE_CHARS = 20_000
MAX_RECENT_NOTES = 5
RECALL_CHUNK_LINES = 200
RECALL_MAX_CHARS = 30_000
TOOL_INPUT_CHARS = 2_000
TOOL_RESULT_CHARS = 4_000
# Codex records its instruction files and environment as user messages.
CODEX_INJECTED_PREFIXES = ("# AGENTS.md instructions", "<environment_context>", "<user_instructions>")

NOTE_SECTIONS = """\
- "# Goal": what the person asked for and what finished looks like.
- "# State": what is done and what is in progress, with exact file paths, branches, commands, identifiers, and changes not committed yet.
- "# Decisions and constraints": rules the person set and decisions already made. Keep a rule's own wording where it matters; never soften a constraint. Leave out what the system prompt and instruction files already say.
- "# Next steps": the concrete next actions, in order.
- "# Open questions": what is unresolved or waiting on the person, or "None." when nothing is."""


class HandoffError(RuntimeError):
    pass


# ---------------------------------------------------------------------------
# Shared helpers


def now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def clip(text: str, limit: int) -> str:
    return text if len(text) <= limit else f"{text[:limit]} [clipped]"


def remind_tokens() -> int:
    """The reminder interval from OKF_HANDOFF_REMIND_TOKENS, such as 25000 or 25k."""
    raw = os.environ.get("OKF_HANDOFF_REMIND_TOKENS", "")
    match = re.fullmatch(r"\s*([0-9]+(?:\.[0-9]+)?)\s*([kKmM]?)\s*", raw)
    if match is None:
        return DEFAULT_REMIND_TOKENS
    scale = {"": 1, "k": 1_000, "m": 1_000_000}[match.group(2).lower()]
    value = int(float(match.group(1)) * scale)
    return value if value > 0 else DEFAULT_REMIND_TOKENS


def host_name() -> str:
    configured = os.environ.get("OKF_HANDOFF_CLI", "auto").strip().lower() or "auto"
    if configured in {"claude", "codex"}:
        return configured
    return "codex" if os.environ.get("PLUGIN_ROOT") else "claude"


def config_directory(host: str) -> Path:
    if host == "codex":
        configured = os.environ.get("CODEX_HOME", "").strip()
        return Path(configured).expanduser() if configured else Path.home() / ".codex"
    configured = os.environ.get("CLAUDE_CONFIG_DIR", "").strip()
    return Path(configured).expanduser() if configured else Path.home() / ".claude"


def bundle_root(host: str) -> Path:
    return config_directory(host) / BUNDLE_NAME


def project_key(project_root: str) -> str:
    """Names a project the way Claude Code names its folders under `projects/`."""
    return re.sub(r"[^A-Za-z0-9]", "-", project_root)


def note_path(root: Path, note: str) -> Path:
    return root / f"{note}.md"


def run_okf(root: Path, *arguments: str, input_text: str | None = None) -> Any:
    executable = shutil.which("okf")
    if executable is None:
        raise HandoffError("okf command is not available")
    result = subprocess.run(
        [executable, "--root", str(root), "--format", "json", *arguments],
        cwd=root if root.is_dir() else None,
        input=input_text,
        text=True,
        capture_output=True,
        timeout=OKF_TIMEOUT_SECONDS,
        check=False,
    )
    if result.returncode != 0:
        detail = result.stderr.strip() or result.stdout.strip() or f"exit {result.returncode}"
        raise HandoffError(f"okf {' '.join(arguments[:2])} failed: {detail}")
    if not result.stdout.strip():
        return None
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        raise HandoffError("okf returned invalid JSON") from exc


def ensure_bundle(root: Path) -> None:
    if not (root / "index.md").is_file():
        root.mkdir(parents=True, exist_ok=True)
        run_okf(root, "init")


# ---------------------------------------------------------------------------
# Notes


def split_archive(body: str) -> str:
    match = ARCHIVE_PATTERN.search(body)
    return (body[: match.start()] if match else body).strip()


def archive_section(note: str, segments: list[dict[str, Any]]) -> str:
    lines = [
        f"- #{index}: transcript lines {segment['from']}-{segment['to']}, archived {segment['at']}"
        for index, segment in enumerate(segments, start=1)
    ]
    return (
        f"{ARCHIVE_HEADING}\n\n"
        "The original conversation is archived as the transcript line ranges in this note's\n"
        f"`segments` frontmatter. Read a segment with the `recall` tool of the `{SERVER_NAME}`\n"
        f'MCP server, passing note="{note}".\n\n' + "\n".join(lines) + "\n"
    )


def render_body(note: str, text: str, segments: list[dict[str, Any]]) -> str:
    body = f"{text.strip()}\n" if text.strip() else ""
    if not segments:
        return body
    return f"{body}\n{archive_section(note, segments)}" if body else archive_section(note, segments)


def is_segment(value: Any) -> bool:
    return (
        isinstance(value, dict)
        and isinstance(value.get("at"), str)
        and isinstance(value.get("transcript"), str)
        and isinstance(value.get("from"), int)
        and isinstance(value.get("to"), int)
    )


def note_segments(root: Path, note: str) -> list[dict[str, Any]]:
    if not note_path(root, note).is_file():
        return []
    try:
        stored = run_okf(root, "meta", "get", note, "segments")
    except HandoffError:
        # `meta get` fails on a key that is not there yet, which is a note with no segments.
        return []
    return [segment for segment in stored if is_segment(segment)] if isinstance(stored, list) else []


def read_note(root: Path, note: str) -> tuple[str, str] | None:
    if not note_path(root, note).is_file():
        return None
    current = run_okf(root, "body", "get", note)
    if not isinstance(current, dict) or not isinstance(current.get("identity"), str):
        raise HandoffError(f"okf body get {note} returned no identity")
    body = current.get("body")
    return (body if isinstance(body, str) else ""), current["identity"]


def create_note(root: Path, note: str, title: str) -> None:
    ensure_bundle(root)
    run_okf(
        root,
        "new",
        note,
        "--type",
        HANDOFF_TYPE,
        "--title",
        title,
        "--description",
        DESCRIPTION,
        "--tag",
        HANDOFF_TAG,
        "--generated-by",
        GENERATED_BY,
    )


def write_note(
    root: Path,
    note: str,
    text: str | None,
    title: str | None = None,
    segments: list[dict[str, Any]] | None = None,
) -> None:
    """Write the note's handoff text (None keeps the current text) and segments
    (None keeps the stored ones), creating the note first when it is missing.
    """
    if not note_path(root, note).is_file():
        create_note(root, note, title or f"Handoff {now_iso()[:10]}")
    elif title:
        run_okf(root, "meta", "set", note, "title", title)
    if segments is None:
        segments = note_segments(root, note)
    else:
        run_okf(root, "meta", "set", note, "segments", json.dumps(segments), "--type", "json")
    current = read_note(root, note)
    if current is None:
        raise HandoffError(f"{note} disappeared while it was written")
    body, identity = current
    handoff = split_archive(body) if text is None else split_archive(text)
    run_okf(root, "body", "set", note, "--if-match", identity, input_text=render_body(note, handoff, segments))


def note_title(root: Path, note: str) -> str:
    try:
        title = run_okf(root, "meta", "get", note, "title")
    except HandoffError:
        return ""
    return title if isinstance(title, str) else ""


def recent_notes(root: Path, folder: str, exclude: str) -> list[dict[str, Any]]:
    directory = root / folder
    if not directory.is_dir():
        return []
    records = run_okf(root, "list", folder, "--tag", HANDOFF_TAG)
    if not isinstance(records, list):
        return []
    notes: list[dict[str, Any]] = []
    for record in records:
        note = record.get("id") if isinstance(record, dict) else None
        if not isinstance(note, str) or not note.startswith(f"{folder}/") or note == exclude:
            continue
        try:
            modified = note_path(root, note).stat().st_mtime
        except OSError:
            continue
        notes.append({"note": note, "title": str(record.get("title") or ""), "modified": modified})
    notes.sort(key=lambda entry: entry["modified"], reverse=True)
    return notes[:MAX_RECENT_NOTES]


# ---------------------------------------------------------------------------
# Transcripts


def tail_items(path: Path, limit: int) -> list[dict[str, Any]]:
    try:
        size = path.stat().st_size
        with path.open("rb") as stream:
            if size > limit:
                stream.seek(size - limit)
                stream.readline()
            raw = stream.read()
    except OSError:
        return []
    items: list[dict[str, Any]] = []
    for line in raw.splitlines():
        try:
            item = json.loads(line)
        except (UnicodeDecodeError, json.JSONDecodeError):
            continue
        if isinstance(item, dict):
            items.append(item)
    return items


def latest_usage(items: list[dict[str, Any]]) -> dict[str, Any] | None:
    """The newest context size the transcript reports: Claude Code's last
    main-chain assistant usage, or Codex's last token count.
    """
    for item in reversed(items):
        message = item.get("message")
        if item.get("type") == "assistant" and isinstance(message, dict) and not item.get("isSidechain"):
            usage = message.get("usage")
            if not isinstance(usage, dict):
                continue
            counts = (
                usage.get(key)
                for key in (
                    "input_tokens",
                    "cache_creation_input_tokens",
                    "cache_read_input_tokens",
                    "output_tokens",
                )
            )
            tokens = sum(count for count in counts if isinstance(count, int))
            if tokens > 0:
                return {"id": str(item.get("uuid") or item.get("timestamp") or ""), "tokens": tokens}
            continue
        payload = item.get("payload")
        if item.get("type") == "event_msg" and isinstance(payload, dict) and payload.get("type") == "token_count":
            info = payload.get("info")
            last = info.get("last_token_usage") if isinstance(info, dict) else None
            tokens = last.get("total_tokens") if isinstance(last, dict) else None
            if isinstance(tokens, int) and tokens > 0:
                return {"id": f"{item.get('timestamp')}#{item.get('ordinal')}", "tokens": tokens}
    return None


def transcript_usage(path_value: Any) -> dict[str, Any] | None:
    if not isinstance(path_value, str) or not path_value:
        return None
    path = Path(path_value).expanduser()
    usage = latest_usage(tail_items(path, USAGE_TAIL_BYTES))
    return usage or latest_usage(tail_items(path, USAGE_WIDE_TAIL_BYTES))


def line_count(path: Path) -> int:
    count = 0
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1 << 20), b""):
            count += chunk.count(b"\n")
    return count


def text_of(content: Any) -> str:
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return ""
    parts: list[str] = []
    for block in content:
        if isinstance(block, str):
            parts.append(block)
        elif isinstance(block, dict) and isinstance(block.get("text"), str):
            parts.append(block["text"])
    return "\n".join(part for part in parts if part)


def render_claude_block(block: Any) -> str:
    if isinstance(block, str):
        return block
    if not isinstance(block, dict):
        return ""
    kind = block.get("type")
    if kind == "text":
        return block.get("text") if isinstance(block.get("text"), str) else ""
    if kind == "tool_use":
        name = block.get("name") if isinstance(block.get("name"), str) else "tool"
        return f"[tool_use {name}] {clip(json.dumps(block.get('input') or {}, ensure_ascii=False), TOOL_INPUT_CHARS)}"
    if kind == "tool_result":
        label = "tool_result error" if block.get("is_error") is True else "tool_result"
        return f"[{label}] {clip(text_of(block.get('content')), TOOL_RESULT_CHARS)}"
    return ""


def render_entry(line: str) -> str | None:
    try:
        entry = json.loads(line)
    except json.JSONDecodeError:
        return None
    if not isinstance(entry, dict):
        return None
    message = entry.get("message")
    if entry.get("type") in {"user", "assistant"} and isinstance(message, dict):
        content = message.get("content")
        blocks = content if isinstance(content, list) else [content]
        text = "\n".join(part for part in map(render_claude_block, blocks) if part)
        return f"{entry['type']}: {text}" if text else None
    payload = entry.get("payload")
    if entry.get("type") != "response_item" or not isinstance(payload, dict):
        return None
    kind = payload.get("type")
    if kind == "message" and payload.get("role") in {"user", "assistant"}:
        text = text_of(payload.get("content"))
        if not text or text.lstrip().startswith(CODEX_INJECTED_PREFIXES):
            return None
        return f"{payload['role']}: {text}"
    if kind in {"function_call", "custom_tool_call"}:
        arguments = payload.get("arguments", payload.get("input", ""))
        if not isinstance(arguments, str):
            arguments = json.dumps(arguments, ensure_ascii=False)
        return f"assistant: [tool_use {payload.get('name') or 'tool'}] {clip(arguments, TOOL_INPUT_CHARS)}"
    if kind in {"function_call_output", "custom_tool_call_output"}:
        output = payload.get("output")
        if isinstance(output, dict):
            output = output.get("content", output)
        if not isinstance(output, str):
            output = text_of(output) or json.dumps(output, ensure_ascii=False)
        return f"tool: [tool_result] {clip(output, TOOL_RESULT_CHARS)}"
    return None


def read_lines(path: Path, first: int, last: int) -> list[str]:
    lines: list[str] = []
    with path.open("r", encoding="utf-8", errors="replace") as stream:
        for number, line in enumerate(stream, start=1):
            if number > last:
                break
            if number >= first:
                lines.append(line.rstrip("\n"))
    return lines


# ---------------------------------------------------------------------------
# Session state


def state_path(data_dir: Path, session_id: str) -> Path:
    return data_dir / "sessions" / f"{session_id}.json"


def load_state(data_dir: Path, session_id: str) -> dict[str, Any]:
    try:
        state = json.loads(state_path(data_dir, session_id).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    return state if isinstance(state, dict) else {}


def save_state(data_dir: Path, session_id: str, state: dict[str, Any]) -> None:
    path = state_path(data_dir, session_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile("w", dir=path.parent, delete=False, encoding="utf-8") as stream:
        json.dump(state, stream)
        temporary = Path(stream.name)
    temporary.replace(path)


def note_mtime(root: Path, note: str) -> float | None:
    try:
        return note_path(root, note).stat().st_mtime
    except OSError:
        return None


def observe(state: dict[str, Any], root: Path, usage: dict[str, Any] | None) -> int | None:
    """Update the state from the transcript and the note file and return the
    current context size, or None while only pre-compaction usage is known.
    """
    tokens = usage.get("tokens") if usage else None
    if usage and usage.get("id") and usage["id"] == state.get("stale_usage"):
        tokens = None
    modified = note_mtime(root, state["note"])
    if modified != state.get("note_mtime"):
        # The agent rewrote the note since the last hook looked at it.
        state["note_mtime"] = modified
        state["note_tokens"] = tokens if tokens is not None else state.get("note_tokens")
        state["reminded_tokens"] = None
    if state.get("note_tokens") is None and tokens is not None:
        # A fresh or just-compacted context starts even with its note; a session
        # first seen mid-way without a note has written none of its work down.
        rebase = state.pop("rebase", False) or modified is not None
        state["note_tokens"] = tokens if rebase else 0
    return tokens


# ---------------------------------------------------------------------------
# Hook messages


def guidance(note: str, root: Path) -> str:
    return f"""{MARKER} This session keeps a handoff note, the OKF concept `{note}` in the bundle `{root}`. It is your working memory across context compaction: after a compaction the note is shown to you again, while the rest of the conversation survives only as a summary.

Keep the note current without being asked. Rewrite it with the `handoff_write` tool of the `{SERVER_NAME}` MCP server, passing note="{note}", whenever the goal, a decision, the state of the work or the next steps change, and before a long or risky step. Read it with `handoff_read`. If those tools are not loaded yet, load them with tool search first. Each write replaces the whole note, so pass the full note every time, in the language of the conversation, with these sections in this order:
{NOTE_SECTIONS}
Record only what the conversation shows, and keep exact names, paths, commands, numbers and error messages. You do not need to tell the person each time you update the note."""


def recent_notes_text(notes: list[dict[str, Any]]) -> str:
    if not notes:
        return ""
    lines = [
        f"- `{entry['note']}`: {entry['title'] or 'untitled'} (updated "
        f"{datetime.fromtimestamp(entry['modified'], timezone.utc).strftime('%Y-%m-%d %H:%M UTC')})"
        for entry in notes
    ]
    return (
        "\n\nRecent handoff notes of other sessions in this project:\n"
        + "\n".join(lines)
        + "\nWhen the person continues one of these tasks, read that note with `handoff_read` and carry what still holds into this session's note."
    )


def compacted_text(root: Path, note: str) -> str:
    current = read_note(root, note)
    handoff = split_archive(current[0]) if current else ""
    segments = note_segments(root, note)
    if handoff:
        if len(handoff) > MAX_INJECTED_NOTE_CHARS:
            handoff = f"{handoff[:MAX_INJECTED_NOTE_CHARS]}\n[clipped: read the rest with handoff_read]"
        text = (
            f"\n\nThe context was just compacted. This is the handoff note you kept before it; "
            f"continue from it together with the summary.\n<handoff-note>\n{handoff}\n</handoff-note>"
        )
    else:
        text = "\n\nThe context was just compacted before the handoff note had any content. Write the note as soon as you have re-established the state."
    if segments:
        text += (
            f"\n\nThe conversation before the compaction is archived as segments #1-#{len(segments)} "
            f'of this note. When a detail you need is missing, call the `recall` tool of the `{SERVER_NAME}` '
            f'MCP server with note="{note}" and a segment number instead of guessing.'
        )
    return text


def reminder(note: str, tokens: int, state: dict[str, Any], interval: int) -> str | None:
    """A nudge once `interval` tokens of work have passed since the note last
    changed, repeated after every further interval.
    """
    since = tokens - (state.get("note_tokens") or 0)
    reminded = state.get("reminded_tokens")
    if since < interval or (reminded is not None and tokens - reminded < interval):
        return None
    state["reminded_tokens"] = tokens
    return (
        f"{MARKER} About {since:,} tokens of work have passed since the handoff note `{note}` "
        "was last updated. Update it with `handoff_write` at the next good point."
    )


# ---------------------------------------------------------------------------
# Hooks


def hook_context(event: str, text: str) -> dict[str, Any]:
    return {"hookSpecificOutput": {"hookEventName": event, "additionalContext": text}}


def session_note(payload: dict[str, Any], state: dict[str, Any], session_id: str) -> str:
    if isinstance(state.get("note"), str) and NOTE_PATTERN.match(state["note"]):
        return state["note"]
    project = os.environ.get("CLAUDE_PROJECT_DIR") or payload.get("cwd") or os.getcwd()
    return f"{HANDOFF_DIR}/{project_key(str(project))}/{session_id.lower()}"


def on_session_start(payload: dict[str, Any], state: dict[str, Any], root: Path) -> dict[str, Any]:
    note = state["note"]
    text = guidance(note, root)
    state["guided"] = True
    source = payload.get("source")
    if source in {"startup", "clear", "fork"} and state.get("note_tokens") is None:
        state["rebase"] = True
    if source == "compact":
        text += compacted_text(root, note)
    elif source in {"startup", "clear", "fork"}:
        text += recent_notes_text(recent_notes(root, note.rsplit("/", 1)[0], note))
    elif source == "resume" and note_path(root, note).is_file():
        text += "\n\nThe note already exists from earlier in this session; read it with `handoff_read` when you need it."
    return hook_context("SessionStart", text)


def compaction_marker(transcript: Path) -> str | None:
    """Identify the newest compaction recorded in the transcript: Claude Code's
    compact boundary or Codex's compacted item.
    """
    for item in reversed(tail_items(transcript, USAGE_TAIL_BYTES)):
        payload = item.get("payload")
        if (
            (item.get("type") == "system" and item.get("subtype") == "compact_boundary")
            or item.get("type") == "compacted"
            or (
                item.get("type") == "event_msg"
                and isinstance(payload, dict)
                and payload.get("type") == "context_compacted"
            )
        ):
            return str(item.get("uuid") or f"{item.get('timestamp')}#{item.get('ordinal')}")
    return None


def archive_compaction(
    payload: dict[str, Any],
    state: dict[str, Any],
    root: Path,
    usage: dict[str, Any] | None,
    marker_path: Path,
) -> None:
    """Archive the compacted conversation as a segment and reset the reminder,
    once per compaction. Claude Code may run SessionStart(compact) before or
    alongside PostCompact, while Codex runs PostCompact first, so the first of
    the two archives and the marker file, read under a lock, tells the other.
    """
    transcript = payload.get("transcript_path")
    path = Path(transcript) if isinstance(transcript, str) and transcript else None
    if path is None or not path.is_file():
        return
    marker = compaction_marker(path) or f"unmarked:{line_count(path)}"
    if marker == state.get("archived_marker"):
        return
    note = state["note"]
    marker_path.parent.mkdir(parents=True, exist_ok=True)
    with marker_path.open("a+", encoding="utf-8") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        lock.seek(0)
        if lock.read().strip() != marker:
            segments = note_segments(root, note)
            last = line_count(path)
            archived = max((s["to"] for s in segments if s["transcript"] == str(path)), default=0)
            if last > archived:
                segments.append({"at": now_iso(), "transcript": str(path), "from": archived + 1, "to": last})
                write_note(root, note, None, segments=segments)
            lock.seek(0)
            lock.truncate()
            lock.write(marker)
            lock.flush()
    # Both hooks of one compaction may reach this with their own state copies;
    # the reset is the same either way.
    state["archived_marker"] = marker
    state["note_mtime"] = note_mtime(root, note)
    state["note_tokens"] = None
    state["reminded_tokens"] = None
    state["stale_usage"] = usage.get("id") if usage else None
    state["rebase"] = True


def run_hook(data_dir: Path) -> dict[str, Any]:
    payload = json.load(sys.stdin)
    if not isinstance(payload, dict) or payload.get("agent_id"):
        return {}
    session_id = str(payload.get("session_id") or "")
    if not SESSION_PATTERN.match(session_id):
        return {}
    event = payload.get("hook_event_name")
    root = bundle_root(host_name())
    state = load_state(data_dir, session_id)
    state["note"] = session_note(payload, state, session_id)
    usage = transcript_usage(payload.get("transcript_path"))
    marker_path = data_dir / "sessions" / f"{session_id}.compaction"
    output: dict[str, Any] = {}
    if event == "SessionStart":
        if shutil.which("okf") is None:
            return {"systemMessage": "okf-wiki-handoff: the okf command is not on PATH, so no handoff note is kept."}
        if payload.get("source") == "compact":
            archive_compaction(payload, state, root, usage, marker_path)
        output = on_session_start(payload, state, root)
        observe(state, root, usage)
    elif event == "PostCompact":
        archive_compaction(payload, state, root, usage, marker_path)
    elif event in {"UserPromptSubmit", "PostToolUse"}:
        tokens = observe(state, root, usage)
        message = reminder(state["note"], tokens, state, remind_tokens()) if tokens is not None else None
        if message:
            if not state.get("guided"):
                # A session that started before the plugin was enabled never saw the guidance.
                state["guided"] = True
                message = f"{message}\n\n{guidance(state['note'], root)}"
            output = hook_context(event, message)
    save_state(data_dir, session_id, state)
    return output


def log_error(data_dir: Path | None, error: BaseException) -> None:
    if data_dir is None:
        return
    try:
        data_dir.mkdir(parents=True, exist_ok=True)
        path = data_dir / "errors.log"
        if path.is_file() and path.stat().st_size > 256_000:
            path.unlink()
        with path.open("a", encoding="utf-8") as stream:
            stream.write(f"{now_iso()} {type(error).__name__}: {error}\n")
    except OSError:
        pass


# ---------------------------------------------------------------------------
# MCP server

NOTE_PROPERTY = {
    "type": "string",
    "description": "The handoff note's concept id, as the session's okf-wiki-handoff instructions give it.",
}

TOOLS = [
    {
        "name": "handoff_read",
        "description": "Read this session's okf-wiki-handoff note, or another note of this project.",
        "inputSchema": {
            "type": "object",
            "properties": {"note": NOTE_PROPERTY},
            "required": ["note"],
            "additionalProperties": False,
        },
    },
    {
        "name": "handoff_write",
        "description": "Replace the content of this session's okf-wiki-handoff note, creating it when it does not exist. Pass the whole note with the sections # Goal, # State, # Decisions and constraints, # Next steps and # Open questions; the archived segments are kept by the plugin.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "note": NOTE_PROPERTY,
                "body": {"type": "string", "description": "The full note in Markdown."},
                "title": {"type": "string", "description": "A short title for the task; optional."},
            },
            "required": ["note", "body"],
            "additionalProperties": False,
        },
    },
    {
        "name": "recall",
        "description": "Read the original messages of a conversation segment that a context compaction replaced. Use it when the handoff note lacks a detail you need, such as an exact command, error message or file content.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "note": NOTE_PROPERTY,
                "segment": {"type": "integer", "minimum": 1, "description": "The archived segment number."},
                "from_line": {
                    "type": "integer",
                    "minimum": 1,
                    "description": "The transcript line to continue from, as a previous call reported.",
                },
            },
            "required": ["note", "segment"],
            "additionalProperties": False,
        },
    },
]


def checked_note(arguments: dict[str, Any]) -> str:
    note = arguments.get("note")
    if not isinstance(note, str) or not NOTE_PATTERN.match(note):
        raise HandoffError('Pass "note" as the handoff concept id, such as handoff/<project-key>/<session-id>.')
    return note


def tool_read(root: Path, arguments: dict[str, Any]) -> str:
    note = checked_note(arguments)
    current = read_note(root, note)
    if current is None:
        return f"{note} has not been written yet."
    handoff = split_archive(current[0])
    segments = note_segments(root, note)
    footer = (
        f"\n\n[{len(segments)} archived segments: read them with recall]" if segments else ""
    )
    title = note_title(root, note)
    heading = f"{note} ({title})" if title else note
    return f"{heading}\n\n{handoff or '(empty)'}{footer}"


def tool_write(root: Path, arguments: dict[str, Any]) -> str:
    note = checked_note(arguments)
    body = arguments.get("body")
    if not isinstance(body, str) or not split_archive(body):
        raise HandoffError('Pass "body" as the full note in Markdown.')
    title = arguments.get("title")
    write_note(root, note, body, title.strip() if isinstance(title, str) and title.strip() else None)
    return f"Saved {note}."


def tool_recall(root: Path, arguments: dict[str, Any]) -> str:
    note = checked_note(arguments)
    number = arguments.get("segment")
    if not isinstance(number, int) or number < 1:
        raise HandoffError('Pass "segment" as a positive integer.')
    segments = note_segments(root, note)
    if number > len(segments):
        return f"{note} has {len(segments)} archived segments."
    segment = segments[number - 1]
    requested = arguments.get("from_line")
    first = requested if isinstance(requested, int) else segment["from"]
    first = min(max(first, segment["from"]), segment["to"])
    last = min(first + RECALL_CHUNK_LINES - 1, segment["to"])
    path = Path(segment["transcript"])
    if not path.is_file():
        return f"The archived transcript {path} no longer exists."
    lines = read_lines(path, first, last)
    parts: list[str] = []
    used = 0
    next_line: int | None = None
    for offset, line in enumerate(lines):
        rendered = render_entry(line)
        if rendered is None:
            continue
        part = f"L{first + offset} {rendered}"
        if used > 0 and used + len(part) > RECALL_MAX_CHARS:
            next_line = first + offset
            break
        parts.append(clip(part, RECALL_MAX_CHARS))
        used += len(part)
    if next_line is None and first + len(lines) <= segment["to"]:
        next_line = first + len(lines)
    footer = (
        f"[end of segment #{number}]"
        if next_line is None
        else f"[segment #{number} continues: call recall again with from_line={next_line}]"
    )
    text = "\n\n".join(parts) or "(no messages in these lines)"
    return f"Segment #{number} of {note}, archived {segment['at']}.\n\n{text}\n\n{footer}"


TOOL_HANDLERS = {"handoff_read": tool_read, "handoff_write": tool_write, "recall": tool_recall}


def mcp_response(request: dict[str, Any], root: Path) -> dict[str, Any] | None:
    method = request.get("method")
    request_id = request.get("id")
    if request_id is None:
        return None
    params = request.get("params") if isinstance(request.get("params"), dict) else {}
    if method == "initialize":
        result: dict[str, Any] = {
            "protocolVersion": params.get("protocolVersion") or "2025-06-18",
            "capabilities": {"tools": {}},
            "serverInfo": {"name": SERVER_NAME, "version": VERSION},
        }
    elif method == "ping":
        result = {}
    elif method == "tools/list":
        result = {"tools": TOOLS}
    elif method == "tools/call":
        handler = TOOL_HANDLERS.get(params.get("name"))
        if handler is None:
            return {"jsonrpc": "2.0", "id": request_id, "error": {"code": -32602, "message": "unknown tool"}}
        arguments = params.get("arguments") if isinstance(params.get("arguments"), dict) else {}
        try:
            result = {"content": [{"type": "text", "text": handler(root, arguments)}]}
        except (HandoffError, OSError, subprocess.SubprocessError) as error:
            result = {"content": [{"type": "text", "text": str(error)}], "isError": True}
    else:
        return {"jsonrpc": "2.0", "id": request_id, "error": {"code": -32601, "message": "method not found"}}
    return {"jsonrpc": "2.0", "id": request_id, "result": result}


def run_mcp(host: str) -> int:
    root = bundle_root(host)
    for line in sys.stdin:
        if not line.strip():
            continue
        try:
            request = json.loads(line)
        except json.JSONDecodeError:
            continue
        if not isinstance(request, dict):
            continue
        response = mcp_response(request, root)
        if response is not None:
            sys.stdout.write(json.dumps(response, ensure_ascii=False) + "\n")
            sys.stdout.flush()
    return 0


# ---------------------------------------------------------------------------
# Entry point


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    commands = parser.add_subparsers(dest="command", required=True)
    hook = commands.add_parser("hook", help="handle one hook event read from stdin")
    hook.add_argument("--data-dir", required=True)
    mcp = commands.add_parser("mcp", help="serve the MCP tools over stdio")
    mcp.add_argument("--host", choices=["claude", "codex"], required=True)
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    if args.command == "mcp":
        return run_mcp(args.host)
    data_dir = Path(args.data_dir).expanduser()
    try:
        output = run_hook(data_dir)
    except Exception as error:  # A hook must never break the session.
        log_error(data_dir, error)
        output = {}
    print(json.dumps(output, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
