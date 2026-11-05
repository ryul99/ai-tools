# OKF Wiki Handoff (mod)

An experimental Claude Code mod that keeps session notes and lets the agent
continue work in a fresh context using those notes. It also supports searching
past conversations from the same project, including subagent conversations.

Unlike [`okf-wiki-handoff`](../okf-wiki-handoff/README.md), this mod uses the
note in place of the CLI's usual compaction summary. Choose the hook plugin
if you want to keep the usual summary.

## Installation

First add the marketplace as described in the [installation guide](../../README.md#installation).

```sh
claude plugin install okf-wiki-handoff-mod@ryul99-ai-tools
```

This also installs `okf-wiki`. Install either this mod or `okf-wiki-handoff`.

The mod requires `okf` 0.2.0 or newer. If missing, it installs `okf` at session
start; automatic installation requires `uv` and network access. If installation
fails, the session continues with a notice, but no note is kept.

## Usage

The mod runs automatically. The agent keeps notes while working and receives
reminders to update them. Near the context limit, it can save its note and
continue in a fresh context after the turn ends. You may see a brief status
message before work continues.

Automatic compaction and manual `/compact` also use the note, retaining recent
conversation when possible. If a usable note is unavailable, normal compaction
runs instead and a notice explains why.

To resume earlier work or recover a detail, ask the agent, for example:

```text
Continue the task from this project's previous handoff notes.
Find the exact command we ran in the previous session.
```

Long-running subagents keep separate notes, but use normal compaction and
cannot start fresh contexts themselves.

## Stored data

Notes stay separate from your knowledge wiki in
`$CLAUDE_CONFIG_DIR/okf-handoff`, or `~/.claude/okf-handoff` by default.
`OKF_ROOT` does not change this location. To inspect notes manually:

```sh
okf --root ~/.claude/okf-handoff list
```

Past conversations are available only while Claude Code retains their
transcripts. Notes are working state; move durable conclusions into your wiki
separately.

## Configuration

- `OKF_HANDOFF_REMIND_TOKENS`: context tokens between reminders to update the
  note (default `25000`; accepts values such as `40000` or `40k`).
- `OKF_HANDOFF_MARGIN_PERCENT`: how close to automatic compaction the agent
  is reminded to start a fresh context, as a percentage of the context window
  (default `5`).

## Limitations

- Notes may miss details. The agent can search past conversations to recover
  them.
- A fresh context starts only after the current turn ends. Interrupting the
  turn or exiting the session cancels it.
- When `/goal` or another hook keeps the turn running, the agent continues
  working and relies on automatic compaction instead.
- If `/compact` is the first action after resuming a session, the mod uses
  the existing note or falls back to normal compaction when no note exists.
- After a subagent's compaction, it receives a pointer to its note and must
  choose to read it.
