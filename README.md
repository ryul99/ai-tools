# AI Tools

A small collection of plugins for Codex and Claude Code.

## Plugins

| Plugin | Codex | Claude Code | Description |
| --- | --- | --- | --- |
| `council` | Yes | Yes | Uses multiple model perspectives to evaluate and synthesize answers. |
| `okf-wiki` | Yes | Yes | Manages Open Knowledge Format wikis safely with the `okf` CLI. |
| `english-lecturer` | No | Yes | Corrects English prompts and provides brief language feedback. |

## Installation

### Codex

```sh
codex plugin marketplace add ryul99/ai-tools
codex plugin add council@ryul99-ai-tools
codex plugin add okf-wiki@ryul99-ai-tools
```

### Claude Code

```sh
claude plugin marketplace add ryul99/ai-tools
claude plugin install council@ryul99-ai-tools
claude plugin install okf-wiki@ryul99-ai-tools
claude plugin install english-lecturer@ryul99-ai-tools
```

Install only the plugins you need.

## Usage

Ask Codex or Claude Code to use an installed skill, for example:

```text
Use the council to evaluate this proposal.
Find related concepts in my OKF wiki.
```

The `okf-wiki` plugin expects the `okf` CLI to be installed. Run it inside a wiki, provide the wiki root in your request, or set it once for your shell:

```sh
export OKF_ROOT=/path/to/wiki
```

The `english-lecturer` plugin runs automatically for Claude Code prompts after installation.
