# The frame and the search as before PR #299: the product switch, purposes, groups, tabs and the answers' own lines

Change: madarch-64o5.132
Base: dd6c44f53c5d07a6dff790adeebef801645db591
Tasks: madarch-64o5.132
Kind: behavior

## Intent
The audit of 2026-11-15 (`/tmp/audit-299-lost.md`) lists what a reader could do in the wiki before PR #299 and cannot
do now. This change rebuilds the losses of its sections 1 and 2 — the frame (sidebar, top bar, shell) and the search —
on today's layer: the graph's one navigation read, the bootstrap's roles, the page templates and the app's components.
No old page, module or route came back: every newly drawn thing comes from an answer the graph already holds or from
the navigation and the bootstrap, extended with the fields the frame needs.

The sidebar now lists the products the server serves (the one in front marked) and the «?» to madarch's own docs; the
kinds by the product's purposes when it declares them, filtered by the reader's role's audience, else by the manifest's
groups with the manifest's `open:` deciding which stand expanded, filled entries before empty ones, and the role's
leading groups first; a live fill's «+N» on the kinds it has still to write; and the filled and empty kinds alike.
The top bar's search takes the field on Ctrl+K (Cmd+K), closes on a press elsewhere, opens over the bar at a phone's
width, says when nothing matches or the search failed, and draws each answer as the entity's own name over the text of
the field the words were found in. Every page opens as a tab of the window: a plain press in the tab in front, a
control, command or middle press in a tab of its own; tabs name their pages, close to their neighbour, survive a reload
of the window and drive the address bar; the browser's title names the page beside the product. A section its template
does not open for the reader's role stands collapsed under its title. A catalogue being published, or one that could
not be, is said in the reader's words instead of a broken page.

## Rationale
The owner's task (madarch-64o5.132): the frame and the search as before PR #299, on today's template layer. The audit's
sections 1 and 2 mark seventeen capabilities lost or partly; thirteen are rebuilt here, three are rebuilt in part (one
from the server's run state rather than the removed writer's units, one without the home's facts that belong to section 3,
and one through the window's tabs and the document's own title), and one is left with the reason the table below names.

## Out of scope
- Sections 3 to 16 of the audit: every page's own blocks, the diagrams' views, the fill and run pages, the journal, the
  problems listing's second level, and the settings' verdicts and bounds.
- The reader-purpose *pages*: the sidebar's purposes are restored, not a page per purpose.
- A home whose facts are filtered by the role (audit item 33): the home is section 3's, not this task's.

## Changes to requirements
- product-wiki/frame: add. The frame reads the graph's navigation (products, purposes and audiences, groups and their
  `open`, the role's leads, the live fill's pending counts), its tabs, its search, the collapse of a section its
  template does not open for the role, and the catalogue's publication state.

## Preserved contracts
None.

## Coverage
- product-wiki/frame: static, test, review

## Where it is seen

Kind: screen
Place: a served product's wiki in Chromium at 1440x900 and 390x844, light and dark: the sidebar, the tabs' bar, the search's answers and the page
Mockup: docs/changes/madarch-64o5.132/frame-groups-1440-light.png

1. Open the wiki of a product the repository plugins filled (`frame-groups-*-*.png`, the manifest declaring groups and roles, the reader's role «developer»): the sidebar lists the groups the role leads first, the group the manifest opens expanded with its filled kinds and their counts, and the empty kinds and groups after the filled ones; the tabs' bar names the page, and the search draws its answers grouped by kind with each answer's name and matched text.
2. Open the same product with its manifest's `purposes:` declared (`frame-purposes-*-*.png`): the sidebar lists the purposes in the manifest's order, each with the filled kinds whose `audience:` admits the reader's role.
3. At 390 px the drawer holds the same navigation, the tab bar scrolls, and the search's field opens over the bar from its toggle.
4. Read every screen in both themes: headings 40 px on the desktop and 32 px on the phone, sidebar and top-bar words 12 to 14 px, no label cut, no element past the window's edge, and the two tabs never overlapping.

## Blocking questions
None.

## Design and decisions
The frame reads what the graph already answered plus three fields the frame needs and the GraphQL read now answers:
`NavigationKind.purpose` and `NavigationKind.audience` (the kind's section and the roles it is meant for) and
`Bootstrap.roleLeads` (each role's leading groups). `SearchHit.matched` carries the text of the field the words were
found in, so an answer shows its title over its excerpt without the app splitting the server's line. The schema,
`src/graphql/starter.graphql` and `test/graphql/fixture.golden.graphql` follow, and the executor test asserts the new
answers.

The app: `wiki/app/src/tabs.ts` is the window's tabs as one pure state (recall, remember, navigate, open, activate,
close, name, follow the window's own moves); the pages' bar is `components/page-tabs.tsx` over the kit's tab strip; the
app holds the tabs and the address bar with them. `components/frame.tsx` draws the product card and the help link from
`/api/products`, the purposes and groups from the navigation, the pending counts from the fill run's groups, and the
search in the top bar; `openPage` opens a page in the tab in front or in a tab of its own, and `follow` in
`components/relations.tsx` passes the control, command and middle press to it. `components/run-indicator.tsx` splits its
read (`useLiveRun`) from its drawing, so one read serves the indicator and the sidebar's counts. The publication state
is read from the server's 503 answer (`publication: pending|failed`), said in the reader's words and read again by the
frame; the connection's own calm line is left for a link that is really down. `page.tsx` draws a section its template
does not open for the role as a kit `Disclosure` under the section's title; `sectionOpenFor` in the page contract reads
the template's `roles.open`, and `sectionShownFor` now opens every section for the reader's «everything».

Two inconsistencies of the audit's section 1 are fixed on the way: the role menu's value is the manifest's «everything»
(not `all`), and a storage that refuses reads falls back to «everything» (not `all`).

Left, with the reason: the answers-waiting badge (audit item 7) counted questions a person answered and no refresh had
used, from the loop's own server state (`status.loop.questionsAnswered`); decision 0036 removed the questions loop state,
the graph holds no such count, and the app names no kind of one product to count its questions. The per-kind pending
counts (item 8) come from the live fill's run, which is the server's workflow state, not the graph: the audit's own
source and the frame's existing run indicator read the same. The home's role-filtered facts (item 18's second half) are
section 3's item 33.

Deliberate differences from the old code, which the change record names for the owner: a purpose section leaves out the
kinds whose `nav:` is `loop` (they stand in «Ждёт вас»), where the old sidebar could list them under a purpose; and a
template section with no title stays open, because a collapsed section needs a title to stand under.

## Acceptance evidence
Every item the audit marks lost or partly in its sections 1 and 2, each done or left:

| Item | State |
|---|---|
| 1 switch to another product of the products home | done: the product card lists `/api/products`, the one in front marked |
| 2 «?» to madarch's own docs | done: shown when the server serves the own wiki beside the product in front |
| 3 pages as tabs (close, middle click, tab titles) | done: plain, control/command and middle presses, close, titles, `sessionStorage` |
| 4 breadcrumb product › place | present before |
| 5 sidebar sections | present before |
| 6 «Ждёт вас» with its count | present before |
| 7 badge of answers waiting on questions | left: the count was the loop state decision 0036 removed; the graph holds none |
| 8 per kind «+N pages still being written» | done in part: from the live fill's run groups, one read for the top bar and the sidebar, where the old sidebar counted the writer's units |
| 9 sidebar sections by purpose, filtered by audience | done: `purpose` and `audience` of the navigation read |
| 10 the role's leading groups first | done: `roleLeads` of the bootstrap |
| 11 manifest `open: true` decides the expanded group | done |
| 12 empty kinds and groups after the filled ones | done: listed with count 0, after the filled entries |
| 13 documents and settings links | present before |
| 14 navigation drawer on a phone | present before |
| 15 language switch | present before |
| 16 role menu | present before; its «everything» value no longer says `all` |
| 17 role asked once on the first visit | present before |
| 18 the role changes pages: sections it does not open collapse; home facts filtered | done for the sections the template does not open for the role; the home's facts are item 33 |
| 19 loading skeleton | present before |
| 20 live updates | present before |
| 21 «Publishing the catalogue, please wait» | done: the server's publication answer, said and read again |
| 22 browser-tab title per page | done: the tab's name and the document's title name the page beside the product |
| 23 kit page | present before |
| 24 search grouped by kind, arrows, Enter, Escape | present before |
| 25 Ctrl+K / Cmd+K focuses the search | done |
| 26 a click outside closes the results | done, and the words stay in the field |
| 27 search toggle at phone width | done: the field opens over the bar; the toggle existed in the styles, unused |
| 28 «Nothing found» and error messages | done, in the reader's words |
| 29 each result shows its title plus an excerpt | done: the entity's name, and `SearchHit.matched` under it |

Checks: `bun run check` green (tsc; architecture 36 findings, all in the frozen list; UI 0; catalog 28 areas, 107
subgroups and 526 kinds; workflows 4; quarantine 0). The touched root suites: 107 cases in 10 files green
(`graphql-schema`, `graphql-schema-route`, `graphql-starter`, `graphql-executor`, `graphql-admission`,
`graphql-manifest-check`, `graphql-writes`, `page-contract`, `page-contract-command`, `server-templates`), plus
`catalog-read` 62, `draft-templates`/`wiki-templates-e2e`/`clean-install` 8 pass and 6 skipped (the wiki's browser walks
are opt-in) and `clean-install` 6; `owner-fill-path` passes under the interpreter the bundled plugins pin (bun 1.4.2)
and fails under this box's bun 1.4.4 with the plugin's `interpreter-pin` refusal, which is the box's interpreter, not
this change. The wiki app: `bun run check` green, `bun test` 147 cases in 27 files green (26 more than before), and
`bun run build` green.

The screens are the app built from this change, served by its own server on a product `madarch new` made with the
generated training repository and filled by its disk and git plugins alone (no agent), at 1440x900 and 390x844, light
and dark (`MADARCH_PLUGIN_SANDBOX=off`, bun 1.4.2): `frame-purposes-*.png` on the product as made, whose manifest
declares purposes, groups and roles, with the reader's role «developer»; `frame-groups-*.png` on the same store with its
manifest's `purposes:` and the kinds' `purpose:` lines taken out, read through a fresh start of the server on that store.
Filled counts read from the graph: 205 directories, 693 files, 2 repositories, 4 authors, 74 commits. Measured on the
eight screens: no element past the window's edge, no cut label, the two tabs no closer than their own edge, the document
as wide as the window, headings 40 px (desktop) and 32 px (phone), and the search's answers 1 254 characters of grouped
rows.
