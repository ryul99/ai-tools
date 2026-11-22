# OKF Wiki Handoff

Keeps session notes so Codex, Claude Code, and Pi can continue work after
context compaction. The agent can also find notes and search past conversations from
the same project or from every project.

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

### Pi

Install the [Pi package](../../README.md#pi), which includes `okf-wiki`. Install
`okf` 0.2.0 or newer separately; Pi does not install it automatically. Run
`/reload` if you install `okf` after starting Pi. Notes are disabled in
sessions started with `--no-session`.

### Requirements for Codex and Claude Code

- Node.js 22.18 or newer.
- `okf` 0.2.0 or newer. If missing, the plugin installs it at session start;
  automatic installation requires `uv` and network access. If installation
  fails, the session continues with a notice, but no note is kept.

## Usage

The plugin runs automatically. The agent records progress and decisions in
its note. In Codex and Claude Code the note accompanies the normal summary
after compaction, and long-running subagents keep separate notes.

In Pi, automatic compaction and `/compact` use the handoff note instead of
Pi's default summary, retaining recent conversation where possible. The
extension asks the active model to write or refresh the note if it is missing
or at least 10,000 context tokens behind. If no usable note can be prepared,
Pi compacts normally. The original transcript is preserved.

In Pi the agent can use `context_remaining` to check usage and `new_context`
to resume from the note without retaining recent conversation. It updates the
note, calls `new_context`, and ends the current run with a brief status. Pi
then resumes the task in the same session, without requiring another prompt.

To resume earlier work or recover a detail, ask the agent, for example:

```text
Continue the task from this project's previous handoff notes.
Find the exact command we ran in the previous session.
Find how we set up the release workflow in my other projects.
```

Searches cover the current project by default; the agent can search every
project's notes and conversations when you refer to other projects.

## Stored data

Notes stay separate from your knowledge wiki:

| CLI | Note bundle |
| --- | --- |
| Claude Code | `$CLAUDE_CONFIG_DIR/okf-handoff`, or `~/.claude/okf-handoff` |
| Codex | `$CODEX_HOME/okf-handoff`, or `~/.codex/okf-handoff` |
| Pi | `$PI_CODING_AGENT_DIR/okf-handoff`, or `~/.pi/agent/okf-handoff` |

`OKF_ROOT` does not change this location. To inspect notes manually, use
`okf --root ~/.claude/okf-handoff list` or use the path for your CLI.
The agent names a note `<project-key>/<slug>`; it is the concept
`handoff/<project-key>/<slug>` in the bundle.

Past conversations are available only while the CLI retains their transcripts.
Notes are working state; move durable conclusions into your wiki separately.

## Configuration

- `OKF_HANDOFF_REMIND_TOKENS`: context tokens between reminders to update the
  note (default `25000`; accepts values such as `40000` or `40k`).
- `OKF_HANDOFF_MARGIN_PERCENT` (Pi): distance from automatic compaction at
  which the agent is prompted to use `new_context`, as a percentage of the
  model's context window (default `5`).
- `OKF_HANDOFF_CLI=claude|codex`: override automatic host detection for the
  Codex and Claude Code hook script.

## Limitations

- Notes depend on the agent keeping them current and may miss recent work.
  The agent can search past conversations to recover details.
- The Codex and Claude Code hook implementation cannot start a fresh context
  on its own. The experimental mod offers that option for Claude Code.
- In Pi, `new_context` runs only once the current agent run is ready to settle.
  An interruption or an intervening compaction can cancel the request.
- After a Codex or Claude Code subagent's compaction, it receives a pointer
  to its note and must choose to read it. Pi's history tools cover Pi session
  files; they do not discover `pi-subagents` run artifacts separately.
- Codex and Claude Code hook errors do not interrupt the session. Check
  `errors.log` in the plugin data directory when troubleshooting.
