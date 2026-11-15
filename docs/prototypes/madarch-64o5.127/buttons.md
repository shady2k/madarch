# The kit's one button, icon button and toggle in their states

Mockup for madarch-64o5.127, drawn from the kit page `/p/kit` after the change: one height, one padding, one
type size, and the states a reader sees. The kit page is the drawing the owner reviews (decision 0020).

| Control | Default | Hover | Focus | Disabled |
| --- | --- | --- | --- | --- |
| Button | chrome ground (#f3f3f3 light, #1d1d1d dark), 1 px line border, 6 px radius, 14 px type, 36 px high, 12 px side padding | the hover ground `--surface-hover` | 2 px ink ring, 2 px offset on the page ground | the hover ground, muted words, and its reason in small muted words on the same line |
| Icon button | as the button, 36 × 36 px, no padding, an icon and a required accessible name | as the button | as the button | as the button, with the reason beside it |
| Toggle | as the button, unpressed | as the button | as the button | as the button, with the reason beside it |
| Toggle, pressed | the active ground `--surface-active` (#e7e9eb light, white at 11 % dark) with an ink border | — | as the button | as the button |

A choice group (the diagram's renderer switch, the settings page's language and reader role) is a row of
toggles with 6 px between them; the catalogue's «Выбрать/Выбран» and the problems page's filters are one
toggle each.

The walk that reads these numbers wrote the shots beside this record: `kit-buttons-1440-light.png`,
`kit-buttons-1440-dark.png`, `kit-buttons-390-light.png`, `kit-buttons-390-dark.png`, and one shot per
hover and focus example.
