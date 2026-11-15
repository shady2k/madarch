# The kit's controls read, its charts take the owner's palette, and their words are the reader's

Change: madarch-64o5.82
Base: dd6c44f53c5d07a6dff790adeebef801645db591
Tasks: madarch-64o5.82
Kind: no-behavior

## Intent
The kit's control samples show an empty checkbox with a visible edge, three separated switches, one field label, an error alert with a solid problem edge and a progress bar that reads at width. The folded treemap remainder is the neutral surface, and its text uses the theme's own ink. The static and interactive calendars use the categorical palette and the reader's month and weekday names; the legend says «меньше / больше» in Russian. The kit's sample series, weekdays, dates and folded count come from the locales. A week that holds the first day of a month is named for that month, and a node without a value is named as missing, never counted as one.

## Out of scope
Changing a product page's controls or chart data; adding a new kit component; changing the categorical palette; changing the vendored layout's other displays.

## Rationale
The review of the kit shots found hard-to-read controls, English calendar and sample words on a Russian page, an October label over November's first day, an invented unit for a missing value, and white remainder text on the light theme. The fixes keep the kit on its tokens and the reader's language, and make a missing value explicit.

## Preserved contracts
- product-wiki/reading-typography: the kit's controls, states and figures remain on the shared design tokens, with visible focus and reduced-motion behaviour.
- product-wiki/app: the kit page is built by the app's own build; its figures take their words from the app's locales and Intl, and its lockfile resolves from the public registry.
- product-wiki/shell: the kit samples keep the shell's language, spacing and theme in light and dark.

## Coverage
- product-wiki/reading-typography: static test
- product-wiki/app: test mutation
- product-wiki/shell: static test review

## Where it is seen
Kind: screen
Place: `/p/kit` in the wiki app, in Russian
Mockup: docs/changes/madarch-64o5.82/kit-1440-light.png

1. Open `/p/kit` in light and dark at 1440 and 390 px.
2. Read the empty Checkbox, three separated Switches, one field label, the solid error alert and the wide Progress bar.
3. Read the folded treemap's neutral remainder and its readable theme-ink label; read the calendar's Russian months and «меньше / больше».
4. Read the sample series, weekdays, dates and «Свёрнуто: 35» in Russian.
5. Confirm November 1 is named November, and a node without a value is named rather than drawn as one.
