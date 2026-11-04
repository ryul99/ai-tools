---
name: ui-principles
description: Principles for designing, building, and reviewing user interfaces of any kind, including applications, web pages, dashboards, HTML reports, and slide decks. Always load this skill when creating, changing, or reviewing something people will look at or interact with.
---

# UI Principles

These principles apply to every kind of interface, from applications and dashboards to HTML reports and slide decks. They describe judgment rather than fixed values, so apply them with their purpose in mind instead of checking them off mechanically. When a project has its own design system or the request states a preference, that takes precedence.

## Start from the audience and their task

Before choosing any visual, decide who will see this, what they need to do or take away, and how they will use it: worked in every day, read once, or presented to a room. Tone and density follow from that answer. Something people work in should feel quiet and familiar; something seen once can afford one expressive choice.

- An internal dashboard opens on the numbers people check every day, not on a welcome banner.
- A report written for executives leads with the conclusion; one written for analysts can lead with the method.

## Follow what already exists

Read the existing design system, components, and neighboring pages first, and match them. Within one artifact, the same thing always looks the same and has the same name. Introduce something new only when nothing existing fits.

- If every other table in the report right-aligns numbers, the new table does too.
- A deck that uses one color for risk uses that color for nothing else.

## Build what was asked

Do not add features, sections, slides, or decoration that the request did not call for. If something important seems to be missing, mention it rather than adding it. Handling the states and edge cases of what was asked is part of the request, not an addition.

- "Add a filter to this table" does not include restyling the table header.

## Give each view one job

Every screen, section, or slide has one main purpose and one element that draws the eye first. Emphasis only works by contrast: when everything is bold, colored, or large, nothing stands out.

- A slide states one point and shows the one chart that supports it, rather than four charts of equal weight.

## Let the structure explain itself

Headings, labels, layout, and familiar conventions should make an interface understandable without instructions. Do not add visible text that describes the interface itself, its features, or how to use it. A person who reads only the headings, labels, and numbers should understand what they are looking at. This is not a reason to remove labels: still name unfamiliar icons, and still explain errors and empty states.

- Title a section "Weekly revenue by region" instead of adding a caption that says "This section shows weekly revenue by region."
- Make tabs look and behave like tabs instead of writing "Click a tab above to switch views."
- In a report or deck, a heading that states the finding, such as "Signups dropped after the pricing change", says more than "Signup analysis".

## Treat words as part of the design

Use the audience's vocabulary, not the system's internals. Name an action by what it does, and keep the same name for the same thing everywhere. Prefer plain, specific wording over clever or promotional wording.

- "Manage notifications", not "Configure webhooks".
- A button that says "Publish" leads to a message that says "Published", not "Success".
- Interface text reads like a label, not like an advertisement.

## Remove what does not carry meaning

Every border, card, shadow, icon, color, and animation should help someone understand or act. If removing an element loses nothing, remove it. Motion belongs only where it gives feedback, shows where something came from or went, or makes a change easier to follow; actions people repeat often should not animate.

- A list of settings does not need each row wrapped in its own card.
- Slides do not need a transition effect between every slide.

## Show real content and never invent it

Design with the actual text, data, and lengths. Do not invent statistics, quotes, logos, or names to fill space; use a clearly marked placeholder instead. Check that the design still works with long text, missing values, many items, and no items at all.

- A chart with a missing month shows the gap instead of drawing a line that hides it.
- An empty list says what will appear there and how to add the first item.

## Make it usable by everyone

Text stays readable against its background. Meaning never depends on color alone. Structure is real: headings are headings, buttons are buttons, and tables are tables. Anything interactive works with a keyboard and shows where focus is, and motion respects a reduced-motion preference.

- A line chart labels each line directly instead of relying on a red and green legend.

## Treat first instincts as defaults

For choices the project has not already made, ask whether you would have produced the same result for any similar request. If so, it is a default rather than a decision. Avoiding a familiar default is not enough on its own: replace it with a choice that has a reason rooted in the audience and the subject.

- If the same layout would work unchanged for a recipe site and a security dashboard, it was not designed for either.

## Judge the rendered result

Look at the output the way its audience will: on the screen sizes, devices, media, and color modes where it will actually be used. Fix what you see, not what you expected the code to produce, and look again after each round of changes.

- A report that will be opened on phones is checked at phone width.
- A deck is checked in presentation view, not only in the editor.
- A page that may be printed or exported to PDF is checked in that form.
