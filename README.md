# AI Tools

A small collection of plugins for Codex and Claude Code.

## Plugins

| Plugin | Codex | Claude Code | Description |
| --- | --- | --- | --- |
| `council` | Yes | Yes | Uses multiple model perspectives to evaluate and synthesize answers. |
| `okf-wiki` | Yes | Yes | Manages Open Knowledge Format wikis safely with the `okf` CLI. |
| `okf-wiki-autosave` | Yes | Yes | Optionally maintains shared OKF work documents after agent turns. |
| `english-lecturer` | Yes | Yes | Corrects English prompts and provides brief language feedback. |

## Installation

### Codex

```sh
codex plugin marketplace add ryul99/ai-tools
codex plugin add council@ryul99-ai-tools
codex plugin add okf-wiki@ryul99-ai-tools
codex plugin add okf-wiki-autosave@ryul99-ai-tools
codex plugin add english-lecturer@ryul99-ai-tools
```

Codex does not infer the autosave plugin's Claude-specific dependency metadata,
so install both `okf-wiki` and `okf-wiki-autosave`. After installing either
hook plugin, open `/hooks` in Codex and trust its hook definition before use.

### Claude Code

```sh
claude plugin marketplace add ryul99/ai-tools
claude plugin install council@ryul99-ai-tools
claude plugin install okf-wiki@ryul99-ai-tools
claude plugin install okf-wiki-autosave@ryul99-ai-tools
claude plugin install english-lecturer@ryul99-ai-tools
```

Install only the plugins you need. `okf-wiki` never installs a hook. Install
`okf-wiki-autosave` separately when automatic updates are wanted. In Claude
Code it declares `okf-wiki` as a dependency, so installing the autosave plugin
there is sufficient.

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

The autosave plugin journals meaningful work into dedicated worklog concepts
under the bundle-relative `worklog/` directory. It uses the active
subscription login for the host that runs it (`codex` from Codex and `claude`
from Claude Code), never writes outside the worklog directory, and never
creates session documents.

The `english-lecturer` plugin runs automatically for Codex and Claude Code
prompts after installation. Codex also requires the `/hooks` trust approval
described above. Set `ENGLISH_LECTURER_CLAUDE_MODEL` to override Claude's
default `haiku` model, or `ENGLISH_LECTURER_CODEX_MODEL` to override the current
Codex default model used for its feedback.
