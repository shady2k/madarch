# Keep the wiki's brand: a lowercase mark, a product link, no chevron

Change: madarch-64o5.122
Base: dd6c44f53c5d07a6dff790adeebef801645db591
Tasks: madarch-64o5.122
Kind: behavior

## Intent
The wiki keeps its brand: `madarch` is lowercase wherever the brand is written; the product block is a link to the
product's home and carries no chevron; its initial square uses the kit's sans font, about 36 px square. A control that
only navigates is a link.

## Rationale
Owner, 2026-11-15: «Смотри, опять нарушение бренд-бука.» The product block was a disclosure button with a chevron that
opened a one-product menu and navigated nowhere; its initial square was drawn in the serif face; the brand fallback and
the product description began with a capital `Madarch`.

## Out of scope
- The product's own name; it is the product's word, not the brand.
- A products-home switcher, which this single-product wiki does not offer.

## Changes to requirements
- product-wiki/brand-lockup: add. Lowercase `madarch`, a product block that is a link with no chevron, and an initial
  square in the kit's sans font.

## Preserved contracts
- product-wiki/shell: the sidebar's sections, counts and current-page mark keep their places; the product block keeps its place and shape (static test)
- product-wiki/internationalization: the brand word is lowercase in both locales (test)

## Coverage
- product-wiki/brand-lockup: static test mutation review
- product-wiki/shell: static test mutation review
- product-wiki/internationalization: static test

## Where it is seen
Kind: screen
Place: a served product's sidebar, on the home page and the preparation page
Mockup: docs/prototypes/brand-home.png

1. Open a product's home: the brand reads `madarch` in lowercase.
2. Read the product block: it has no chevron and is a link to the product's home; its initial square uses the kit's sans font.
3. Open the preparation page: the same brand and product block stand unchanged.

## Blocking questions
None.

## Design and decisions
`ProductLink` in the kit's navigation is an anchor with the product block's shape, no chevron, and `font-sans` on the
initial square. The frame renders it with the home link; the one-product dropdown and its unused menu are gone. The
brand fallback and the product description's opening word are lowercase in both locales.

## Acceptance evidence
Static: `bun run check` passed; the wiki app's `bun run check` passed.
Test: the app suite 122 passed, 0 failed; `app.test.tsx` 15 passed, including the brand test: the brand's strong word is
`madarch`, the product block is an anchor to `/`, it has no SVG, and its initial square names `font-sans`, not
`font-serif`.
Screens: `docs/changes/madarch-64o5.122/mockups/` holds the home and preparation pages at 1440 and 390, light and dark,
in English and Russian; the 390 shots open the phone drawer, where the product block stands at that width.
Mutation: not run, filed per the stage rule.
Review: pending; this record is for the review.

## DONE WHEN
The brand reads `madarch` in lowercase; the product block is a link with no chevron whose initial square uses the kit's
sans font; and a control that only navigates is a link.
