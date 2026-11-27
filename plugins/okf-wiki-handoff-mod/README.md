# OKF Wiki Handoff (mod)

An experimental Claude Code mod of [`okf-wiki-handoff`](../okf-wiki-handoff/README.md).
Instead of adding the note to the CLI's compaction summary, it uses the note
in place of the summary, and lets the agent continue in a fresh context near
the context limit. Install either this mod or `okf-wiki-handoff`.

Installation, stored data, configuration, and history search are the same as
in `okf-wiki-handoff`. `OKF_HANDOFF_MARGIN_PERCENT` applies here as in Pi.

## Differences

- Near the context limit, the agent can save its note and continue in a
  fresh context after the turn ends. Interrupting the turn or exiting the
  session cancels it.
- Automatic compaction and `/compact` use the note. Without a usable note,
  normal compaction runs with a notice.
- When `/goal` or another hook keeps the turn running, the agent relies on
  automatic compaction instead.
- Subagents keep separate notes but use normal compaction and cannot start
  fresh contexts.
