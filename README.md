# AI Tools

A small collection of plugins for Codex and Claude Code.

> This repository is vibe-coded: most of its code and docs are written by AI
> coding agents under human direction.

## Plugins

| Plugin | Codex | Claude Code | Description |
| --- | --- | --- | --- |
| `council` | Yes | Yes | Uses multiple model perspectives to evaluate and synthesize answers. |
| `okf-wiki` | Yes | Yes | Manages Open Knowledge Format wikis safely with the `okf` CLI. |
| [`okf-wiki-handoff`](plugins/okf-wiki-handoff/README.md) | Yes | Yes | Keeps session notes to help the agent continue after context compaction. |
| `english-lecturer` | Yes | Yes | Corrects English prompts and provides brief language feedback. |
| `english-lecturer-mod` | No | Yes (mod) | Experimental mod version of `english-lecturer`. |
| [`okf-wiki-handoff-mod`](plugins/okf-wiki-handoff-mod/README.md) | No | Yes (mod) | Experimental alternative that continues work in fresh contexts using session notes. |
| [`tips-korean`](plugins/tips-korean/README.md) | Yes | Yes | Provides guidance for Korean users, the Korean language, and Korea-related contexts. |
| [`tips-engineering`](plugins/tips-engineering/README.md) | Yes | Yes | Provides guidance for software engineering workflows. |

## Installation

### Codex

```sh
codex plugin marketplace add ryul99/ai-tools
codex plugin add council@ryul99-ai-tools
codex plugin add okf-wiki@ryul99-ai-tools
codex plugin add okf-wiki-handoff@ryul99-ai-tools
codex plugin add english-lecturer@ryul99-ai-tools
codex plugin add tips-korean@ryul99-ai-tools
codex plugin add tips-engineering@ryul99-ai-tools
```

Install only the plugins you need. `okf-wiki-handoff` also requires `okf-wiki`.
For `english-lecturer` and `okf-wiki-handoff`, open `/hooks` in Codex and
trust the plugin hook definition before use. Both require Node.js 22.18 or newer.

### Claude Code

```sh
claude plugin marketplace add ryul99/ai-tools
claude plugin install council@ryul99-ai-tools
claude plugin install okf-wiki@ryul99-ai-tools
claude plugin install okf-wiki-handoff@ryul99-ai-tools
claude plugin install english-lecturer@ryul99-ai-tools
claude plugin install tips-korean@ryul99-ai-tools
claude plugin install tips-engineering@ryul99-ai-tools
```

Install only the plugins you need. `okf-wiki-handoff` also installs `okf-wiki`.
The `english-lecturer` and `okf-wiki-handoff` hook plugins require Node.js
22.18 or newer.

The `english-lecturer` mod is an optional replacement for its hook plugin:

```sh
claude plugin install english-lecturer-mod@ryul99-ai-tools
```

Choose one handoff plugin: `okf-wiki-handoff` restores notes alongside the
CLI's compaction summary; the experimental `okf-wiki-handoff-mod` uses notes
in place of that summary and lets the agent continue in fresh contexts.

```sh
claude plugin install okf-wiki-handoff-mod@ryul99-ai-tools
```

## Usage

Ask Codex or Claude Code to use an installed skill, for example:

```text
Use the council to evaluate this proposal.
Find related concepts in my OKF wiki.
Write this explanation in clear Korean.
Investigate related GitHub issues and pull requests.
```

The `okf-wiki` plugin requires the `okf` CLI:

```sh
uv tool install git+https://github.com/ryul99/okf-wiki.git
```

The handoff plugins install it automatically when missing; this requires
`uv` and network access. For wiki tasks, run inside a wiki, provide the wiki
root in your request, or set it for your shell:

```sh
export OKF_ROOT=/path/to/wiki
```

The `english-lecturer` plugin runs automatically for Codex and Claude Code
prompts after installation. Codex also requires the `/hooks` trust approval
described above. Set `ENGLISH_LECTURER_CLAUDE_MODEL` to override Claude's
default `haiku` model, or `ENGLISH_LECTURER_CODEX_MODEL` to override the current
Codex default model used for its feedback.
