# Auto Mode

Reviews Pi tool calls before they run, so routine work proceeds without
prompts while risky actions are blocked. A second model, the reviewer, checks
each action that could have side effects against a written policy. On by
default.

## How an action is decided

1. A `rules.deny` match blocks the call.
2. A `rules.ask` match asks you.
3. A `rules.allow` match runs it.
4. Read-only tools and commands, and `write`/`edit` inside the working
   directory, run without review.
5. Everything else goes to the reviewer: a quick screen first, then a full
   review for flagged actions.

## Commands

- `/auto-mode on|off` — turn review on or off for this session
- `/auto-mode status` — reviewer model, block counters, review counts
- `/auto-mode blocked` — approve a recently blocked action once

## Config

Create `~/.pi/agent/auto-mode.json` (reloaded on change):

- `model` / `effort` — the reviewer as `provider/model-id` (default: the
  session model)
- `rules` — `deny` / `ask` / `allow` patterns as `tool` or `tool(pattern)`,
  where `*` matches any text
- `hard_deny` / `soft_deny` / `allow` / `environment` — plain-English policy
  lists; write `"$defaults"` to keep the built-in entries

After 3 consecutive blocks (or 20 in a session), auto mode pauses and asks
you about each action that needs review. It is a best-effort guardrail, not a
sandbox — do not rely on it alone for high-stakes systems.
