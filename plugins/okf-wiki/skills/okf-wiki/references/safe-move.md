# Safe Concept Moves

Follow this workflow completely for every concept move. Never use filesystem move commands as a substitute.

## Preflight

1. Confirm the source concept with `okf show`.
2. Confirm the destination concept ID is bundle-relative, is not reserved, and does not already exist.
3. Inspect incoming and outgoing relationships.
4. Generate a structured move plan without writing files.

```sh
okf show a/item --frontmatter-only --format json
okf links backlinks a/item --format json
okf links outgoing a/item --format json
okf move a/item new/item --dry-run --format json
```

Review every planned file, field, and link change. Confirm that the plan contains only the requested path relocation and mechanical reference preservation.

## Understand the plan

The move can update:

- Parsed Markdown destinations that target the moved concept.
- Relative links inside the moved concept when their destinations must remain stable.
- Standard path-valued frontmatter fields: `resource`, `sources[].resource`, `computation`, `executor.resource`, and `attester.resource`.
- The requested concept path.

It preserves link labels, titles, query strings, fragments, surrounding prose, and unrelated metadata. It does not update verification, generation, lifecycle, arbitrary path-like text, code blocks, raw HTML, or external URLs.

Stop if the dry-run proposes an unexpected authored-content change, an ambiguous path, the wrong destination, or a broader scope than requested.

## Execute and verify

Run the exact reviewed move without `--dry-run`:

```sh
okf move a/item new/item --format json
okf show new/item --format json
okf links check --format json
okf validate --format json
```

Inspect important backlinks again when the move affects widely referenced concepts. Report the source, destination, changed files, and post-move validation state.

## Handle transaction recovery

Moves stage recoverable `.okf-transaction-*` state inside the bundle. A later non-dry-run mutation automatically attempts to restore originals and remove a partial destination after interruption.

- Do not delete or edit transaction directories manually.
- Expect a dry-run mutation to refuse while recovery is pending because dry-run cannot alter recovery state.
- Use a normal, narrowly scoped mutation only when automatic recovery is appropriate, then inspect its recovery message and bundle state.
- If the manifest is damaged and automatic recovery is refused, stop. Preserve the transaction directory and report the operational failure for manual recovery.

The move performs post-apply link and validation checks and rolls back on failure. Never report success solely because the destination file appeared; require the command result and post-move checks.
