---
name: okf-wiki
description: Manage file-based Open Knowledge Format (OKF) wiki bundles with the okf CLI. Use when Codex or Claude needs to initialize an OKF bundle; create, inspect, search, or edit concepts; manage frontmatter, tags, sources, verification, trust, or lifecycle metadata; audit validation, links, citations, or stale content; or safely move a concept while preserving internal references.
---

# OKF Wiki

Use `okf` for structural and metadata operations while keeping Markdown files authoritative. Assume the command is installed and invoke it directly.

## Route the task

- For command syntax, shared flags, filters, output, and exit codes, read [references/commands.md](references/commands.md).
- For bundle creation, concept authoring, frontmatter, and tags, read [references/authoring-workflow.md](references/authoring-workflow.md).
- For sources, citations, verification, trust, and lifecycle state, read [references/provenance-lifecycle.md](references/provenance-lifecycle.md).
- For validation, link checks, citation checks, diagnostics, and CI behavior, read [references/validation-diagnostics.md](references/validation-diagnostics.md).
- Before moving any concept, read and follow [references/safe-move.md](references/safe-move.md) completely.

Read only the references needed for the current request.

## Follow the core workflow

1. Resolve the bundle root in this order:
   1. Use the root explicitly supplied by the user for the current request.
   2. Otherwise, use normal `okf` discovery when the current directory is inside an explicit OKF bundle.
   3. Otherwise, if the `OKF_ROOT` environment variable is non-empty, validate that path and pass it as `--root "$OKF_ROOT"`.
   4. Otherwise, ask the user for the wiki root before running a bundle-dependent command.
2. Inspect the relevant concepts and metadata before proposing a change. Prefer `--format json` when interpreting command output programmatically.
3. Make the narrowest requested change. Edit Markdown prose directly with filesystem tools; use `okf` for bundle structure and frontmatter.
4. Run every mutating `okf` command with `--dry-run` first and review the complete proposal.
5. Execute the same command without `--dry-run` only after the proposal matches the request.
6. Run `okf validate` after changes. Also run link and citation checks when bodies, paths, sources, or citations may have changed.

## Preserve authority and scope

- Do not expect `okf` to author, rewrite, or reformat existing Markdown prose. The targeted destination rewrite performed by `okf move` is the exception.
- Do not update `index.md` or `log.md` unless the user explicitly requests authored changes. Allow `okf init` to create `index.md` and `okf move` to update affected link destinations.
- Do not invent actors, provenance, verification events, sources, lifecycle dates, or metadata values.
- Do not create a root-path state file or modify `OKF_ROOT` or shell startup files. Treat an explicitly supplied root as current-request context only.
- If `OKF_ROOT` is set but does not identify a usable bundle, report the invalid value and ask for a corrected root. Do not silently overwrite or persist a replacement.
- Do not treat unknown types or frontmatter keys as invalid merely because they are unfamiliar.
- Do not turn advisory warnings into content changes without evaluating their meaning and the user's intent.
- Never replace `okf move` with `mv`, `git mv`, or manual path rewrites.
- Never delete `.okf-transaction-*` state manually. Let a non-dry-run mutation perform documented recovery or stop and report damaged recovery state.

## Report results

Summarize inspected state, exact changes, validation results, and remaining warnings. Distinguish command usage errors, operational failures, and validation findings. When no mutation was requested, remain read-only.
