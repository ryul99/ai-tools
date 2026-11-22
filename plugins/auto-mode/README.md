# Auto Mode

Reviews Pi tool calls before they run, so routine work proceeds without
prompts while risky actions are blocked. A second model, the reviewer, checks
each action that could have side effects against a written policy.

## Installation

Install the [Pi package](../../README.md#pi). Auto mode is on when a session
starts. Turn it off with `/auto-mode off`.

## How an action is decided

The first step that applies decides:

1. A `rules.deny` match blocks the call.
2. A `rules.ask` match asks you.
3. A `rules.allow` match runs the call.
4. These run without review:
   - Read-only tools: `read`, `grep`, `find`, and `ls`.
   - `write` and `edit` inside the working directory, except protected files
     such as `.git/`, `.github/`, `.pi/`, `.env*`, and `.npmrc`.
   - Shell commands that only read, such as `ls`, `cat`, `rg`, and `git status`.
     A command with command substitution or output redirection to a file goes
     to the reviewer.
5. Everything else goes to the reviewer.

The reviewer sees your messages, the agent's earlier tool calls, the pending
call, and the project's instruction files such as `AGENTS.md`. It does not see
the agent's replies, its reasoning, or tool output. That keeps the agent from
arguing its case and keeps content the agent read, such as a web page with
hidden instructions, from steering the reviewer.

The review has two stages:

- **Screen.** A one-word answer that leans toward blocking. Most safe actions
  pass here.
- **Review.** Runs only for flagged actions and reasons through the policy.

When the reviewer blocks a call, the agent receives the reason and is told to
find a safer approach or ask you. After 3 blocks in a row or 20 in a session,
auto mode pauses and asks you about each action that needs review. Approving
one resumes auto mode.

When the reviewer fails or times out, Pi asks you. Without an interactive UI,
such as with `pi -p`, the call is blocked instead and the agent continues.

## Policy

The policy has four lists of plain-English rules:

- `hard_deny`: blocked even if you ask for the action.
- `soft_deny`: blocked unless an `allow` exception covers the action or you
  explicitly asked for it. To count as explicit, your message must name the
  action and its target, such as "force-push this branch". A general goal such
  as "clean up the repo" does not count.
- `allow`: exceptions to `soft_deny`.
- `environment`: the trust boundary. By default, only the working directory,
  its repository, and the repository's configured remotes are trusted.
  Everything else is treated as external.

## Configuration

Create `~/.pi/agent/auto-mode.json`. Project directories cannot configure auto
mode, so a repository cannot loosen its own review.

```json
{
  "model": "openrouter/~anthropic/claude-haiku-latest",
  "rules": {
    "deny": ["bash(terraform destroy *)"],
    "ask": ["bash(git push *)"],
    "allow": ["bash(npm test)", "write(generated/*)"]
  },
  "environment": ["$defaults", "Source control: github.com/my-org and all repos under it"],
  "allow": ["$defaults", "Deploying to the staging namespace is fine: it resets nightly"],
  "soft_deny": ["$defaults", "Never run database migrations outside the migrations CLI"],
  "hard_deny": ["$defaults"]
}
```

Every key is optional.

- **`model`**: the reviewer, as `provider/model-id`. If you omit it, the
  reviewer uses the session model. A small, fast model keeps reviews quick.
- **Policy lists**: each list replaces the built-in list of the same name.
  Write `"$defaults"` to keep the built-in entries at that position.
- **`rules`**: written as `tool` or `tool(pattern)`, where `*` matches any
  text.
  - Bash patterns match each part of a chained command. Deny and ask rules
    apply if any part matches. An allow rule applies only if every part
    matches.
  - Path patterns match the path relative to the working directory, or the
    absolute path.
  - Allow rules broad enough to run arbitrary code are ignored, such as `bash`,
    `bash(*)`, `bash(python *)`, and `bash(npm run *)`.

Pi reloads the file when it changes.

## Commands

- `/auto-mode on` or `/auto-mode off`: turn review on or off for this session.
- `/auto-mode status`: show the reviewer model, block counters, review
  counts, and reviewer token usage.
- `/auto-mode blocked`: pick a recently blocked action to approve once. Then
  ask the agent to retry it.

## Limits

The reviewer is a best-effort guardrail, not a sandbox. It judges intent and
risk, not whether code is correct, and it can be wrong in both directions. Do
not rely on it alone for high-stakes systems. Use a container or sandbox where
that matters.
