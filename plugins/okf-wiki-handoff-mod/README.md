# OKF Wiki Handoff (mod)

This experimental Claude Code mod brings the context management of Codex's
experimental handoff to Claude Code. The model keeps a handoff note in an OKF
bundle while it works, is reminded before the context window runs out, and can
start a fresh context window that holds only the note. Compactions are replaced
by the note too, and the original messages stay recallable.

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
```

`<project-key>` names the session's project root the way Claude Code names its
folders under `~/.claude/projects/`. A session that started on an earlier
version of the mod keeps the slug it chose then. `OKF_ROOT` does not affect
where notes go. Read them with
`okf --root ~/.claude/okf-handoff list handoff/<project-key>`.

## How the model keeps the note

A system prompt section tells the main agent which note is its own and how to
keep it: rewrite it whenever the goal, a decision, the state of the work, or
the next steps change, with the sections `# Goal`, `# State`,
`# Decisions and constraints`, `# Next steps`, and `# Open questions`. It also
lists the five most recent notes of other sessions in the project, so a new
session can pick one of them up.

The mod registers these tools, each loaded from the start:

| Tool | What it does |
| --- | --- |
| `handoff_write` | Replaces the session's note, creating it when needed. |
| `handoff_read` | Reads the session's note, or another note of the project by its slug. |
| `context_remaining` | Reports the tokens in use, the window, and how many tokens remain before automatic compaction. |
| `new_context` | Starts a fresh context window holding only the note when the turn ends. |
| `recall` | Reads an archived segment of the original conversation. |

Subagents may read notes but cannot write one or call `new_context`.

## Reminders

Reminders reach the main agent after its tool calls and with the person's
prompts, as context the person does not see:

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
whole conversation with one message that holds the note and how to recall the
archived segments, without a summary, and the mod submits a prompt that tells
the agent to continue from the note. The `/compact` lines appear in the
transcript.

If the note is more than 10,000 tokens behind the work at that point, the mod
first asks a fork of the conversation to bring it up to date. An interrupted
turn cancels the reset, and so does a session that exits before the turn ends.

## Compactions

Every compaction of the main conversation, automatic or `/compact`, is replaced
the same way, except that the newest whole turns that fit in 24,000 characters
are kept after the note; when no turn fits, the person's latest request is
copied into the note message verbatim. A note that is current is used as it
is; a note that is missing or more than 10,000 tokens behind is rewritten
first by a fork of the conversation, with any text passed to `/compact` given
to it as what to keep or stress. Subagent compactions are left to Claude Code,
and Claude Code's ahead-of-time compaction is skipped because the note is
written when the compaction runs.

When the fork gives no usable note, a note that exists is used as it is. If the
bundle cannot be created, there is no note to use, or `okf` fails, the
compaction runs as usual and a notice says why.

## Archived originals

Each reset or compaction archives the conversation it replaces as a numbered
segment of the note. A segment is a pointer, the transcript file and line
range, kept in the note's `segments` frontmatter; the body's
`# Archived segments` section lists the segment numbers and line ranges.

The model reads a segment back with the `mcp__okf-wiki-handoff-mod__recall`
tool, which takes `segment`, an optional `handoff` slug in the current project,
and an optional `from_line` to page through long segments. Recall works only
while the transcript file exists.

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
