# Inline code inside a link draws one mark

Change: madarch-u3vw.13
Base: 45733961179846613381f9b9eb2fe2c9dbf676d1
Tasks: madarch-u3vw.13
Kind: no-behavior

## Intent
A link's mark is a border under its box. Inline code is a chip with padding and a grey ground, and the chip's ground
covers the middle of that border while the chip's left and right padding leave its two ends standing — two stray
dashes at the chip's bottom corners on a linked commit hash. A link that holds inline code now draws its line as a text
decoration instead: the link's line under its words, the chip's own line across its text over the chip's ground, and no
border left to show a segment under the padding alone. A plain link keeps its border underline, and unlinked inline code
keeps its chip.

## Out of scope
- The chip's ground, radius, padding and type.
- Link colour, hover surface and every other link mark.
- Code blocks, footnotes and every other use of inline code.

## Changes to requirements
None. The reading typography already requires links to be marked and inline code to read as code; this change makes a
link that holds one draw a single deliberate mark.

## Preserved contracts
- product-wiki/reading-typography: plain links keep their underline, unlinked inline code keeps its chip, and the
  reading rhythm and colours are unchanged.

## Coverage
- product-wiki/reading-typography: browser check, `test/wiki-inline-code-e2e.test.ts` — at 1150 and 390 px in light and
  dark, the linked code's computed text decoration is one underline in the muted underline colour, its link has no
  border, a mixed link is marked the same way, a plain link keeps its 1 px border, and unlinked code keeps its ground
  and no decoration.

## Where it is seen

Kind: internal
Place: a document page with a link whose text is inline code, at 1150 and 390 px in both themes
Reason: the change corrects a mark on an existing surface; no new screen, command or message is added.

1. Open a page whose linked commit hash is inline code and see one line under the code, with no dashes at the chip's
   corners.
2. Hover the link and see the link's surface as before.
3. Read a plain link with its underline and unlinked code with its chip.

## Blocking questions
None.

## Design and decisions
The mark moves to text decoration for links with a code child only (`main a:has(> code)`): the link's own text is
underlined and the `code` element underlines itself over its ground, while the border that left the dashes is removed.
The underline colour is the existing `--link-underline` token and the offset matches the app's other text underlines.
The check reads the computed styles in Chromium at both widths and both themes, and four pictures join the shots.

## Acceptance evidence
- `wiki/app/src/styles/index.css`: the two rules for a link holding inline code.
- `test/wiki-inline-code-e2e.test.ts`: the computed-style assertions in both themes and widths.
