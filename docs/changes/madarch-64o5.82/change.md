# The kit's controls read, its charts take the owner's palette, and the lockfile uses the public registry

Change: madarch-64o5.82
Base: 2535d187abbbbd925ab3a3b38dc38bd7ac04e254
Tasks: madarch-64o5.82
Kind: no-behavior

## Intent
The kit's control samples now show an empty checkbox with a visible border, three switches that stand apart, one field label rather than a repeated «Name», an error alert with a solid problem edge, and a progress bar that reads at the sample's size. The folded treemap remainder uses the neutral surface outside the categorical palette; the static calendar uses the categorical palette; and at 390 px its weekday labels alternate so no two overlap. The app lockfile resolves packages from the public npm registry.

## Out of scope
Changing a product page's controls, chart data, or theme; adding a new kit component; changing the categorical palette itself.

## Rationale
The coordinator's look at the kit shots found controls that were hard to read and figures that fell outside the palette the owner chose, while CI could not resolve the app lockfile from a private mirror. The fixes are sample-level, token-level and registry-level; no product behaviour changes.

## Preserved contracts
- product-wiki/reading-typography: the kit's controls, states and figures remain on the shared design tokens, with visible focus and reduced-motion behaviour.
- product-wiki/app: the kit page is built by the app's own build, and its lockfile resolves from the public registry.
- product-wiki/shell: the kit samples keep the shell's language, spacing and theme in light and dark.

## Coverage
- product-wiki/reading-typography: static test
- product-wiki/app: static test mutation
- product-wiki/shell: static test review

## Where it is seen
Kind: screen
Place: `/p/kit` in the wiki app
Mockup: docs/changes/madarch-64o5.82/kit-light-1440.png

1. Open `/p/kit` in light and dark at 1440 and 390 px.
2. Read the empty Checkbox, the three separated Switches, the single field label, the solid error alert and the wide Progress bar.
3. Read the folded treemap's neutral remainder, the categorical static calendar, and the alternating weekday labels at 390 px.
