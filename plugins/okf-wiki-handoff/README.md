# OKF Wiki Handoff

Keeps session notes so Codex, Claude Code, and Pi can continue work after
context compaction. The agent can also find notes and search past
conversations from the same project or from every project.

## Installation

See the [installation guide](../../README.md#installation). In Pi, run
`/reload` if you install `okf` after starting Pi; notes are disabled in
sessions started with `--no-session`.

In Codex and Claude Code, if `okf` is missing the plugin installs it at
session start, which requires `uv` and network access. If that fails, the
session continues with a notice, but no note is kept.

## Usage

The plugin runs automatically. The agent records progress and decisions in
its note. In Codex and Claude Code the note accompanies the normal summary
after compaction, and long-running subagents keep separate notes.

In Pi, automatic compaction and `/compact` use the note instead of Pi's
default summary, retaining recent conversation where possible. If the note is
missing or at least 10,000 context tokens behind, the active model is asked to
refresh it first; if that fails, Pi compacts normally. The agent can also call
`new_context` to resume from the note in a fresh context in the same session,
without another prompt.

To resume earlier work or recover a detail, ask the agent, for example:

```text
Continue the task from this project's previous handoff notes.
Find the exact command we ran in the previous session.
Find how we set up the release workflow in my other projects.
```

## Stored data

Notes stay separate from your knowledge wiki, and `OKF_ROOT` does not change
their location:

| CLI | Note bundle |
| --- | --- |
| Claude Code | `$CLAUDE_CONFIG_DIR/okf-handoff`, or `~/.claude/okf-handoff` |
| Codex | `$CODEX_HOME/okf-handoff`, or `~/.codex/okf-handoff` |
| Pi | `$PI_CODING_AGENT_DIR/okf-handoff`, or `~/.pi/agent/okf-handoff` |

Inspect them with `okf --root <bundle> list`. Past conversations are
searchable only while the CLI retains their transcripts. Notes are working
state; move durable conclusions into your wiki separately.

## Configuration

- `OKF_HANDOFF_REMIND_TOKENS`: context tokens between reminders to update the
  note (default `25000`; accepts values such as `40k`).
- `OKF_HANDOFF_MARGIN_PERCENT` (Pi): how close to automatic compaction, as a
  percentage of the context window, the agent is prompted to use
  `new_context` (default `5`).
- `OKF_HANDOFF_CLI=claude|codex`: override automatic host detection for the
  hook script.

## Limitations

- Notes may miss recent work; the agent can search past conversations to
  recover details.
- The Codex and Claude Code hooks cannot start a fresh context; the
  experimental mod can in Claude Code.
- In Pi, an interruption or an intervening compaction can cancel a
  `new_context` request.
- After a Codex or Claude Code subagent's compaction, it only receives a
  pointer to its note. Pi's history tools do not discover `pi-subagents` run
  artifacts.
- Hook errors do not interrupt the session; check `errors.log` in the plugin
  data directory.
