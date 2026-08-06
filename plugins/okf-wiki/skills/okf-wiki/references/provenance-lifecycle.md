# Provenance, Trust, and Lifecycle

## Manage sources

Inspect existing sources before changing them:

```sh
okf source list metrics/revenue --format json
```

Add a source with only known values:

```sh
okf source add metrics/revenue \
  --resource https://example.com/policy \
  --id policy \
  --title "Revenue Policy" \
  --author human:analyst \
  --last-modified 2026-08-01 \
  --dry-run
```

Supported optional fields are `--id`, `--title`, `--author`, `--usage-count`, `--last-modified`, and the paired `--usage-from` and `--usage-to`. Usage-window dates must be supplied together and in chronological order. Source IDs must be unique within a concept.

Repeat the command without `--dry-run` only after review. Remove a source by exactly one selector:

```sh
okf source remove metrics/revenue --id policy --dry-run
```

Source commands do not add or remove Markdown footnotes. Edit body citations directly, then run `okf citations check`.

## Maintain citation correspondence

Match a source `id` to the body's footnote label:

```markdown
Revenue follows the approved policy.[^policy]

[^policy]: Revenue recognition policy.
```

Treat unmatched footnotes, unused sources, duplicate source IDs, and duplicate footnote definitions as review findings. An unused source can legitimately support the concept as a whole, so do not remove it automatically.

## Append verification

Inspect verification history, then append rather than replace it:

```sh
okf meta get metrics/revenue verified --format json
okf verify metrics/revenue --by human:reviewer --dry-run
okf verify metrics/revenue --by human:reviewer
```

Do not invent an actor. When `--at` is omitted, `okf` records the current UTC time. Supply `--at` only when the user provides a trustworthy event time or a deterministic workflow requires it.

Trust tiers are derived from verification records:

- No `verified` value: `unverified`
- Only non-`human:` verifiers: `machine-confirmed`
- At least one `human:` verifier: `human-reviewed`

## Maintain lifecycle state

Use semantic lifecycle commands:

```sh
okf lifecycle set-status metrics/revenue stable --dry-run
okf lifecycle set-stale-after metrics/revenue 2026-12-01 --dry-run
okf lifecycle clear-stale-after metrics/revenue --dry-run
okf lifecycle report --stale --format json
```

Valid statuses are `draft`, `stable`, and `deprecated`. A concept is stale when the evaluation date is on or after `stale_after`. Use `--today YYYY-MM-DD` when reports or tests must be reproducible.

After provenance, verification, or lifecycle changes, run `okf validate`. Also run citation checks after source changes and link checks when status changes could expose stable-to-deprecated references.
