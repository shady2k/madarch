# The kit's own components, audited — madarch-64o5.82

Status: for the owner's decision. Nothing here is replaced; each row is a
recommendation, and a replacement waits for the owner's approval of this table.
The library the charts would come from is the owner's decision too — see
`docs/explorations/kit-charts-choice.md` (recommendation there: diagrammatic,
heat-graph, and shadcn/ui on Radix for primitives).

Scope: every file under `wiki/app/src/components/ui/` (46 files, 43 with
components, 3 tests) and every component outside that folder that draws
something (`wiki/app/src/components/*`, the diagram panes, the sections that
turn a query into a picture). Files that only read data (`format.ts`,
`connection.ts`, `types.ts`, `diagram-types.ts`, `diagram-links.ts`) are listed
at the end for completeness but have nothing to keep or replace.

How to read the table: **keep** means the component stays as it is; **replace**
means its behaviour or drawing should come from a library once the owner
approves; **rename/move** means the component stays but its file or folder is
wrong. Effort is one person's estimate: trivial (< half a day), low (a day),
medium (two to three days), high (more).

## 1. Components that duplicate shadcn/ui outright

These are shadcn/ui's own components, copied in by the CLI and re-themed from
the wiki's tokens (decision 0020). They are marked **duplicates shadcn/ui** and
the recommendation is to keep them as shadcn's: there is nothing of the kit in
them to re-audit, and re-copying them is shadcn's upgrade path.

| Component | What it does | Where used | Keep / replace | Replace with | Why | Risk / effort |
| --- | --- | --- | --- | --- | --- | --- |
| `alert.tsx` | Notice block, two variants (default, problem) | problems, diagram, kit page | Keep — duplicates shadcn/ui (Alert) | — | shadcn's own, themed by our tokens | None / trivial |
| `badge.tsx` | Small label; outline and solid variants | catalogue, facts, header, kit page | Keep — duplicates shadcn/ui (Badge) | — | shadcn's own | None / trivial |
| `breadcrumb.tsx` | Breadcrumb list (shadcn) plus `PageBreadcrumb`, an app composition over it | header, app, kit page | Keep the shadcn part; **move** `PageBreadcrumb` to `components/header.tsx` | — | A kit file holding an app-specific composition of a page trail is two responsibilities in one file | None / trivial |
| `button.tsx` | Button, three variants, five sizes | 11 files (shell, dialog, sheet, search, table, kit page…) | Keep — duplicates shadcn/ui (Button) | — | shadcn's own; the variants are ours, not extra components | None / trivial |
| `card.tsx` | Surface block with header/content/footer parts | kit page | Keep — duplicates shadcn/ui (Card) | — | shadcn's own | None / trivial |
| `dialog.tsx` | Modal dialog with focus management (Radix) | sheet, kit page | Keep — duplicates shadcn/ui (Dialog) | — | shadcn's own, Radix behaviour | None / trivial |
| `dropdown-menu.tsx` | Menu with radio items (Radix) | shell, frame, kit page | Keep — duplicates shadcn/ui (DropdownMenu) | — | shadcn's own | None / trivial |
| `input.tsx` | Text input | catalogue, search, table, frame, kit page | Keep — duplicates shadcn/ui (Input) | — | shadcn's own | None / trivial |
| `progress.tsx` | Determinate and indeterminate bar (Radix) | fact-chart, kit page | Keep — duplicates shadcn/ui (Progress) | — | shadcn's own; the only progress the app draws today | None / trivial |
| `radio-group.tsx` | Radio group (Radix) | kit page | Keep — duplicates shadcn/ui (RadioGroup) | — | shadcn's own | None / trivial |
| `sheet.tsx` | Side drawer (Radix dialog) | shell (phone navigation), frame | Keep — duplicates shadcn/ui (Sheet) | — | shadcn's own | None / trivial |
| `skeleton.tsx` | Pulsing placeholder bar | app, shell, kit page | Keep — duplicates shadcn/ui (Skeleton) | — | shadcn's own | None / trivial |
| `switch.tsx` | On/off switch (Radix) | kit page | Keep — duplicates shadcn/ui (Switch) | — | shadcn's own | None / trivial |
| `table.tsx` | Table parts, scroll container, plus our `layout`/`density` and `TableColumn` widths | catalogue, kinds, relations, the app's table section, fact-chart, kit page | Keep — duplicates shadcn/ui (Table) with our two props | — | The shadcn table is the accessible base; `layout`, `density` and column widths are additions, not a second component | None / trivial |
| `tabs.tsx` | Tab strip and panels (Radix) | diagram section, the app's tabs section, kit page | Keep — duplicates shadcn/ui (Tabs) | — | shadcn's own; Radix supplies roving focus | None / trivial |
| `textarea.tsx` | Multi-line input | kit page | Keep — duplicates shadcn/ui (Textarea) | — | shadcn's own | None / trivial |
| `toggle.tsx` | Pressed-state button (Radix) | kit page | Keep — duplicates shadcn/ui (Toggle) | — | shadcn's own; `ToggleGroup` is the missing sibling (see `segmented-choice`) | None / trivial |
| `tooltip.tsx` | Tooltip (Radix) | app, kit page | Keep — duplicates shadcn/ui (Tooltip) | — | shadcn's own | None / trivial |

## 2. Kit components made by madarch

| Component | What it does | Where used | Keep / replace | Replace with | Why | Risk / effort |
| --- | --- | --- | --- | --- | --- | --- |
| `fact-chart.tsx` | Draws a section's aggregate rows three ways — horizontal bars, a one-row treemap, a timeline — and repeats every value as a linked table row with a progress bar | `components/bars.tsx` (the `bars` section, which a product's home page may use), kit page | **Replace the drawing**, keep the table | diagrammatic `Bar`, `Treemap`, `Sparkline` | The three SVG marks are hand-computed in 38 lines (`viewBox` arithmetic, own scaling); a chart form draws them from data, with ticks, labels and the kit's tokens. The accessible table stays: it is what makes the figure readable without sight | Medium / medium |
| `graph.tsx` | SVG scene wrappers (`GraphCanvas`, `GraphBox`, `GraphEdge`, metadata, link class) for a hand-positioned diagram | Kit page only | **Retire** | — (pages' diagrams are server-rendered: LikeC4, Mermaid, archify) | Since decision 0036 nothing lays a diagram out in the browser; this is the leftover of the earlier approach and it draws a picture no page shows. If a small relationship figure is ever needed again, it comes from a chart form, not from a second layout model | Low / trivial |
| `drawing.tsx` | The renderer boundary: `svg`/`g`/`path`/`rect`/`text` wrappers, an iframe, a colour swatch | archify and mermaid panes, kit page | **Keep** | — | These are not a drawing library: they are the seam where a third-party renderer's output is placed. Replacing them means adopting that renderer's own React wrapper | None / trivial |
| `figure.tsx` | `figure`/`figcaption` wrappers | kit page | Keep | — | Semantic elements; nothing to gain from a library | None / trivial |
| `filter-bar.tsx` | Filter row, label field, pagination bar and summary, and the scroll-space trick below an edited filter | catalogue, relations, the app's search, the app's table section, kit page | **Keep** | — | Layout, not a widget: shadcn has no equivalent, and every part is a plain element around our own controls | None / trivial |
| `segmented-choice.tsx` | A labelled one-of-N choice drawn as buttons with `role="radio"` | Kit page only | **Replace** | shadcn `ToggleGroup` (Radix ToggleGroup) | It re-implements group selection, roving focus and `aria-checked` on buttons by hand, and no page uses it; `ToggleGroup` is the purpose-built primitive and already on our Radix set. Keep the visible label as a composition | Low / low |
| `search-results.tsx` | Non-modal result list with group titles and an active row | app's search (frame), kit page | **Replace** | shadcn `Command` (cmdk) | The keyboard semantics of a search list (arrow keys, `aria-activedescendant`, empty state) are exactly what `Command` ships; ours are the frame's own handlers. The product's search field and its result list would both become one composition | Medium / medium |
| `table-of-contents.tsx` | In-page contents list and the responsive one that opens in a panel, with scroll-tracking | kit page (a page's own contents are drawn by the template) | **Keep** | — | No shadcn equivalent; the behaviour is ours and tested by use | None / trivial |
| `navigation.tsx` | Product navigation: links, group triggers, subheadings, counts, pending marks, the product button, the brand | frame, kit page | **Keep**; watch shadcn's `sidebar` block | — | This is the product's navigation model, built on the shell's layout; shadcn's sidebar block is a different model (collapsible app sidebar) and would replace the frame, not a component | None / low |
| `shell.tsx` | The viewport shell: sidebar, toolbar, scroll panes, tabs, fixed chrome, plus the brand's `ShellBrandMark` SVG | app, frame, kit page | **Keep** | — | It is the layout contract of every page; no library offers this seam | None / trivial |
| `typography.tsx` | The reading vocabulary: headings, paragraphs, lists, definition list, metadata, code frame, contents sidebar, stack, links | 22 files — every section | Keep | — | These are our reading rules on our tokens; the reference implementations (prose classes) cover a fraction and would fight the accepted values | None / trivial |
| `inline-content.tsx` | `InlineCode` and `Strong` | commit, facts, kit page | Keep | — | Two semantic wrappers | None / trivial |
| `reading-content.tsx` | Blockquote and a compact reading container for tables and metadata | text section, kit page | Keep | — | Layout rules over rendered markdown | None / trivial |
| `ordered-list.tsx` | List wrapper that removes the browser's numbering for the reading sheet to number | kit page | Keep | — | One rule, one file; merging it into typography is optional tidying | None / trivial |
| `technical-text.tsx` | Preformatted, wrapped, small technical text | kit page | Keep | — | One rule | None / trivial |
| `disclosure.tsx` | `details`/`summary` wrappers | kit page | Keep | — | Native disclosure; a Radix accordion would add behaviour no page asks for | None / trivial |
| `confirmation-panel.tsx` | An in-flow confirmation group (not a modal) | kit page | Keep | — | Deliberately not a dialog; a library component would be the wrong shape | None / trivial |
| `metadata-line.tsx` | A labelled line of metadata | kit page | Keep | — | One layout rule; used by templates that are not yet written | None / trivial |
| `syntax-token.tsx` | A span carrying a highlighter's colour pair | kit page | Keep | — | The seam for the syntax highlighter's own colours; the colours are the highlighter's, not a second palette of ours | None / trivial |
| `choice-card.tsx` | A label drawn as a card, with the chosen state on the border | kit page (first-open and preference dialogs) | Keep the card, **replace** the radio inside | shadcn `RadioGroup` + `RadioGroupItem` | The card is layout and should stay; the native radio it wraps duplicates `RadioGroup`, which already carries the group's name and focus | Low / low |
| `radio-input.tsx` | A native radio input | choice cards | **Replace** | shadcn `RadioGroupItem` | Same reason: one radio implementation, and the kit already has the accessible one | Low / low |
| `checkbox.tsx` | A native checkbox input | kit page | **Replace** | shadcn `Checkbox` (Radix) | Ours is a bare `<input type="checkbox">` re-themed with `accent-color`: no indeterminate state, no consistent focus ring across browsers. shadcn's is the Radix primitive we already depend on | Low / low |
| `select.tsx` | A native `<select>` with an options prop | app's table section, kit page | **Replace** | shadcn `Select` (Radix) | A native select cannot be themed beyond the browser's own menu, and its option list does not take our tokens. The Radix select does; the API (`options`) can be kept as a thin wrapper | Low / medium |
| `table-columns.tsx` | A `<colgroup>` wrapper | kit page | **Fold into** `table.tsx` | — | `TableColumn` already exists there; a second file for the same element is a duplicate of a source of truth | None / trivial |
| `kit-preview.tsx` | The kit page's own scaffolding: page layout, section, state label | kit page | Keep | — | It is the review surface, not a component a page composes | None / trivial |

## 3. Components outside the kit that draw

| Component | What it does | Where used | Keep / replace | Replace with | Why | Risk / effort |
| --- | --- | --- | --- | --- | --- | --- |
| `bars.tsx` (`BarsSection`) | Reads a section's aggregate rows and draws them through `FactChart` (bar, treemap or timeline, per the template) | `page.tsx`, the `bars` section — the figure a product's home page shows | Keep the reading; **replace the drawing** with `FactChart`'s new forms | diagrammatic `Bar`/`Treemap`/`Sparkline` (through `FactChart`) | The section's job is to choose the metric and the labels; the picture is the chart form's. The accessible table under it stays | Low / medium |
| `diagram.tsx` (`DiagramSection`) | Shows the server's picture of an entity in three tabs: LikeC4, Mermaid, archify; a node press walks to its page | `page.tsx` (decision 0036 diagrams) | **Keep** | — | The layout and rendering are the server's; the tabs are the shadcn Tabs. Nothing here draws a chart | None / trivial |
| `diagram-panes/likec4-pane.tsx` | Binds LikeC4's runtime to the server's view and its link map | `diagram.tsx` | Keep | — | A third-party renderer binding | None / trivial |
| `diagram-panes/mermaid-pane.tsx` | Renders the server's Mermaid source with Mermaid's renderer, then swaps node labels for links | `diagram.tsx` | Keep | — | Same; the SVG wrappers come from `drawing.tsx` | None / trivial |
| `diagram-panes/archify-pane.tsx` | Places archify's self-contained HTML page in a frame | `diagram.tsx` | Keep | — | A vendored renderer's page, not our drawing | None / trivial |
| `table.tsx` (`TableSection`, app) | A section's table: columns, formats, links, filters, pagination | `page.tsx` | Keep | — | It composes the kit's Table, FilterBar and Select; a data grid (TanStack Table, shadcn DataTable) is the candidate if sorting and column choice are ever wanted — not asked for by any template today | Low if a DataTable is wanted later |
| `tabs.tsx` (`TabsSection`, app) | Draws a page's sections under their own tabs | `page.tsx` | Keep | — | It composes the shadcn Tabs | None / trivial |
| `facts.tsx` (`FactsSection`) | A section's labelled values, with commits and links | `page.tsx` | Keep | — | Composes kit parts; draws nothing of its own | None / trivial |
| `catalogue.tsx` (`CatalogueSection`) | The product's catalogue: kinds by area and subgroup, filterable, counts per kind | `page.tsx` | Keep | — | A filtered table over the kit; if the counts ever need a figure, `FactChart`/diagrammatic takes it | None / low |
| `kinds.tsx` (`KindsSection`) | Kinds of a group with counts and links, filterable | `page.tsx` | Keep | — | Same | None / low |
| `relations.tsx` (`RelationsSection`) | A page's incoming and outgoing relations, grouped by word | `page.tsx`, and the `follow` helper other sections use | Keep | — | Lists over the kit | None / trivial |
| `source.tsx` (`SourceSection`) | A source file's content or facts | `page.tsx` | Keep | — | Composes the kit; the code frame is `typography` | None / trivial |
| `commit.tsx` (`CommitLine`) | One commit: short hash, link, message, date, author | facts, relations, the app's table | Keep | — | Composes the kit | None / trivial |
| `header.tsx` (`HeaderSection`) | A page's title, kind badge and breadcrumb trail | `page.tsx` | Keep | — | Composes badge, breadcrumb, typography | None / trivial |
| `search.tsx` (`SearchSection`) | The product search: field and result list | frame, `page.tsx` | Keep the section; **the field and list change with** `search-results` → `Command` | shadcn `Command` (through the replaced `search-results`) | Same change as the kit component | Medium / medium |
| `text.tsx` (`TextSection`) | A section's rendered markdown | `page.tsx` | Keep | — | Reading content | None / trivial |
| `frame.tsx` | The app frame: toolbar, navigation, search, language and role controls, drawers | `app.tsx` | Keep | — | Composes the shell, sheet, dropdown and search components | None / trivial |
| `app.tsx`, `page.tsx`, `problems.tsx` | Routing and section dispatch; the problem page | app root | Keep | — | Not components of the kit; nothing drawn beyond what their sections draw | None / trivial |

## 4. Files with nothing to keep or replace

`components/connection.ts`, `components/format.ts`, `components/types.ts`,
`components/diagram-types.ts`, `components/diagram-links.ts`,
`components/ui/controls.test.tsx`, `components/ui/dialog.test.tsx`,
`components/ui/tabs.test.tsx` (tests), `wiki/app/src/address.ts`,
`client.ts`, `i18n.ts`, `stale.ts`, `main.tsx` — they read, format or test;
none draws.

## 5. What the audit adds up to

- **63 components audited:** 18 are shadcn/ui's own (all kept), 25 are
  madarch's kit, 20 are the app's own sections and panes.
- **Kept unchanged: 55** — 18 shadcn copies, 17 kit components, 20 app
  components (two of those keep their component and lose only the drawing they
  delegate).
- **Keep with a move: 2** — `PageBreadcrumb`, an app composition now inside the
  kit's breadcrumb, moves to `components/header.tsx`; `table-columns` folds into
  `table.tsx`, which already holds `TableColumn`.
- **Replaced: 7 files, each its own decision** — `checkbox`, `select`,
  `radio-input` (native inputs beside the Radix kit), `segmented-choice`
  (a hand-built radio group), `search-results` (hand-built keyboard
  navigation), `fact-chart` (its hand-drawn marks; the component and its
  accessible table stay), `graph` (dead: only the kit page draws it).
- **Through the chart library:** `bars`' drawing changes only because
  `fact-chart` does.

In order of what they buy:

1. `graph.tsx` is dead weight — retire it (trivial).
2. `checkbox.tsx`, `select.tsx`, `radio-input.tsx` are native inputs beside
   the Radix kit — replace with shadcn's Radix components (low, all
   accessibility: indeterminate state, themed menus, one radio implementation).
3. `segmented-choice.tsx` re-implements group selection — replace with
   `ToggleGroup` (low).
4. `search-results.tsx` hand-rolls the keyboard semantics of a result list —
   replace with `Command` (medium).
5. `fact-chart.tsx` hand-computes three figures — replace the drawing with the
   approved chart library, keep the accessible table (medium).

**Not audited here, on purpose:** the fill page's run progress arrives with
PR #307 and its component does not exist on this branch; the Files section's
repository treemap and history heatmap are stage 2, and their components will
be new (diagrammatic and heat-graph, per the choice note) rather than replaced.
