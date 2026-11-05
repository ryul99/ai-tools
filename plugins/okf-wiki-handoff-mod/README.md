# OKF Wiki Handoff (mod)

This experimental Claude Code mod brings the context management of Codex's
experimental handoff to Claude Code. The model keeps a handoff note in an OKF
bundle while it works, is reminded before the context window runs out, and can
start a fresh context window that holds only the note. Compactions are replaced
by the note too, and the original messages of every session of the project,
subagents included, stay searchable and readable.

```sh
claude plugin install okf-wiki-handoff-mod@ryul99-ai-tools
```

It declares `okf-wiki` as a dependency and requires `okf` 0.2.0 or newer on
`PATH`. Install either this mod or the `okf-wiki-handoff` hook plugin, not
both.

## Where notes are stored

Notes are session working state, so they stay out of your knowledge wiki. The
mod keeps them in its own bundle under the Claude Code configuration directory,
`$CLAUDE_CONFIG_DIR` or `~/.claude`, and creates it with `okf init` on first
use:

```text
~/.claude/okf-handoff/
  index.md
  handoff/<project-key>/<session-id>.md
  handoff/<project-key>/<session-id>/agent-<agent-id>.md
```

`<project-key>` names the session's project root the way Claude Code names its
folders under `~/.claude/projects/`. The second path is a subagent's own note.
`OKF_ROOT` does not affect
where notes go. Read them with
`okf --root ~/.claude/okf-handoff list handoff/<project-key>`.

## How the model keeps the note

A system prompt section tells the main agent which note is its own and how to
keep it: add to it as things happen and rewrite it whole when it needs
reorganizing. The note has no fixed layout; the section lists what it should
usually hold, such as the goal, the state of the work with exact paths and
commands, the person's rules and decisions, and the next steps. It also lists
the five most recent notes of other sessions in the project, so a new session
can pick one of them up.

The mod registers these tools, each loaded from the start:

| Tool | What it does |
| --- | --- |
| `handoff_write` | Replaces the caller's note, creating it when needed. |
| `handoff_append` | Adds text to the end of the caller's note, creating it when needed. |
| `handoff_read` | Reads the caller's note, or another note of the project by its slug. |
| `handoff_search` | Finds the project's notes that mention a text, with `okf search`. |
| `context_remaining` | Reports the tokens in use, the window, and how many tokens remain before automatic compaction. |
| `new_context` | Starts a fresh context window holding only the note when the turn ends. |
| `history_list` | Lists the project's sessions, or one session's context windows and subagents. |
| `history_search` | Finds the original messages that contain a text, across the project's sessions and their subagents. |
| `history_read` | Reads a session's or a subagent's original messages a page at a time. |

The caller's note is the session's for the main agent and a subagent's own for
a subagent; see [Subagents](#subagents).

## Reminders

Reminders reach the main agent after its tool calls and with the person's
prompts, as context the person does not see; a subagent's are described under
[Subagents](#subagents):

- Once 25,000 tokens of context have been added since the note last changed,
  a reminder asks the agent to update the note, and repeats after every
  further 25,000 tokens.
- Once the context is within 5% of the window of automatic compaction, a
  reminder asks the agent to save the note, call `new_context`, and end the
  turn. It is given once per version of the note.

The compaction threshold is the one Claude Code itself reports, so the
reminders need no guess about the model's context window.

## A fresh context window

After the agent calls `new_context`, the mod waits for the turn to end, then
runs `/compact` with its own marker. The mod's compaction hook replaces the
whole conversation with one message that holds the note and how to look up
the original messages, without a summary, and the mod submits a prompt that tells
the agent to continue from the note. The `/compact` lines appear in the
transcript.

If the note is more than 10,000 tokens behind the work at that point, the mod
first asks a fork of the conversation to bring it up to date. An interrupted
turn cancels the reset, and so does a session that exits before the turn ends.

A Stop hook can keep the turn from ending: `/goal` does so until its condition
is met. When one does while a reset waits, the mod cancels the reset and adds
to the hook's feedback that the turn cannot end, so the agent keeps working
instead of ending the turn again. For the rest of that turn `new_context`
starts nothing and says why, and the reminder near automatic compaction asks
only to save the note: the automatic compaction then replaces the conversation
with the note, as a reset would.

## Compactions

Every compaction of the main conversation, automatic or `/compact`, is replaced
the same way, except that the newest whole turns that fit in 24,000 characters
are kept after the note; when no turn fits, the person's latest request is
copied into the note message verbatim. A note that is current is used as it
is; a note that is missing or more than 10,000 tokens behind is rewritten
first by a fork of the conversation, with any text passed to `/compact` given
to it as what to keep or stress. Claude Code's ahead-of-time compaction of the
main conversation is skipped because the note is written when the compaction
runs.

When the fork gives no usable note, a note that exists is used as it is. If the
bundle cannot be created, there is no note to use, or `okf` fails, the
compaction runs as usual and a notice says why.

## Subagents

A subagent keeps a note of its own once its work runs long. Its context size
is read from its own transcript, since Claude Code reports the main
conversation's alone.

- A subagent hears nothing about notes at first, so a short one is left as it
  is. Once 25,000 tokens of context have been added since its first tool call,
  its next tool result carries the instructions and its note id, and the
  periodic reminders follow. It gets no urgent reminder, and `new_context` is
  refused, because a subagent cannot start a fresh window.
- `handoff_write`, `handoff_append` and `handoff_read` without a slug act on
  the subagent's own note, so it cannot write the session's.
  `context_remaining` reports the subagent's context.
- Claude Code compacts a subagent as usual, ahead-of-time compaction included.
  When the subagent has a note, one message after the summary tells it that the
  note is there to read, without its content.
- A subagent's note stays after it finishes, and `handoff_search` finds it.
  The list of recent notes in the system prompt shows sessions' notes only.

## Original transcripts

A reset or compaction replaces the conversation the model sees, but Claude
Code's transcript keeps every message, so the history tools read it in place:
the sessions are the `<session-id>.jsonl` files of the project's folder under
`~/.claude/projects/`, and their subagents are the
`<session-id>/subagents/agent-<id>.jsonl` files beside them. A transcript's
context windows are split at its `compact_boundary` entries.

`history_list` shows each session's line, window and subagent counts, note
title and first prompt, newest first; given `session`, it shows that session's
windows by line range and its subagents. `history_search` matches `query`
ignoring case against whole messages, tool calls and results included, and
gives each match's session, agent, window and line. `history_read` reads from
`from_line`, from the start of a `window`, or from the start, and takes
`agent` for a subagent. Tool calls are clipped in what the tools show.

The transcripts last as long as Claude Code keeps them, `cleanupPeriodDays`,
30 days by default.

## Configuration

- `OKF_HANDOFF_REMIND_TOKENS` sets how many tokens of context pass between
  reminders to update the note, for example `40000` or `40k` (default
  `25000`).
- `OKF_HANDOFF_MARGIN_PERCENT` sets how close to automatic compaction the
  reminder to start a fresh window comes, as a percentage of the window
  (default `5`).

## Limits

- The fresh window starts when the turn that called `new_context` ends, not in
  the middle of that turn, and its continuation arrives as a prompt from the
  mod.
- A fork needs a request already sent in the current process. A `/compact` as
  the first action after resuming a session therefore uses the note as it is,
  or falls back to the usual compaction when the session has no note.
- Tool results that arrived after the last request are passed to the fork
  explicitly, up to 8,000 characters.
- Notes are machine-owned working state. Move durable conclusions into curated
  concepts manually.

## Development

`hooks/core` links to `../../okf-wiki-handoff/lib/core`, the note store,
transcript rendering and history tools shared with the hook plugin. An install copies the linked
files into the plugin, but the engine refuses an import that leaves the plugin
folder, so a working copy loads only as a copy with the link resolved:

```sh
cp -RL plugins/okf-wiki-handoff-mod /tmp/okf-wiki-handoff-mod
claude plugin validate /tmp/okf-wiki-handoff-mod
claude --plugin-dir /tmp/okf-wiki-handoff-mod
```

A change to the shared core ships in both plugins, so bump both versions.
