# Optional Autosave Companion

The base `okf-wiki` plugin does not install hooks. Codex and Claude Code users
may separately install `okf-wiki-autosave`, which runs a Stop hook after
main-agent turns. Claude Code installs the declared base-plugin dependency;
Codex users install both plugins explicitly and trust the hook through
`/hooks`.

## Journal work in the worklog directory

Autosave keeps an automatic work journal. When a turn contains meaningful
work, it appends a bullet entry under a per-day `## YYYY-MM-DD` heading at the
end of a worklog concept inside a dedicated bundle-relative directory
(`worklog/` by default); same-day entries share one heading, so the body reads
as an ascending daily timeline. Work continuing an existing
worklog reuses that concept's slug — the planner sees the full slug index and
the most relevant worklog bodies — while new work creates a new concept via
`okf new` with type `Worklog` and tag `autosave-worklog`.

An entry is planned as a scope tag, a summary, and a list of refs, then
rendered into one bullet — `` - `[scope]` summary (ref · ref) `` — so each
line identifies its own subject and outcome without the surrounding entries.
Read the scope tags to scan a worklog; the refs point at the pull requests,
issues, commits, and files the entry came from.

Worklog bodies are written with `okf body set --if-match`, so the frontmatter
stays unchanged and a concurrent edit makes the write fail instead of being
overwritten. Concepts are only ever created inside the worklog directory. Treat worklog concepts as machine-owned journals; move durable
conclusions into curated concepts manually.

## Recognize handoff notes

Two optional plugins keep handoff notes. `okf-wiki-handoff`, for Codex and
Claude Code, has the agent keep a per-session note current and shows it again
after context compaction. `okf-wiki-handoff-mod`, for Claude Code only,
replaces context compaction with a handoff note. Handoffs live in their own
bundle under the CLI's configuration directory, `~/.claude/okf-handoff` (under
`$CLAUDE_CONFIG_DIR` when set) or, for Codex, `~/.codex/okf-handoff` (under
`$CODEX_HOME` when set), never in the user's wiki. Each is
`handoff/<project-key>/<slug>` with type `Handoff` and tag `autosave-handoff`;
the hook plugin's slug is the session ID. Inspect them with `--root` pointing
at that bundle. Notes are rewritten by the session that owns them, so treat
them as machine-owned like a worklog. Their `segments` frontmatter points at
transcript line ranges that the plugins' `recall` tools read.

## Read a partitioned worklog

A worklog that outgrows its byte budget sheds its oldest days into sealed
partitions named `<slug>-1`, `<slug>-2`, and so on, so the concept the hook
appends to stays small. A day is never divided across partitions, and each
partition names the span it covers in its title.

Both the active worklog and its partitions carry `autosave-worklog` and the
topic tags of the stream, so `okf list --tag <topic>` and `okf search` reach
every part. Only the active worklog carries `autosave-worklog-head`; filter on
that tag to find the concept currently being appended to. Partitions are
immutable — read them, but do not append to them.

## Understand update behavior

The hook reads the current turn and workspace state transiently, retrieves
existing worklogs with `okf`, and invokes the host CLI with a JSON Schema.
Claude Code uses a tool-free `claude -p` child; Codex uses an ephemeral
`codex exec` child in an isolated directory with hooks and user config disabled
and a read-only sandbox. The child uses the matching subscription login and
returns a bounded journaling plan.

The deterministic writer enforces the slug pattern and confidence threshold,
then writes bodies through `okf body set --if-match`. A rollover writes its
sealed partitions before the active worklog and removes them if a later write
fails, so a failed plan leaves the worklog as it was. Hook receipts are
content fingerprints in plugin data; they contain no session ID or transcript.

## Configure operation

- Set `OKF_ROOT` when the agent runs outside the target bundle.
- Set `OKF_AUTOSAVE_CLAUDE_MODEL` to override the Claude default `sonnet` model.
- Set `OKF_AUTOSAVE_CODEX_MODEL` to override the current Codex default model.
- Set `OKF_AUTOSAVE_CLI` to `claude` or `codex` to override host detection.
- Set `OKF_AUTOSAVE_WORKLOG_DIR` to change the worklog directory (default
  `worklog`), or to an empty string to disable journaling.
- Set `OKF_AUTOSAVE_WORKLOG_MIN_CONFIDENCE` to override the journaling
  threshold (default `0.6`).
- Set `OKF_AUTOSAVE_WORKLOG_MAX_BYTES` to change the rollover budget in bytes
  (default `16000`), or to an empty string to disable rollover.
- System-triggered turns (task notifications, Monitor events, scheduled
  wakeups, peer-agent messages) are skipped automatically in Claude Code.

If no valid bundle is available or the worklog directory is disabled, autosave
performs no write. It never modifies `index.md` or `log.md`.
