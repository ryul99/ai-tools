# AI Tools

A small collection of plugins for Codex and Claude Code.

> This repository is vibe-coded: most of its code and docs are written by AI
> coding agents under human direction.

## Plugins

| Plugin | Codex | Claude Code | Description |
| --- | --- | --- | --- |
| `council` | Yes | Yes | Uses multiple model perspectives to evaluate and synthesize answers. |
| `okf-wiki` | Yes | Yes | Manages Open Knowledge Format wikis safely with the `okf` CLI. |
| `okf-wiki-autosave` | Yes | Yes | Optionally maintains shared OKF work documents after agent turns. |
| `okf-wiki-handoff` | Yes | Yes | Keeps a per-session OKF handoff note current and shows it again after context compaction. |
| `english-lecturer` | Yes | Yes | Corrects English prompts and provides brief language feedback. |
| `english-lecturer-mod` | No | Yes (mod) | Experimental mod version of `english-lecturer`. |
| `okf-wiki-autosave-mod` | No | Yes (mod) | Experimental mod version of `okf-wiki-autosave`. |
| `okf-wiki-handoff-mod` | No | Yes (mod) | Experimental mod with Codex-style context management around an OKF handoff note. |
| `tips-korean` | Yes | Yes | Provides lazily loaded tips for Korean users, the Korean language, and Korea-related contexts. |
| `tips-engineering` | Yes | Yes | Provides lazily loaded tips for software engineering workflows. |

## Installation

### Codex

```sh
codex plugin marketplace add ryul99/ai-tools
codex plugin add council@ryul99-ai-tools
codex plugin add okf-wiki@ryul99-ai-tools
codex plugin add okf-wiki-autosave@ryul99-ai-tools
codex plugin add okf-wiki-handoff@ryul99-ai-tools
codex plugin add english-lecturer@ryul99-ai-tools
codex plugin add tips-korean@ryul99-ai-tools
codex plugin add tips-engineering@ryul99-ai-tools
```

Codex does not infer the Claude-specific dependency metadata of the autosave
and handoff plugins, so install `okf-wiki` alongside them. After installing a
hook plugin, open `/hooks` in Codex and trust its hook definition before use.

### Claude Code

```sh
claude plugin marketplace add ryul99/ai-tools
claude plugin install council@ryul99-ai-tools
claude plugin install okf-wiki@ryul99-ai-tools
claude plugin install okf-wiki-autosave@ryul99-ai-tools
claude plugin install okf-wiki-handoff@ryul99-ai-tools
claude plugin install english-lecturer@ryul99-ai-tools
claude plugin install tips-korean@ryul99-ai-tools
claude plugin install tips-engineering@ryul99-ai-tools
```

The mod versions are optional replacements for the two hook plugins:

```sh
claude plugin install english-lecturer-mod@ryul99-ai-tools
claude plugin install okf-wiki-autosave-mod@ryul99-ai-tools
```

The handoff mod is an alternative to `okf-wiki-handoff`, not a replacement for
it. Where the hook plugin keeps a note current and shows it next to the CLI's
compaction summary, the mod follows Codex's experimental context management:
it reminds the model before the context runs out and lets it start a fresh
context window that holds only the note, and it replaces compactions with the
note too; see the [hook plugin README](plugins/okf-wiki-handoff/README.md)
and the [mod README](plugins/okf-wiki-handoff-mod/README.md). Install only one
of the two:

```sh
claude plugin install okf-wiki-handoff-mod@ryul99-ai-tools
```

The hook plugins `english-lecturer`, `okf-wiki-autosave`, and
`okf-wiki-handoff` run their TypeScript with Node.js 22.18 or newer. Each one
shares its core with its mod version: the mod's `hooks/core` links to the hook
plugin's `lib/core/`, so a change there ships in both and bumps both versions.

Install only the plugins you need. `okf-wiki` never installs a hook. Install
`okf-wiki-autosave` separately when automatic updates are wanted. In Claude
Code it declares `okf-wiki` as a dependency, so installing the autosave plugin
there is sufficient.

## Usage

Ask Codex or Claude Code to use an installed skill, for example:

```text
Use the council to evaluate this proposal.
Find related concepts in my OKF wiki.
Write this explanation in clear Korean.
Investigate related GitHub issues and pull requests.
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
