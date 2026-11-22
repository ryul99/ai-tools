# Handoff Notes

Two optional plugins keep handoff notes. `okf-wiki-handoff`, for Codex,
Claude Code, and Pi, has the agent keep a per-session note current and shows
it again after context compaction. `okf-wiki-handoff-mod`, for Claude Code only, has
the agent keep the note and replaces resets and compactions of the
conversation with it. Handoffs live in their own
bundle under the CLI's configuration directory, `~/.claude/okf-handoff` (under
`$CLAUDE_CONFIG_DIR` when set), `~/.codex/okf-handoff` (under `$CODEX_HOME`
when set), or `~/.pi/agent/okf-handoff` (under `$PI_CODING_AGENT_DIR` when
set). They are never in the user's wiki. Each is
`handoff/<project-key>/<slug>` with type `Handoff` and tag `autosave-handoff`;
the slug is derived from the session ID. Inspect them with `--root` pointing
at that bundle. Notes are rewritten by the session that owns them, so treat
them as machine-owned. The plugins' `history_*` tools read the original
transcripts the notes summarize.
