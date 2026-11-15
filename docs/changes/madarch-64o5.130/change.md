# The kit holds one component per job, and the kit page shows each once

Change: madarch-64o5.130
Base: 1460a3b7dfeb14756a5cda0c017eab599b2837da
Tasks: madarch-64o5.130
Kind: no-behavior

## Intent
The owner said «Пересмотри наш UI Kit, такое обилие кнопок меня фрустрирует. Проверь все компоненты. Не должно быть
дублирующих.» The kit now offers one component per job: 43 files and 197 exports became 36 files and 169, and the kit
page shows every remaining component once, in its states. The audit of all 197 exports is its table below; the gateway
that keeps the count from growing again refuses, on any page, the raw constructs the kit already covers, and, inside the
kit, a name two files offer.

## Out of scope
- Choice menus: `Select` is replaced by `ChoiceMenu` in madarch-64o5.88's branch, and neither is touched here.
- `DateTimeField` and `LogViewer`, which the owner approved.
- The kit's one button, icon button and toggle and the disabled reasons: madarch-64o5.127 and madarch-64o5.123, whose
  branch this one starts from; their decision is carried, not revisited.
- A component that keeps its own job but has no caller in the product today (`Figure`, `Form`, `TableOfContents`,
  `SyntaxToken`, the drawing primitives): it is the kit's offer, not a duplicate.

## Rationale
The owner's words above are the reason. The kit had two numbered lists, two radio controls, two tab bars, two breadcrumb
sets, two panels for the same confirmation, three thin aliases of the button, two titles for a page's heading and a second
module for the interactive picture — each pair two names for one job. The audit below reads every export, the job it does
and how many pages call it; the merges moved the callers and deleted the second name. Nothing is aliased: a removed name
has no replacement under another name.

## Changes to requirements
None. The kit is the app's own layer under decision 0020; no requirement names a component, so the audit settles the
implementation the decision already asks for.

## Preserved contracts
- product-wiki/reading-typography: every page still reads in one component per construct on the kit's tokens, and the measure, radii and themes are unchanged: the kit walk and `bun test test/ui-architecture.test.ts`
- product-wiki/shell: the frame's sidebar, toolbar, role and language presses, phone menu, drawers and error screen keep their places and names, drawn by Button and IconButton instead of three aliases: `bun test src/components/frame-pages.test.tsx`
- product-wiki/internationalization: every section and state label the kit page shows is in English and Russian: `bun test src/i18n.test.ts`

## Coverage
- product-wiki/reading-typography: test
- product-wiki/shell: test
- product-wiki/internationalization: test

## Where it is seen
Kind: screen
Place: the kit page `/p/kit` at 1440 px and 390 px, in the light and the dark theme
Mockup: docs/prototypes/madarch-64o5.130/kit-1440-light.png
1. Open `/p/kit`: eighteen sections list the kit's components, each once — page and text, lists, panels and states, presses, forms, tables and filters, tabs, dialog, sheet, menus and tooltips, navigation, breadcrumb, search, contents, drawing, reading and shell.
2. Read the presses' states: the button, the icon button and the toggle each show default, hover, focus and disabled with its reason; the choice group shows pressed and disabled.
3. At 390 px read the same page: no element runs past the column, the shell example's sidebar takes its phone state, and the phone-only control appears.
4. In the dark theme the grounds, borders and text follow the tokens; the four mockups `kit-1440-light.png`, `kit-1440-dark.png`, `kit-390-light.png` and `kit-390-dark.png` stand beside this record.

## Blocking questions
None.

## Design and decisions
| Job | Kept | Removed (exports) | Callers moved |
| --- | --- | --- | --- |
| A numbered list | `typography.OrderedList` | `ordered-list.tsx` (OrderedList) | kit page |
| One radio | `radio-group.RadioGroupItem` | `radio-input.tsx` (RadioInput) | kit page |
| A binary on/off | `toggle.Toggle` | `switch.tsx` (Switch) | kit page, controls test |
| A trail above the title | `breadcrumb.Breadcrumb*`, `PageBreadcrumb` | `shell.ShellBreadcrumb`, `ShellBreadcrumbSeparator` | kit page |
| A page's tabs | `tabs.Tabs*` | `shell.ShellTabs`, `ShellTab`, `ShellTabTrigger`, `ShellTabClose` | kit page |
| A link that names a place | `typography.TextLink` | `shell.ShellIconLink` | kit page |
| A count beside a link | `Badge` + `TextLink` | `shell.ShellAnswersLink`, `ShellAnswersWords`, `ShellAnswersCount` | kit page |
| The toolbar's presses | `Button`, `IconButton` | `shell.ShellMenuButton`, `ShellRoleButton`, `ShellLanguageButton` | `frame.tsx` (3) |
| A labelled line of metadata | `typography.Metadata` + `InlineGroup` | `metadata-line.tsx` (MetadataLine) | kit page |
| A block of preformatted text | `typography.CodeFrame` + `Preformatted` | `technical-text.tsx` (TechnicalText) | kit page |
| An in-flow confirmation | `alert.Alert variant="problem"` | `confirmation-panel.tsx` (ConfirmationPanel) | kit page |
| A page's title | `typography.PageTitle` (`path` prop) | `typography.PageHeading` | `header.tsx` |
| A file page's title | `typography.PageTitle` | `typography.FileTitle` | kit page (no caller) |
| A clipped label | `navigation.NavigationLabel` | `typography.ClippedLabel` | kit page (no caller) |
| An interactive picture | `drawing.*` and the renderers' own pan/zoom | `graph.tsx` (GraphViewport, GraphCanvas, GraphBox, GraphMetadata, GraphEdges, GraphEdge, graphLinkClass) | kit page |

The count: 197 exports over 43 files less the 29 removed, plus `KitFrame` (the kit page's bounded frame for the shell
examples) over 36 files is 169.

Kept as different jobs, each in one place: `SegmentedChoice` is a short choice among words and `RadioGroup` with
`ChoiceCard` a choice whose options carry their own state; `TableColumns` (the group) with `TableColumn` (one column's
width); the link jobs — `TextLink` inline, `NavigationLink` in the sidebar, `SearchResultLink` in the answers, the
breadcrumb stop; `Card`, `Alert` and `DialogPreview` for a panel, a notice and an overlay preview; `BulletList`,
`OrderedList` and `PlainList` for the three lists a page reads.

The gate: `scripts/check/architecture/ui.ts` now refuses, on any page, every raw construct the kit covers — headings,
paragraphs, lists, links, code, quotes, figures, page regions and the controls it already refused (`raw-ui-element`) —
and, across the kit's own files, a name two of them export (`kit-duplicate-export`, `kitDuplicateExports`). What it cannot
tell: a second component for one job under another name (a switch beside a toggle, a confirmation panel beside an alert)
is a judgement about the job, not a name, so the table above is the review's record of it. The full-window error screen
became a region that fills its frame (`h-full`), so the app wraps it in the shell's own layout and the kit page can show
it bounded.

## Acceptance evidence
Static: `bun run check` passed (tsc, architecture, UI, catalog, workflows, quarantine); `cd wiki/app && bun run check`
passed (tsc and the UI gate: 0 violations, 0 listed); `bun run build` in `wiki/app` passed.
Test: `cd wiki/app && bun test` — 122 passed, 1 pre-existing failure (`src/compose.test.ts`, the same one at the base
commit 5b5aa649). `bun test test/ui-architecture.test.ts` — 15 passed, including the planted raw constructs and the
two-file duplicate.
Walk: the kit page opened in a real server and Chromium at 1440×900 and 390×844, light and dark, in English and Russian:
eight combinations, each with 18 sections, 62 state groups, no element past the column's width (`scrollWidth ===
clientWidth` at the document and the column) and no console or page error. The four mockups were read as images: 1440×9544
and 390×15303 pixels at light and dark, with the theme's ground at the corner (243/29 at 1440, 255/41 at 390).
The button walk of the previous branch also passes on this branch (3 cases, 430 assertions).
Mutation: not made; the stage's mutation run is at the milestone end.
Review: pending; this record is for the review.

## DONE WHEN
The kit offers one component per job — 169 exports over 36 files, every removed name gone with its callers moved and no
alias — the UI gate refuses a raw construct on a page and a name two kit files offer, and the kit page shows each
remaining component once in its states at 1440 and 390, light and dark.
