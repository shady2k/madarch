# The kit has one button, one icon button and one toggle, and every action uses them

Change: madarch-64o5.127
Base: 1460a3b7dfeb14756a5cda0c017eab599b2837da
Tasks: madarch-64o5.127
Kind: no-behavior

## Intent
The owner looked at `/p/settings` and the pages before it and asked why the buttons differ everywhere:
«И кнопки у нас везде разные. Почему? У нас единый ui kit? Все кнопки должны быть одинаковые.» The kit
now holds one button with one look, one height (36 px), one padding (12 px) and one type size (14 px), an
icon-only toolbar button of the same style, and a toggle for a choice; a page can pass none of the shape
props the kit dropped, and the gate refuses one that tries. Every call site moved at once: the four
variants, the five sizes and the seven class overrides are gone, as is the link-styled variant.

## Out of scope
- The wider architecture gates of madarch-64o5.121, which another worker builds in `scripts/check`: this
  change touches the button rules of `scripts/check/architecture/ui.ts` alone and says so here.
- The disabled-reason behaviour of the kit and of the catalogue and preparation pages: that is
  madarch-64o5.123, on the same branch, whose record names it.
- The kit page's other components: only the button section, the icon button and the toggle moved.

## Rationale
The owner's words above are the whole reason: one kit means one press, and a page that needs another shape
needs another kit control, not a button of another look. The old kit offered 4 variants and 5 sizes, and the
pages mixed them freely (variant default ×23, ghost ×6, outline ×2; size default ×28, icon-sm ×7, sm ×4,
icon ×3, content ×2), so no two pages agreed on what a press looks like. The link-styled variant went
because a link names a place and a button does something: a page that leads elsewhere uses `TextLink`.
Greenfield: every call site moved in this change and no old variant is kept.

## Changes to requirements
None. The design tokens requirement already binds the shell to the shared tokens, hover, focus and reduced
motion; this change makes the kit's presses obey it, and the record states the numbers the walk reads.

## Preserved contracts
- product-wiki/reading-typography: every press still takes its ground, border, radius, focus ring and type size from the shared tokens, and the reduced-motion rule still cancels its colour transition: `bun test test/ui-architecture.test.ts` and the browser walk
- product-wiki/shell: the top bar's fill entry, run indicator, refresh, role, language and phone-menu controls keep their places, accessible names and menus, now drawn by the kit's icon button and button: `bun test src/components/frame-pages.test.tsx` and the browser walk
- product-wiki/internationalization: every new word (the kit page's state labels and the button reasons) is in both English and Russian: `bun test src/i18n.test.ts` and `src/i18n-product-language.test.ts`

## Coverage
- product-wiki/reading-typography: test
- product-wiki/shell: test
- product-wiki/internationalization: test

## Where it is seen
Kind: screen
Place: the kit page `/p/kit` and every page of a served product, in the light and the dark theme, at 1440 px and 390 px
Mockup: docs/prototypes/madarch-64o5.127/buttons.md
1. Open `/p/kit`: the button, the icon button and the toggle stand in their states — default, hover, focus, and disabled with its reason — and the choice group is the toggle's own row.
2. Move the pointer over the hover examples and press Tab to the focus examples: the hover ground and the focus ring come from the tokens.
3. Open `/p/catalogue`, `/p/settings`, `/p/problems` and the other pages: every press is the same height and the same computed style.
4. Open any page at 390 px and in the dark theme: the same look, and the phone menu button stands in the top bar.

## Blocking questions
None.

## Design and decisions
One component, `Button`, with the kit's look as one class list and no `variant`, `size` or `className`
prop; `IconButton` for a square press in a toolbar, the same look, `size-9` and no padding, with its
accessible name required; `Toggle` for a choice, the same look with the pressed state on the active ground,
in Radix's toggle primitive. The reason of a disabled press was settled with madarch-64o5.123.

The component always renders a span holding the button (and the reason beside it when disabled), because a
reason must be the button's sibling to be an accessible description, and the span keeps the button's
element identity across an `online`/`offline` change. Radix's `asChild` triggers still work: the trigger's
props and ref land on the inner button, which is the interactive element.

The gate is a TypeScript AST rule in `scripts/check/architecture/ui.ts` (never a regex): a JSX element
resolved through its import to `Button`, `IconButton`, `Toggle`, `SegmentedChoice` or the shell's press
aliases may not carry `variant`, `size` or `className`, and a disabled one must carry `disabledReason`
(rule ids `button-variant` and `button-disabled-reason`). `test/ui-architecture.test.ts` plants each shape
prop and each disabled press and sees it refused, and sees the kit's own files exempt.

The kit page gained a button section that renders every state at both widths and both themes; the walk in
`test/wiki-buttons-e2e.test.ts` measures each press and writes the shots.

## Acceptance evidence
Static: `bun run check` passed (tsc, architecture, UI, catalog, workflows, quarantine); `cd wiki/app && bun
run check` passed (tsc and the UI gate: 0 violations, 0 listed); `bun run build` in `wiki/app` passed.
Test: `cd wiki/app && bun test` — 122 passed, 1 pre-existing failure (`src/compose.test.ts`, "the text
template composes on the type whose body it draws", which fails the same way on the base commit
5b5aa649: the starter schema's `Product` carries no `body` field). `bun test test/ui-architecture.test.ts`
— 13 passed, including the planted shape props and disabled presses.
Walk: `MADARCH_WIKI_E2E=1 bun test test/wiki-buttons-e2e.test.ts` over a starter product, a real server and
Chromium, walked `/`, `/p/catalogue`, `/p/catalogue?select=1`, `/p/glossary`, `/p/problems`, `/p/sources`,
`/p/runs`, `/p/settings`, `/p/kit`, `/p/search?text=code` and `/p/prepare?kinds=code.cycle,code.module` in
both themes, and read every visible press's box and computed style: one height (36 px), one type size
(14 px), one radius (6 px), one border (1 px solid), the words press padded 0/12/0/12 px and the icon press
36×36 px with no padding; the enabled ground is the chrome token and the pressed toggle the active token
(3 cases, 412 assertions, exit 0). The same walk run windowed under Xvfb
(`MADARCH_WIKI_HEADFUL=1 xvfb-run -a bun test …`) also asserts the hover state, which a headless browser
cannot match: `:hover` is true and the ground is `--surface-hover` (rgb(236, 238, 240) light, white at 7 %
dark) on the button, the icon button and the toggle, and the focus ring is the ink pair (rgb(46, 48, 52)
at 4 px light, rgb(229, 229, 229) dark) with `:focus-visible` true.
The kit states were shot at 1440 and 390 px, light and dark (`kit-buttons-*.png`, one shot per hover and
focus example) and read as pixels: every press's rendered ground equals its computed token colour in both
themes and both widths (36 crops, 0 mismatches), every press shows ink inside, every disabled press shows
the reason's ink beside it, and the dark ground differs from the light one's (243/29 for the button face).
Mutation: not made; the stage's mutation run is at the milestone end.
Review: pending; this record is for the review.

## DONE WHEN
The kit's Button takes no variant, size or className, an icon-only toolbar button and a toggle stand beside
it, every call site uses them, the UI gate refuses a planted variant and a disabled press without its
reason, and the kit page shows the three controls in their states at 1440 and 390 px, light and dark, with
a walk of every page reading one height and one computed style for every press.
