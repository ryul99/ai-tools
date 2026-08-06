# Validation and Diagnostics

## Choose the check

- Use `okf validate [path]` for OKF structure, metadata shapes, stale state, path-valued fields, and cross-concept policy diagnostics.
- Use `okf links check [path]` for broken or outside-bundle internal links.
- Use `okf citations check [path]` for relationships between body footnotes and `sources[].id`.
- Use `okf lifecycle report` to inventory stale or upcoming concepts without running the full validator.

Prefer JSON when diagnosing or automating:

```sh
okf validate --format json
okf links check --format json
okf citations check --format json
```

Diagnostics include stable codes, severity, file, and optional field or line information. Use these locations to inspect real files before proposing a fix.

## Distinguish errors and warnings

Conformance errors include missing or invalid concept frontmatter, a missing or invalid required `type`, and invalid reserved-file structure.

Warnings can include malformed optional metadata, broken links, citation mismatches, stale concepts, missing recommended title or description, missing path targets, and stable concepts linking to deprecated concepts. Unknown types and unknown frontmatter keys are permitted extensions and are not errors by themselves.

Do not fix warnings mechanically. Determine whether each warning indicates a defect, intentional extension, accepted staleness, or incomplete authored content.

## Use strict checks intentionally

By default, warnings do not fail `validate`, `links check`, or `citations check`. Add `--warnings-as-errors` only when the user requests strict behavior or an established CI policy requires it:

```sh
okf validate --warnings-as-errors --format json
okf links check --warnings-as-errors --format json
okf citations check --warnings-as-errors --format json
```

Interpret exit codes as follows:

- `0`: success; warnings may be present.
- `1`: validation errors exist, or warnings were promoted to failure.
- `2`: usage error; correct the invocation rather than editing content.
- `3`: operational failure; inspect filesystem, parsing, root discovery, concurrency, or transaction recovery.

## Validate after changes

- Metadata-only change: run `okf validate`.
- Markdown body change: run validate, link check, and citation check.
- Source or citation change: run validate and citation check.
- Status change: run validate and link check.
- Concept move: follow the complete safe-move workflow; do not substitute this summary for it.

Report remaining warnings separately from errors and state whether strict mode was used.
