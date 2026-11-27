# OKF Wiki Handoff

Keeps session notes so Codex, Claude Code, and Pi can continue work after
context compaction. The agent can also find notes and search past
conversations.

## How it works

The agent records progress and decisions in its note; compaction uses the
note instead of the CLI's default summary. In Pi, `new_context` resumes from
the note in a fresh context. Long-running subagents keep separate notes.

To resume earlier work, ask the agent, for example:

```text
Continue the task from this project's previous handoff notes.
```

## Stored data

Notes stay separate from your knowledge wiki; `OKF_ROOT` does not change
their location. In Pi, the bundle is `$PI_CODING_AGENT_DIR/okf-handoff` (or
`~/.pi/agent/okf-handoff`); inspect with `okf --root <bundle> list`.

## Config

- `OKF_HANDOFF_REMIND_TOKENS` — context tokens between note-update reminders
  (default `25000`)
- `OKF_HANDOFF_MARGIN_PERCENT` (Pi) — how close to automatic compaction to
  prompt `new_context` (default `5`)
- `OKF_HANDOFF_CLI=claude|codex` — override host detection for the hook
  script

Notes are working state; move durable conclusions into your wiki separately.
Hook errors do not interrupt the session — check `errors.log` in the plugin
data directory.
