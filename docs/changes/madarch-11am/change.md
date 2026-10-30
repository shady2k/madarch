# A first-visit role card sits above every diagram layer, so its last choice and its description stay readable and clickable

Change: madarch-11am
Base: c94462329cb670511326b6b7de1420d9a411984f
Tasks: madarch-11am
Kind: no-behavior

## Intent

On a product's home page, the first visit shows the role card over the page. The card's last choice,
«Everything», carries the sentence that tells a reader what that choice opens. In the training product the card was
painted under the LikeC4 navigation panel: the panel that names the diagram's context, at the diagram's top-left,
stood over the choice and its description. At 1150 px the panel covered the left part of the description; at 390 px
it covered the choice's centre too. The choice still worked where it was not covered, but the card read as a layer
that belonged to the diagram rather than to the page.

The cause was layering, not the card. The role card is a fixed overlay at `z-index: 50`. LikeC4's navigation panel is
absolutely positioned at `z-index: 200` inside the view's shadow root. A shadow root does not create a stacking
context, and the `.likec4-view` host did not either, so the panel's layer competed directly with the card in the root
context and won. The full-screen diagram frame had the same kind of reach at `z-index: 60`.

Every diagram renderer now forms its own stacking context, and every app dialog or popover sits on one modal layer
above both the diagram host and the full-screen frame. The card, its choices and the diagram are unchanged in
content, order, address and words; only the layer they paint in is fixed.

## Rationale

`no-behavior`: no requirement changes. `product-wiki/architecture` already requires the diagram to be drawn and its
navigation to work, and `product-wiki/shell` and `product-wiki/reading-typography` already require the app's own
surfaces and controls to read as the app's, on the shared tokens. Neither says that a diagram's internal layer may
paint over a dialog, and none asks for a new screen, route, string or choice. The defect was in how the existing
layers composed; the fix restores the composition the requirements describe and adds no capability text.

## Out of scope

- **LikeC4's own layer values.** Its panel stays at 200, its overlay at 2000 and its toast at 4000 inside the
  diagram. The change isolates the diagram instead of editing a vendor's stylesheet, and keeps those values working
  within the drawing.
- **The diagram's layout, content or interaction.** The panel still opens where it did, names the same context and
  navigates the same way; it simply cannot leave the diagram's stacking context.
- **A redesign of the role card.** Its five choices, their order, their words and the first-visit rule are unchanged.
- **Full-screen diagram controls.** The frame keeps its layer (`60`) and its exit behavior; app modals now sit above
  it, which is the same rule the card needed.

## Preserved contracts

- product-wiki/app: the wiki is still shown by madarch's own built app; the change edits that app's styles and class names, and the build and serve path is untouched.
- product-wiki/shell: the reading shell, its top bar, language menu and focus mode keep their places and behavior; the language menu and fill popovers take the one modal layer so a diagram cannot cover them either.
- product-wiki/reading-typography: the app still takes its values from the shared tokens; the new modal layer is one token, and no type, spacing, colour or surface value changes.
- product-wiki/architecture: each page still draws its view in LikeC4, Mermaid and archify, and the view's own navigation still works; isolating a renderer changes no diagram bytes and no view model.

## Coverage

- product-wiki/app: test
- product-wiki/shell: test
- product-wiki/reading-typography: test
- product-wiki/architecture: test

## Where it is seen

Kind: internal
Place: a product's home page on a first visit, with a diagram below it, read in Chromium at 1150x900 and 390x844
Reason: the change adds no screen, route, string or control: the card, its choices, the diagram and its context
  selector are the ones the requirements already place. It corrects which of those existing layers paints above
  which, so the record of what a person now sees is the browser regression and its two screenshots, not a new
  mockup.

1. Open the training product's home page for the first time and scroll the LikeC4 diagram toward the role card.
2. Read the card's last choice, «Everything»: the choice and its description are fully visible, and a click at the
   choice's centre and at its description reaches the choice, not the diagram; the context selector stays inside the
   diagram.
3. Choose «Everything»: the card closes and the home page is usable as before.

## Blocking questions

None.

## Design and decisions

**Isolate the renderer, then lift the app's modals.** Two changes answer the same mechanism from both sides:

- `.diagram-mermaid`, `.diagram-likec4`, the `likec4-view` custom element and `.dg-likec4-view` get
  `isolation: isolate`. Each becomes a stacking context in normal flow, so LikeC4's 200/2000/4000 layers and any
  other renderer's internal layers stay inside the drawing. The host still paints below the page's modal layer
  because its context sits at the auto/zero level.
- `--layer-modal: 10000` is the app's one modal layer, above LikeC4's highest internal layer (4000) and above the
  full-screen diagram frame (`60`). `.wiki-modal-layer` applies it to the role card, the Radix dialog overlay and
  content, the sheet overlay and drawer, the dropdown menu and the tooltip; `.language-menu` and the fill/sync
  popovers use the same token. The value is above LikeC4's numbers on purpose: if a renderer ever portals a toast or
  an overlay to the body, the app's dialogs still win.

Radix's popper wrapper needs its own rule. It writes `z-index: auto` inline and its transform makes the wrapper a
stacking context, so the content's layer cannot escape it. `[data-radix-popper-content-wrapper]` therefore takes the
modal layer with `!important`, which lifts dropdowns and tooltips as a whole.

**The regression measures the actual overlap, not a class name.** `test/wiki-dialog-stacking-e2e.test.ts` fills the
training product, opens the home page with the role card, finds the LikeC4 panel in the shadow root, scrolls it across
the last choice, and asks `document.elementFromPoint` at two points: the choice's centre and the left part of its
description. It asserts that at least the description point is covered by the panel, then that every sampled point
belongs to the choice. Before the fix the description point hit `.likec4-view` at 1150 px and the centre hit it at
390 px; after the fix both points hit the choice at both widths. The screenshots are
`out/shots-11am/role-dialog-1150.png` and `out/shots-11am/role-dialog-390.png`.

## Acceptance evidence

- **Red, before the fix:** `MADARCH_WIKI_E2E=1 bun test test/wiki-dialog-stacking-e2e.test.ts` — 2 fail. At 1150 px
  the description point returned `DIV.likec4-view dg-likec4-view`; at 390 px the centre returned the same host.
- **Green, after the fix:** the same command — 2 pass, 14 expect() calls, at 1150x900 and 390x844. Screenshots were
  written for both widths.
- **Repository and app gates:** `bun run check` (root) exit 0; `wiki/app` `bun run check` exit 0; `wiki/app`
  `bun test` 303 pass, 0 fail, 3,959 expect() calls across 18 files; `wiki/app` `bun run build` exit 0.
- **Environment note:** an attempt to run the older `test/wiki-chrome-e2e.test.ts` fill suite was stopped by the
  pod's OOM killer (exit 137) during its fill; the targeted stacking suite and the app's unit suite are the checks
  this change reads.

## DONE WHEN

On a first visit to the training product's home page at 1150 px and at 390 px, the role card is the topmost layer
over the LikeC4 diagram: its last choice and its description are fully visible and reachable, a context selector
stays inside the diagram, and every app dialog and popover shares that same modal layer above every diagram layer
and the full-screen frame. The browser regression fails on the unfixed tree and passes on the fixed tree.
