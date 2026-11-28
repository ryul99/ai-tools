# You should know

Watches the session in the background and shows a short note above the
editor about something worth knowing — an important decision, a trap, or a
non-obvious fact. On by default.

## Commands

- `/you-should-know on|off|status` — turn it on/off, show status
- `/you-should-know more|fill|dismiss` — the same actions as the widget buttons

## Buttons

- Collapsed note: click `[ Open ]` to expand, or `[ Dismiss ]` to close
- Expanded note: click `[ Fill ]` to insert the note into the prompt box, or `[ Dismiss ]` to close

Mouse clicks work in Pi's fullscreen mode. In regular mode, use `/you-should-know more|fill|dismiss`.

`Fill` puts a quoted note (`> ` lines, marked `(side-agent note)`) into the
prompt box; everything you write below it is your own text. The box is never
overwritten while it has text.

## Config

- `YSN_PI_MODEL` — `provider/model-id` for the side model (default: the
  session model)

The note is session-scoped: it never persists, never repeats a line it
has already shown, and stays entirely out of your conversation on failure.
