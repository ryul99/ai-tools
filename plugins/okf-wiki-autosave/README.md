# OKF Wiki Autosave

This optional Codex and Claude Code companion journals meaningful work into a
dedicated worklog directory after main-agent turns.

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

## Worklog journaling

When a turn contains meaningful work (code changes, debugging with
conclusions, decisions), the hook appends a journal entry to a worklog
concept. Entries are bullet items grouped under one `## YYYY-MM-DD` heading
per day, appended in chronological order; a turn on an already-journaled day
adds a bullet under the existing day heading. Worklogs live only inside a
dedicated directory under the bundle root (`worklog/` by default) and are
tagged `autosave-worklog`. Planner-written content is sanitized before it
lands in a document: Markdown heading lines inside journal entries are demoted
to bold text so they cannot collide with the per-day date headings.

- Work that continues an existing worklog is appended to the same concept; new
  work creates a new concept with a new slug. The full slug index plus the
  most relevant worklog bodies are supplied to the planner so slugs are reused
  even for work resumed after a long gap.
- Files outside the worklog directory are never created. `index.md` and
  `log.md` are never modified.
- Created concepts get valid frontmatter via `okf new` and every write is
  validated with `okf validate`, link checks, and citation checks; failed
  checks roll the write back.

## Rollover

A worklog that grows past its byte budget sheds its oldest days into sealed
partition concepts named `<slug>-1`, `<slug>-2`, and so on, so the concept the
hook appends to stays small.

- Days are the atomic unit. A single day is never divided, and the worklog
  always keeps at least its most recent day, so a day larger than the budget
  seals on its own.
- Cuts are made by position in the body, never by parsed date, so a day
  heading that arrives out of order cannot reorder or merge earlier history.
- A partition records the span it covers in its title, carries the topic tags
  of the worklog it came from, and is never written again.
- Only the worklog the hook appends to carries `autosave-worklog-head`, and
  the planner index is built from that tag, so a sealed partition is never
  offered as a slug to append to. Both heads and partitions keep
  `autosave-worklog`.
- Sealing and the append are one transaction: a failed check removes the new
  partitions and restores the original worklog.

Configuration:

- `OKF_AUTOSAVE_WORKLOG_DIR` sets the bundle-relative worklog directory
  (default `worklog`). Set it to an empty string to disable journaling.
- `OKF_AUTOSAVE_WORKLOG_MIN_CONFIDENCE` overrides the journaling confidence
  threshold (default `0.6`).
- `OKF_AUTOSAVE_WORKLOG_MAX_BYTES` sets the rollover budget in bytes (default
  `16000`). Set it to an empty string to disable rollover.

## Autonomous turns

Turns triggered by the system rather than a typed prompt — background task
notifications, Monitor events, scheduled wakeups, peer-agent messages — are
skipped automatically, so long autonomous runs do not flood the worklog. The
detection reads the origin of the newest prompt in the Claude Code transcript;
these fields are undocumented, so if they ever disappear the hook fails open
and journals normally. Codex rollouts carry no origin marker and are always
treated as human-triggered.

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
