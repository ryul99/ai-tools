# OKF Wiki Handoff (mod)

This experimental Claude Code mod replaces context compaction with a handoff
note saved in an OKF bundle. Instead of summarizing the conversation in place,
it asks the model to write a structured handoff, stores it as an OKF concept,
and continues from that note while the original messages stay recallable.

```sh
claude plugin install okf-wiki-handoff-mod@ryul99-ai-tools
```

It declares `okf-wiki` as a dependency and requires `okf` 0.2.0 or newer on
`PATH`.

## Where handoffs are stored

Handoffs are session working state, so they stay out of your knowledge wiki.
The mod keeps them in its own bundle under the Claude Code configuration
directory, `$CLAUDE_CONFIG_DIR` or `~/.claude`, and creates it with
`okf init` on first use:

```text
~/.claude/okf-handoff/
  index.md
  handoff/<project-key>/<slug>.md
```

`<project-key>` names the session's project root the way Claude Code names its
folders under `~/.claude/projects/`. Handoffs of other projects are never
offered for reuse. `OKF_ROOT` does not affect where handoffs go. Read them with
`okf --root ~/.claude/okf-handoff list handoff/<project-key>`.

## What happens on a compaction

Every compaction of the main conversation, automatic or `/compact`, is
replaced. Subagent compactions are left to Claude Code.

1. A fork of the conversation writes a handoff with `# Goal`, `# State`,
   `# Decisions and constraints`, `# Next steps`, and `# Open questions`.
   Text passed to `/compact` is given to it as what to keep or stress.
2. The note is saved as `handoff/<project-key>/<slug>` (type `Handoff`, tag
   `autosave-handoff`) with `okf new`, `okf meta set`, and
   `okf body set --if-match`. A session keeps writing to the same slug; a new
   session in the same project may continue an existing one.
3. The conversation becomes the handoff message followed by the newest whole
   turns that fit in 24,000 characters. When no turn fits, the person's latest
   request is copied into the handoff message verbatim. Worklogs are not added.

If the bundle cannot be created, or the fork, the note, or `okf` fails, the
compaction runs as usual and a notice says why. Claude Code's ahead-of-time
compaction is skipped because the handoff is written when the compaction runs.

## Archived originals

Each compaction archives the conversation it replaces as a numbered segment of
its handoff. A segment is a pointer, the transcript file and line range, kept
in the note's `segments` frontmatter; the body's `# Archived segments` section
lists the segment numbers and line ranges.

The model reads a segment back with the `mcp__okf-wiki-handoff-mod__recall`
tool, which takes `segment`, an optional `handoff` slug in the current project,
and an optional `from_line` to page through long segments. Recall works only
while the transcript file exists.

## Limits

- A fork needs a request already sent in the current process, so `/compact` as
  the first action after resuming a session falls back to the usual
  compaction.
- Tool results that arrived after the last request are passed to the fork
  explicitly, up to 8,000 characters.
- Handoff notes are machine-owned and overwritten on every compaction. Move
  durable conclusions into curated concepts manually.
