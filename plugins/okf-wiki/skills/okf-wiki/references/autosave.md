# Optional Autosave Companion

The base `okf-wiki` plugin does not install hooks. Claude Code users may
separately install `okf-wiki-autosave`, which depends on the base plugin and
runs a Stop hook after main-agent turns.

## Opt in shared documents

Autosave never creates session documents. It considers only existing concepts
tagged `worklog-managed` and updates at most three concepts per turn.

Use durable topic, project, decision, or runbook concepts rather than
conversation-oriented files. Managed bodies may contain these default
sections:

```markdown
# Current state

# Decisions

# Verification

# Next steps

# Recent changes
```

Override the allowed section names for one concept with an extension field:

```yaml
automation:
  sections:
    - Status
    - Decisions
    - Follow-up
```

Machine updates are refused for deprecated or human-reviewed concepts by
default. A human-reviewed concept must explicitly opt in:

```yaml
automation:
  allow_machine_updates: true
```

## Understand update behavior

The hook reads the current turn and workspace state transiently, retrieves
candidate concepts with `okf`, and invokes `claude -p` with a JSON Schema. The
child process uses the current Claude subscription login and returns a bounded
section-update plan. It has no tools and cannot write files.

The deterministic writer enforces candidate IDs, allowed headings, confidence,
content hashes, and atomic writes. It validates bodies, links, and citations
after applying a plan and restores originals if checks fail. Hook receipts are
content fingerprints in plugin data; they contain no session ID or transcript.

## Configure operation

- Set `OKF_ROOT` when Claude Code runs outside the target bundle.
- Set `OKF_AUTOSAVE_MODEL` to override the default `sonnet` model.
- Set `OKF_AUTOSAVE_MIN_CONFIDENCE` to override the default `0.85` threshold.
- Set `OKF_AUTOSAVE_MAX_CANDIDATES` to change the default candidate limit of 8.

If no valid bundle or opted-in concept is available, autosave performs no
write. It never modifies `index.md` or `log.md`.
