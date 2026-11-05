# OKF Wiki Handoff

This Codex and Claude Code plugin has the agent keep a per-session handoff
note in an OKF bundle and shows that note again after the context is
compacted. Instead of changing what compaction produces, it keeps the note
current while the work goes on, so the next context window can continue from
the note, the summary, and recallable archived originals.

For Claude Code, installing the plugin also installs its `okf-wiki`
dependency:

```sh
claude plugin install okf-wiki-handoff@ryul99-ai-tools
```

For Codex, install both plugins, then open `/hooks` and trust the plugin hook
definition:

```sh
codex plugin add okf-wiki@ryul99-ai-tools
codex plugin add okf-wiki-handoff@ryul99-ai-tools
```

The plugin needs Node.js 22.18 or newer, which runs its TypeScript directly,
and `okf` 0.2.0 or newer on `PATH`. If `okf` is missing, the session starts
with a notice and no note is kept.

## Where notes are stored

Each CLI keeps its notes in its own bundle under its configuration directory,
creating it with `okf init` on first use:

| CLI | Bundle |
| --- | --- |
| Claude Code | `$CLAUDE_CONFIG_DIR/okf-handoff`, or `~/.claude/okf-handoff` |
| Codex | `$CODEX_HOME/okf-handoff`, or `~/.codex/okf-handoff` |

A note is the concept `handoff/<project-key>/<session-id>` with type
`Handoff` and tag `autosave-handoff`. `<project-key>` names the project root
the way Claude Code names its folders under `~/.claude/projects/`. `OKF_ROOT`
does not affect where notes go. Read them with, for example,
`okf --root ~/.claude/okf-handoff list handoff/<project-key>`.

## How the note is kept current

1. At session start the hook tells the agent which note belongs to the
   session and asks it to rewrite the note whenever the goal, a decision,
   the state of the work, or the next steps change. The note has the sections
   `# Goal`, `# State`, `# Decisions and constraints`, `# Next steps`, and
   `# Open questions`. A new session also sees the five most recent notes of
   other sessions in the same project, so it can pick up one of them.
2. The agent writes the note with the `handoff_write` tool and reads it with
   `handoff_read`, both served by the plugin's `okf-handoff` MCP server.
   Writes go through `okf new`, `okf meta set`, and `okf body set --if-match`.
3. After a prompt or a tool call, once 25,000 tokens of context have been
   added since the note last changed, the agent gets a one-line reminder to
   update it. The reminder repeats after every further 25,000 tokens. The
   context size is taken from the last main-agent request in the transcript:
   Claude Code's assistant `usage`, or Codex's `token_count` event.

A session that starts before the plugin is enabled gets the instructions with
its first reminder. The plugin does not predict when compaction happens, so
it never blocks the agent; how current the note is at a compaction depends on
the agent following the instructions and reminders.

## After a compaction

When the context is compacted, automatic or manual, the hook archives the
conversation it replaced as a numbered segment of the note. A segment is a
pointer, the transcript file and line range, kept in the note's `segments`
frontmatter. The new context then gets the session instructions again, the note's content, and
how to recall the segments. The summary that the CLI writes is left as it is.

The agent reads a segment back with the `recall` tool, which takes `note`,
`segment`, and an optional `from_line` to page through long segments. Recall
works only while the transcript file exists.

## Configuration

- `OKF_HANDOFF_REMIND_TOKENS` sets how many tokens of context pass between
  reminders, for example `40000` or `40k` (default `25000`).
- `OKF_HANDOFF_CLI=claude|codex` overrides automatic host detection.

Hook errors never interrupt the session; they are appended to `errors.log` in
the plugin data directory.

## Limits

- The plugin cannot start a fresh context window by itself. The note is
  shown next to the CLI's own summary, not in place of it.
- At a compaction the note can lag the work by up to one reminder interval;
  `recall` reaches what it misses.
- Subagents get no note; their hooks are ignored.
- Notes are machine-owned working state. Move durable conclusions into curated
  concepts manually.

## Development

`lib/core/` holds the note store and transcript rendering that
`okf-wiki-handoff-mod` shares through its `hooks/core` link. It imports only
its own files, so both Node and the mod engine can run it. A change there
ships in both plugins, so bump both versions.
