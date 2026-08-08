# OKF Wiki Autosave

This optional Codex and Claude Code companion keeps shared OKF concepts current
after main-agent turns and journals meaningful work into a dedicated worklog
directory.

For Codex, install both the base and autosave plugins:

```sh
codex plugin add okf-wiki@ryul99-ai-tools
codex plugin add okf-wiki-autosave@ryul99-ai-tools
```

Then open `/hooks` and trust the plugin hook definition. Codex requires this
review for non-managed hooks and repeats it whenever the hook definition
changes.

For Claude Code, install the base plugin without hooks:

```sh
claude plugin install okf-wiki@ryul99-ai-tools
```

Install autosave and its base-plugin dependency:

```sh
claude plugin install okf-wiki-autosave@ryul99-ai-tools
```

The hook requires `okf` and the host CLI (`codex` or `claude`) on `PATH`, an
active matching subscription login, and either an OKF bundle in the current
directory hierarchy or an `OKF_ROOT` value.

## Shared document updates

Section updates only consider existing concepts tagged `worklog-managed` and
update at most three concepts per turn. Planner-written content is sanitized
before it lands in a document: Markdown heading lines inside section content
or journal entries are demoted to bold text so they cannot collide with
managed headings. If a document already contains duplicated managed headings
(for example from earlier tool versions), the next update merges them back
into a single section, keeping the first occurrence.

## Worklog journaling

When a turn contains meaningful work (code changes, debugging with
conclusions, decisions), the hook also appends a journal entry to a worklog
concept. Entries are bullet items grouped under one `## YYYY-MM-DD` heading
per day, appended in chronological order; a turn on an already-journaled day
adds a bullet under the existing day heading. Worklogs live only inside a
dedicated directory under the bundle root (`worklog/` by default) and are
tagged `autosave-worklog`.

- Work that continues an existing worklog is appended to the same concept; new
  work creates a new concept with a new slug. The full slug index plus the
  most relevant worklog bodies are supplied to the planner so slugs are reused
  even for work resumed after a long gap.
- Files outside the worklog directory are never created. `index.md` and
  `log.md` are never modified.
- Created concepts get valid frontmatter via `okf new` and every write is
  validated with `okf validate`, link checks, and citation checks; failed
  checks roll the write back.

Configuration:

- `OKF_AUTOSAVE_WORKLOG_DIR` sets the bundle-relative worklog directory
  (default `worklog`). Set it to an empty string to disable journaling.
- `OKF_AUTOSAVE_WORKLOG_MIN_CONFIDENCE` overrides the journaling confidence
  threshold (default `0.6`).

The child planner uses the same CLI as the host. Claude Code runs `claude -p`
in safe mode without tools, plugins, hooks, skills, or session persistence.
Codex runs `codex exec` ephemerally from an isolated directory with hooks and
user config disabled, a read-only sandbox, and a JSON output schema. Matching
API-key, gateway, and cloud-provider routing environment variables are removed
from the child so the active subscription credential is used.

Set `OKF_AUTOSAVE_CLAUDE_MODEL` to override the Claude model (default `sonnet`)
or `OKF_AUTOSAVE_CODEX_MODEL` to select a Codex model (the Codex default is
used when unset). `OKF_AUTOSAVE_CLI=claude|codex` overrides automatic host
detection.
