# Tips Korean

`tips-korean` is an extensible collection of tips for Korean users, the Korean
language, and Korea-related contexts. The host discovers each skill from its
metadata and loads its full guidance only when that skill is relevant, leaving
room for the plugin to grow without loading unrelated tips.

## Installation

### Codex

```sh
codex plugin add tips-korean@ryul99-ai-tools
```

### Claude Code

```sh
claude plugin install tips-korean@ryul99-ai-tools
```

## Included skills

- `korean-writing` helps produce Korean prose with complete sentences,
  explicit grammatical relationships, precise vocabulary, and limited use of
  ambiguous figurative expressions.
- The guidance does not apply to quotations or text that belongs to code,
  such as identifiers, comments, commit messages, and log strings.

## Acknowledgement

[snflkd/fluent-korean](https://github.com/snflkd/fluent-korean) provided the two output-style documents whose shared guidance was adapted for `korean-writing`.
