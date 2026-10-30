# The menu's background reaches the end of a long page

Change: madarch-u3vw.6
Base: af58da3d3dd1ba4b7a2c7bd3a71a4cd49b94a835
Tasks: madarch-u3vw.6
Kind: no-behavior

## Intent
On a long page the left navigation's grey panel stopped part-way down: the rest of the column was bare paper under the menu, while the page kept scrolling. The navigation column was itself the sticky element at one window tall. The merge makes the column stretch with the shell and paint the whole height, and moves the list inside it into the sticky box, one window tall, so the list still stands in view as the reader scrolls.

`test/wiki-menu-height-e2e.test.ts` measures the panel against the document at 1150 and 1440 px in the light and dark themes, and checks that the list stays at the window top after a scroll. A second commit waits for the document page to render before measuring, because the menu draws before the document and a skeleton one window tall made a correct layout look short.

## Out of scope
- Changing the shell's layout, the width of the sidebar or the document column.
- Changing the sticky behaviour of the list beyond keeping it one window tall in view.
- Adding a new requirement; the shell already required a full-height sidebar and a fixed top bar.

## Rationale
This is a defect against the shell's existing full-height contract: the column was the sticky element, so it could not paint past one window even though the shell filled the page. Making the column stretch and keeping the list sticky restores the written behaviour at every window height without changing what the shell is. The second commit removes a timing race in the acceptance test rather than changing the layout again.

## Changes to requirements
None. The shell already required the sidebar and top bar to stay while only the document work area scrolls and the shell to fill the window at any height; this merge makes the long-page case match that requirement.

## Preserved contracts
- product-wiki/shell: the sidebar column stretches with the shell and paints the full page height, the list inside it stays one window tall and in view, and the top bar and document work area behave as before.

## Coverage
- product-wiki/shell: test

## Where it is seen

Kind: internal
Place: the left navigation of a served product wiki on a long page
Reason: the change restores the shell's already-written full-height behaviour; no new screen, command or message is added, and the browser assertion measures the existing panel.

1. Open a long document at 1150 px in the light theme, scroll to the end, and see the grey panel reach the bottom with the list still in view at the window top.
2. Repeat at 1440 px and in the dark theme; the panel reaches the end and the list keeps its place.

## Blocking questions
None.

## Design and decisions
The navigation column becomes a full-height background element that stretches with the shell; the list inside it is the sticky box, one window tall. The end-to-end fixture answers the document 1 200 ms late on purpose and the check waits for `[data-testid="document-page"][data-path="docs/long.md"]` before it measures, so the skeleton page cannot make correct layout look short.

## Acceptance evidence
- PR #196 (`a509cdaf`) changed `wiki/app/src/knowledge/app.tsx` and added `test/wiki-menu-height-e2e.test.ts`.
- `test/wiki-menu-height-e2e.test.ts` measures the panel against the document at 1150 and 1440 px in both themes and checks the list after a scroll.
