# Authoring and Metadata Workflow

## Initialize a bundle

Inspect the target before initialization. Never overwrite an existing `index.md`.

```sh
okf init <path> --dry-run
okf init <path>
```

Initialization creates only the root `index.md`; it does not initialize Git or create a predefined hierarchy.

## Create and author a concept

1. Choose a bundle-relative concept ID and a producer-defined, non-empty type.
2. Preview the new file.
3. Create it.
4. Edit the Markdown body directly with filesystem editing tools.
5. Validate the concept or bundle.

```sh
okf new tables/orders --type "BigQuery Table" --title "Orders" --dry-run
okf new tables/orders --type "BigQuery Table" --title "Orders"
# Edit tables/orders.md directly.
okf validate tables/orders
```

Do not expect `okf new` to update `index.md` or `log.md`. Add authored navigation or log prose only when the user requests it.

## Inspect before editing

Use the narrowest view that answers the question:

```sh
okf show tables/orders --frontmatter-only --format json
okf show tables/orders --body-only
okf meta get tables/orders generated.by --format json
okf tag list --format json
okf tag list tables --counts --format json
```

Use `list` and `search` first when the exact concept is unknown. Use `tag list` to discover the bundle's tag vocabulary or inspect tag usage within a path. Do not guess a concept ID or tag when discovery can resolve it.

## Change frontmatter narrowly

Prefer semantic commands for standard metadata families:

- Use `tag` for tags.
- Use `source` for provenance entries.
- Use `verify` for verification history.
- Use `lifecycle` for status and staleness.
- Use `meta` for other fields and producer-defined extensions.

Preview and execute the same mutation:

```sh
okf meta set tables/orders owner data-platform --dry-run
okf meta set tables/orders owner data-platform

okf meta set tables/orders enabled true --type boolean --dry-run
okf meta set tables/orders enabled true --type boolean

okf tag add tables/orders sales curated --dry-run
okf tag add tables/orders sales curated
```

Frontmatter mutations preserve the Markdown body and unknown keys. Still inspect the dry-run because YAML representation around the requested field can change. Removing a missing tag is a successful no-op.

## Finish an authoring change

Run:

```sh
okf validate
okf links check
okf citations check
```

Run all three after body or citation edits. For metadata-only edits, always run validation and add the relationship checks when path-valued metadata, sources, status, or citations are involved.
