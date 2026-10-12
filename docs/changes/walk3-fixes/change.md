# The walk-3 follow-ups: dark edge labels read, the repository's own model check passes, the describing skill's rules

Change: walk3-fixes
Base: a54ef309042127369eaeb08c7f63a10eeff4657e
Tasks: madarch-walk3-follow-ups-193f
Kind: no-behavior

## Intent
Three follow-ups of walk 3 (the coordinator's note
/tmp/madarch-run-iuc/note-walk3-fixes.md; the walk-3 report is
report-sdlc.md's "## Walk 3" section):

1. Dark theme, Mermaid view pages: the numbered arrow labels draw as
   small dark boxes and the numbers cannot be read. The page-ground chip
   keeps `var(--surface-page)` and its text now takes the theme's tokens
   (`wiki/app/src/styles/index.css`): `var(--text)` on the html label,
   `fill: var(--text)` on the renderer's own svg-mode label text. Light
   pairs are unchanged to the eye.
2. The repository's own model check refused the repository at its own
   committed revision (`bun scripts/check-model.ts .` exited 1 with
   `error: .:0: no assignment row covers README.md`, at `359f8d79` and at
   `1d1b45c2` alike — walk-3 finding 2). `madarch/review.md`'s Assignment
   table gains the README.md row; the check exits 0 again on this
   checkout.
3. Walk-3 finding 3: the describe-repository skill
   (skills/describe-repository/SKILL.md) states form-first the two
   refusals most often written on the documents it produces — a
   placeholder where a concrete value belongs (`unfinished-content`) and
   prose that names code (`system-part-in-requirement`); the next
   description passes the product's check the first time.

No requirement of any capability changes: the diagrams' contract already
says the diagrams follow the reader's colour scheme and that their
labels have numbers that read; the review table is the repository's own
model-check data; the skill text is the repository's own tooling prose.

## Out of scope
Findings 5 and 6 of the walk-3 report (filed as the deferred findings
madarch-zs4r and madarch-1t1a). Any renderer-side text change
(src/render/); the views themselves.

## Rationale
A dark page whose arrow numbers do not read fails the acceptance walk's
readability rule; a repository that its own check refuses cannot healthily
describe or be described; two round-trips of the product check per
description are paid only because the skill text leaves the two refusals
unwritten.

## Preserved contracts
- product-wiki/architecture: the diagrams still follow the reader's colour scheme and are drawn by the same client-side renderer; only the label text's colour source moves to the theme tokens.

## Coverage
- product-wiki/architecture: test

## Design and decisions
The chip's ground stays `var(--surface-page)` (both themes keep a quiet
page-coloured chip; the numbers read through `var(--text)`). The svg-mode
`fill` mirrors the same token so a renderer that labels without the html
exception reads in both themes too.
