# OKF Wiki Autosave

This optional Claude Code companion keeps shared OKF concepts current after
main-agent turns and journals meaningful work into a dedicated worklog
directory.

Install the base plugin without hooks:

```sh
claude plugin install okf-wiki@ryul99-ai-tools
```

Install autosave and its base-plugin dependency:

```sh
claude plugin install okf-wiki-autosave@ryul99-ai-tools
```

The hook requires `okf` and `claude` on `PATH`, an active Claude subscription
login, and either an OKF bundle in the current directory hierarchy or an
`OKF_ROOT` value.

## Shared document updates

Section updates only consider existing concepts tagged `worklog-managed` and
update at most three concepts per turn.

## Worklog journaling

When a turn contains meaningful work (code changes, debugging with
conclusions, decisions), the hook also appends a timestamped journal entry to
a worklog concept. Worklogs live only inside a dedicated directory under the
bundle root (`worklog/` by default) and are tagged `autosave-worklog`.

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

The child `claude -p` process runs in safe mode without tools, plugins, hooks,
skills, or session persistence. API-key, gateway, and cloud-provider routing
environment variables are removed from that child so the active subscription
OAuth credential is used.
