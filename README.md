# AI Tools

A small collection of plugins for Codex, Claude Code, and Pi.

> This repository is vibe-coded: most of its code and docs are written by AI
> coding agents under human direction.

## Plugins

| Plugin | Codex | Claude Code | Pi | Description |
| --- | --- | --- | --- | --- |
| [`auto-mode`](plugins/auto-mode/README.md) | No | No | Yes | Reviews Pi tool calls with a second model and blocks risky actions. |
| `okf-wiki` | Yes | Yes | Yes | Manages Open Knowledge Format wikis safely with the `okf` CLI. |
| [`okf-wiki-handoff`](plugins/okf-wiki-handoff/README.md) | Yes | Yes | Yes | Keeps session notes to help the agent continue after context compaction. |
| `english-lecturer` | Yes | Yes | Yes | Corrects English prompts and provides brief language feedback. |
| `english-lecturer-mod` | No | Yes (mod) | No | Experimental mod version of `english-lecturer`. |
| [`okf-wiki-handoff-mod`](plugins/okf-wiki-handoff-mod/README.md) | No | Yes (mod) | No | Experimental alternative that continues work in fresh contexts using session notes. |
| [`tips-korean`](plugins/tips-korean/README.md) | Yes | Yes | Yes | Provides guidance for Korean users, the Korean language, and Korea-related contexts. |
| [`tips-engineering`](plugins/tips-engineering/README.md) | Yes | Yes | Yes | Provides guidance for software engineering workflows. |
| [`you-should-know`](plugins/you-should-know/README.md) | No | No | Yes | Watches the session and surfaces a short note above the editor about something worth knowing. |

## Installation

Install only the plugins you need. `okf-wiki` and `okf-wiki-handoff` require
the `okf` CLI:

```sh
uv tool install git+https://github.com/ryul99/okf-wiki.git
```

The Codex and Claude Code handoff plugins install it automatically when
missing; Pi does not. The hook plugins (`english-lecturer`,
`okf-wiki-handoff`) require Node.js 22.18 or newer.

### Codex

```sh
codex plugin marketplace add ryul99/ai-tools
codex plugin add <plugin>@ryul99-ai-tools
```

`okf-wiki-handoff` also requires `okf-wiki`. For hook plugins, open `/hooks`
and trust the plugin hook definition before use.

### Claude Code

```sh
claude plugin marketplace add ryul99/ai-tools
claude plugin install <plugin>@ryul99-ai-tools
```

`english-lecturer-mod` is an optional replacement for `english-lecturer`.
Choose one of `okf-wiki-handoff` and `okf-wiki-handoff-mod`; both install
`okf-wiki`.

### Pi

With Pi 1.6.0 or newer, install the repository as one package:

```sh
pi install git:github.com/ryul99/ai-tools
```

From a checkout, use `pi install .`, or `pi -e .` for one invocation. All
extensions and skills are enabled by default; run `pi config` to choose.

## Usage

For wiki tasks, run inside a wiki, name the wiki root in your request, or set
`OKF_ROOT=/path/to/wiki`.

`english-lecturer` runs on every prompt and does not change the prompt sent
to the agent. To override the model it uses, set
`ENGLISH_LECTURER_CLAUDE_MODEL` (default `haiku`),
`ENGLISH_LECTURER_CODEX_MODEL`, or `ENGLISH_LECTURER_PI_MODEL=provider/model-id`
(default: the active Pi model).
