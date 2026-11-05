# OKF Wiki Handoff

This Codex and Claude Code plugin has the agent keep a per-session handoff
note in an OKF bundle and shows that note again after the context is
compacted. Instead of changing what compaction produces, it keeps the note
current while the work goes on, so the next context window can continue from
the note and the summary, and it lets the agent search the notes and read the
original transcripts of the project's sessions.

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
the way Claude Code names its folders under `~/.claude/projects/`. A Claude
Code subagent's note is `handoff/<project-key>/<session-id>/agent-<agent-id>`,
beside its session's. `OKF_ROOT` does not affect where notes go. Read them
with, for example, `okf --root ~/.claude/okf-handoff list handoff/<project-key>`.

## How the note is kept current

1. At session start the hook tells the agent which note belongs to the
   session and asks it to keep the note current. The note has no fixed
   layout; the instructions list what it should usually hold, such as the
   goal, the state of the work with exact paths and commands, the person's
   rules and decisions, and the next steps. A new session also sees the five
   most recent notes of other sessions in the same project, so it can pick up
   one of them.
2. The agent adds to the note with `handoff_append` as things happen and
   rewrites it whole with `handoff_write` when it needs reorganizing. It reads
   a note with `handoff_read` and finds the project's notes that mention a
   text with `handoff_search`, which runs `okf search` over the bundle and
   keeps the project's notes. All of them are served by the plugin's
   `okf-handoff` MCP server and take the caller's note id as `note`. Writes
   go through `okf new`, `okf meta set`, and `okf body set --if-match`.
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

When the context is compacted, automatic or manual, the new context gets the
session instructions again and the note's content, next to the summary that
the CLI writes, which is left as it is.

## Subagents

A subagent keeps a note of its own once its work runs long. In both CLIs its
hooks carry `agent_id` and the session's `session_id`, and its context size is
read from its own transcript:

| CLI | Subagent's transcript |
| --- | --- |
| Claude Code | `<session-id>/subagents/agent-<agent-id>.jsonl` beside the session's, which `transcript_path` names |
| Codex | its own rollout, which `transcript_path` names; `agent_id` is its thread id |

- A subagent hears nothing about notes at first, so a short one is left as it
  is. Once 25,000 tokens of context have been added since its first tool call,
  its next tool result carries the instructions and its note id, and the
  reminders follow as for the session. In Codex, an input the subagent is sent
  later (`UserPromptSubmit`) carries them too. The instructions name the
  session's note as one it may read but never write; the MCP server cannot
  tell callers apart, so this rests on the instructions.
- The CLI compacts a subagent as usual. Afterwards, when the subagent has a
  note, it is told once that the note is there to read with `handoff_read`,
  without its content. In Claude Code the notice comes with the compaction's
  `SessionStart` hook, or else with the subagent's next tool call once its
  transcript shows a new compaction. Codex runs no `SessionStart` for a
  subagent and lets `PostCompact` add no context, so there the notice always
  comes with the subagent's next tool call or input.
- A subagent's note stays after it finishes, and `handoff_search` finds it.
  The list of recent notes at session start shows sessions' notes only.

## Original transcripts

The CLI's own transcripts keep every message, so the plugin reads them in
place instead of archiving anything:

| CLI | Sessions of a project | Subagents |
| --- | --- | --- |
| Claude Code | `projects/<project-key>/<session-id>.jsonl` under the configuration directory | `<session-id>/subagents/agent-<id>.jsonl` beside it |
| Codex | the rollouts under `sessions/` whose `session_meta` names the project root as `cwd` | the rollouts whose `session_meta` names the session as `parent_thread_id` |

The context windows of a transcript are split at its compactions: Claude
Code's `compact_boundary` entries, or Codex's `compacted` items.

| Tool | What it does |
| --- | --- |
| `history_list` | Lists the project's sessions, newest first, with their line, window and subagent counts, note title and first prompt; given `session`, lists that session's windows by line range and its subagents. |
| `history_search` | Finds the messages that contain `query`, ignoring case, across the sessions and their subagents, or in one `session`. Each match gives the session, agent, window and line. |
| `history_read` | Reads a `session`'s or a subagent's (`agent`) messages a page at a time, from `from_line`, from the start of a `window`, or from the start. |

Tool calls are clipped in what these tools show, while a search matches their
whole text. The transcripts last as long as the CLI keeps them; Claude Code
deletes them after `cleanupPeriodDays`, 30 days by default.

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
  `history_search` and `history_read` reach what it misses.
- A subagent's note is not shown after its compaction, only pointed to, so the
  subagent reads it only if it chooses to.
- Notes are machine-owned working state. Move durable conclusions into curated
  concepts manually.

## Development

`lib/core/` holds the note store, the transcript rendering and the history
tools that `okf-wiki-handoff-mod` shares through its `hooks/core` link. It imports only
its own files, so both Node and the mod engine can run it. A change there
ships in both plugins, so bump both versions.
