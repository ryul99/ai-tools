# Command Reference

## Bundle and output behavior

- Resolve a bundle root from an explicit user value, normal upward discovery, or the non-empty `OKF_ROOT` environment variable, in that order. Ask the user when none is available.
- When using `OKF_ROOT`, quote it and pass it explicitly: `okf --root "$OKF_ROOT" <command>`.
- Validate an explicit or environment-provided root before relying on it. If it is invalid or unreadable, ask for a corrected path instead of saving a replacement.
- Do not create a separate root-path state file or modify the user's environment or shell startup files.
- Prefer `--format json` for agent interpretation and automation.
- Mutating commands with `--format json` report `changed` (whether a file was, or with `--dry-run` would be, changed) and the target concept as `id`. `path` always means a file path. A `--dry-run` result has the same fields as the real run.
- Use `--today YYYY-MM-DD` when a date-dependent result must be deterministic.
- Concept IDs are bundle-relative POSIX paths without `.md`, such as `tables/orders`. Most concept arguments also accept an explicit `.md` path.
- Treat `index.md` and `log.md` as reserved files, not concept IDs.

## Create and inspect

```text
okf init [path] [--version 0.2] [--dry-run]
okf new <concept> --type <type> [--title <text>] [--description <text>]
  [--resource <value>] [--tag <tag>]... [--status draft|stable|deprecated]
  [--generated-by <actor>] [--dry-run]
okf list [path] [filters]
okf show <concept>
okf search <query> [--metadata-only] [--case-sensitive] [--limit <n>] [filters]
```

`show` prints the whole concept; its JSON adds `identity`, the SHA-256 of the file. Read only the frontmatter with `okf meta get <concept>` and only the body with `okf body get <concept>`. `list` JSON records also include `stale_after` and `latest_verification`. `search --limit` keeps the first matches in concept ID order and notes omitted matches on stderr.

The shared list and search filters are:

```text
--type <type>
--tag <tag>
--status draft|stable|deprecated
--trust unverified|machine-confirmed|human-reviewed
--stale
--due-before YYYY-MM-DD
```

List distinct tags across the bundle or within a concept or directory:

```text
okf tag list [path] [--counts]
```

Text output lists tags in lexical order, one per line. `--counts` reports the number of concepts using each tag; repeated instances of the same tag in one concept count once. JSON output is an array of tag strings by default, or objects with `tag` and `count` when `--counts` is supplied. Empty results succeed with no text or an empty JSON array.

## Maintain metadata

```text
okf meta get <concept> [key]
okf meta set <concept> <key> <value>
  [--type string|number|boolean|date|json] [--dry-run]
okf meta unset <concept> <key> [--dry-run]
okf tag add <concept> <tag>... [--dry-run]
okf tag remove <concept> <tag>... [--dry-run]
```

Use dotted metadata paths such as `generated.by`. Supply `--type` for values that could be parsed as a number, boolean, date, null, object, or array. Use `--type json` only for an object or array. Never unset or empty the required `type` field.

## Read and replace bodies

```text
okf body get <concept>
okf body set <concept> [--from-file <path>] [--if-match <sha256>]
  [--warnings-as-errors] [--dry-run]
```

`body set` writes the body from `--from-file` or stdin exactly as supplied and keeps the frontmatter bytes unchanged. `--if-match` refuses the write when the file no longer has the `identity` that `body get` or `show` reported. The result lists link and citation warnings the new body introduces; `--warnings-as-errors` refuses such a write with exit code `1`.

## Manage provenance and lifecycle

```text
okf source list <concept>
okf source add <concept> --resource <value> [source options] [--dry-run]
okf source remove <concept> (--id <id> | --resource <value>) [--dry-run]
okf verify <concept> --by <actor> [--at <ISO-8601-datetime>] [--dry-run]
okf lifecycle set <concept> status draft|stable|deprecated [--dry-run]
okf lifecycle set <concept> stale_after YYYY-MM-DD [--dry-run]
okf lifecycle unset <concept> status|stale_after [--dry-run]
```

Report lifecycle state with `okf list --stale` or `okf list --due-before YYYY-MM-DD`.

## Inspect relationships and validate

```text
okf links outgoing <concept>
okf links backlinks <concept>
okf links check [path] [--warnings-as-errors]
okf citations check [path] [--warnings-as-errors]
okf validate [path] [--warnings-as-errors]
okf move <source> <destination> [--dry-run]
```

## Interpret exit codes

- `0`: command succeeded. Validation may still contain warnings.
- `1`: validation failed, or a requested check was promoted to failure.
- `2`: arguments or command usage were invalid.
- `3`: a filesystem, parsing, recovery, or other operational failure occurred.

Do not infer failure from diagnostic text alone; inspect both the exit code and structured result.
