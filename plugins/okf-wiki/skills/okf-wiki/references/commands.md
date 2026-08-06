# Command Reference

## Bundle and output behavior

- Resolve a bundle root from an explicit user value, normal upward discovery, or the non-empty `OKF_ROOT` environment variable, in that order. Ask the user when none is available.
- When using `OKF_ROOT`, quote it and pass it explicitly: `okf --root "$OKF_ROOT" <command>`.
- Validate an explicit or environment-provided root before relying on it. If it is invalid or unreadable, ask for a corrected path instead of saving a replacement.
- Do not create a separate root-path state file or modify the user's environment or shell startup files.
- Prefer `--format json` for agent interpretation and automation.
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
okf show <concept> [--frontmatter-only | --body-only]
okf search <query> [--metadata-only] [--case-sensitive] [filters]
```

The shared list and search filters are:

```text
--type <type>
--tag <tag>
--status draft|stable|deprecated
--trust unverified|machine-confirmed|human-reviewed
--stale
--due-before YYYY-MM-DD
```

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

## Manage provenance and lifecycle

```text
okf source list <concept>
okf source add <concept> --resource <value> [source options] [--dry-run]
okf source remove <concept> (--id <id> | --resource <value>) [--dry-run]
okf verify <concept> --by <actor> [--at <ISO-8601-datetime>] [--dry-run]
okf lifecycle set-status <concept> draft|stable|deprecated [--dry-run]
okf lifecycle set-stale-after <concept> YYYY-MM-DD [--dry-run]
okf lifecycle clear-stale-after <concept> [--dry-run]
okf lifecycle report [--stale] [--due-before YYYY-MM-DD]
```

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
