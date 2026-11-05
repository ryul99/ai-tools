# OKF Wiki Handoff

Keeps session notes so Codex and Claude Code can continue work after context
compaction. The agent can also find notes and search past conversations from
the same project.

## Installation

First add the marketplace as described in the [installation guide](../../README.md#installation).

### Codex

Install both plugins, then open `/hooks` and trust the plugin hook definition:

```sh
codex plugin add okf-wiki@ryul99-ai-tools
codex plugin add okf-wiki-handoff@ryul99-ai-tools
```

### Claude Code

```sh
claude plugin install okf-wiki-handoff@ryul99-ai-tools
```

This also installs `okf-wiki`. Install either this plugin or
[`okf-wiki-handoff-mod`](../okf-wiki-handoff-mod/README.md).

### Requirements

- Node.js 22.18 or newer.
- `okf` 0.2.0 or newer. If missing, the plugin installs it at session start;
  automatic installation requires `uv` and network access. If installation
  fails, the session continues with a notice, but no note is kept.

## Usage

The plugin runs automatically. The agent records progress and decisions in
its note, and receives that note alongside the CLI's summary after compaction.
Long-running subagents keep separate notes.

To resume earlier work or recover a detail, ask the agent, for example:

```text
Continue the task from this project's previous handoff notes.
Find the exact command we ran in the previous session.
```

## Stored data

Notes stay separate from your knowledge wiki:

| CLI | Note bundle |
| --- | --- |
| Claude Code | `$CLAUDE_CONFIG_DIR/okf-handoff`, or `~/.claude/okf-handoff` |
| Codex | `$CODEX_HOME/okf-handoff`, or `~/.codex/okf-handoff` |

`OKF_ROOT` does not change this location. To inspect notes manually, use
`okf --root ~/.claude/okf-handoff list` or the corresponding Codex path.

Past conversations are available only while the CLI retains their transcripts.
Notes are working state; move durable conclusions into your wiki separately.

## Configuration

- `OKF_HANDOFF_REMIND_TOKENS`: context tokens between reminders to update the
  note (default `25000`; accepts values such as `40000` or `40k`).
- `OKF_HANDOFF_CLI=claude|codex`: override automatic host detection.

## Limitations

- Notes depend on the agent keeping them current and may miss recent work.
  The agent can search past conversations to recover details.
- The plugin uses the CLI's normal compaction and cannot start a fresh
  context on its own. The experimental mod offers that option for Claude Code.
- After a subagent's compaction, it receives a pointer to its note and must
  choose to read it.
- Hook errors do not interrupt the session. Check `errors.log` in the plugin
  data directory when troubleshooting.
