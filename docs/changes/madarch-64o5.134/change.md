# The entity page and documents after PR #299

Change: madarch-64o5.134
Base: dd6c44f53c5d07a6dff790adeebef801645db591
Tasks: madarch-64o5.134
Kind: behavior

## Intent

Answer what the audit (`/tmp/audit-299-lost.md`, sections 6 and 7) marks **lost** or **partly**, item by item. The
data every page shows comes from the graph through `/graphql`; no table, data file or text pointer was added.

## Changes to requirements

| Item | Where | How |
| --- | --- | --- |
| 56 trail of containers, each a link | `src/graph/graphql-read.ts` (`trail`), `components/ui/breadcrumb.tsx`, `components/header.tsx` | `Entity.trail` walks `partOf` outward and `contains` inward, outermost first; the breadcrumb draws every stop as a link |
| 58 picture at depth 2 | `catalog/templates/pages/entity.yaml`, `src/page-contract/schema.ts` | the base page asks depth 2; the template schema accepts 1 and 2 |
| 62 full screen, Escape to leave | `components/diagram.tsx`, `components/ui/dialog.tsx` | a kit Button opens the same figure in a window-sized dialog; Escape closes it |
| 65 a failed renderer falls back | `components/diagram.tsx` | a failed LikeC4 answer asks Mermaid for the same address and the page names the renderer that drew it |
| 67 more than 50 relation rows | `catalog/templates/pages/entity.yaml` | both relation sections take `$<id>_first`/`$<id>_after`; the existing pager reaches later rows |
| 69 typed field values for every kind | `src/graph/graphql-read.ts` (`details`), `src/graphql/schema.ts`, `components/details.tsx`, `entity.yaml` | `Entity.details` answers every declared field with its value and opinions; the Details block draws them |
| 70 mark on a contested field | same | each detail carries `contested`, drawn as the kit `disputed` badge |
| 71 provenance line in the header | `src/graph/graphql-read.ts` (`provenance`), `entity.yaml` | `Entity.provenance` states the place the newest opinion rests on; the header shows it |
| 72 page problems badge | — | left (see below) |
| 73 template findings listed on the page | `app.tsx`, `page.tsx` | a composition finding is listed above the page's sections; the page is not replaced |
| 79 a document's body as Markdown | `catalog/templates/pages/text.yaml`, `document.yaml` | the text template binds the kinds whose body field is `body`; `document` binds `practice.document` and reads `markdown` |
| 83 external links in a new tab | `components/text.tsx` | the Markdown renderer opens an `http(s)` link in a new tab and drops raw HTML |
| 84 document header | `document.yaml` | path, repository and folder trail, and the provenance line |

## Out of scope

Left for the owner, each with its reason:

| Item | Reason |
| --- | --- |
| 59 «+» expands a node's neighbours in place | the picture is rendered by the server once per address; expanding in place needs a second render request and a node-level state in three panes — a change of its own |
| 60 turning a relation's boxes on and off | same: per-relation visibility belongs to the renderer, not to a component that only shows its answer |
| 64 Shift/Ctrl opens a new tab | the frame has no wiki tabs since 0036 (section 1 lost them too); the only honest form is `window.open` inside the LikeC4 runtime, which the runtime's own click handler owns |
| 68 each relation row's source and reason | the row names its relation, its edge kind and its direction today; its stating producer needs the edge opinion of each row, a per-row read that does not exist yet |
| 74 «this key is also in N other repositories» | needs a graph read across repositories for one key, which no root answers today |
| 75 link to the agent's journal for this page | `/api/journal` answers, but the page read carries no journal identity to name |
| 76 «planned change» badges | the loop's pending pages are not part of today's page read; the badge would state a plan the page cannot read |
| 77 a member's address opens its parent's page at its anchor | needs a redirect the router does not have and member addresses the catalogue does not declare |
| 80 glossary terms linked in text | needs the terms in the page's one read; the text section reads its body alone |
| 81 Mermaid fences drawn with a Diagram/Source switch | a second renderer inside the reading column; a change of its own |
| 82 `madarch:` links resolved | no address resolver answers a graph key today; a resolver field is a new read, not a page change |
| 83 relative links between documents | resolves through the same missing resolver |
| 85–87 statements: clickable sentences, statement view, original sentence | statements are JSON in a document's body, and no statement page exists on today's layer; a statement address is a read of its own |

## Acceptance evidence

1. A reader opens any entity's page and sees its Details block: every declared field, the value its producers agreed, the `disputed` mark on a contested one, and under each value the producer and the place it rests on.
  Kind: command
  Place: `bun test test/graphql-executor.test.ts` (details, trail, provenance cases)
2. A reader walks the page's trail: every container is a link into its own page.
  Kind: command
  Place: `wiki/app` — `bun test src/page.test.tsx` (breadcrumb case)
3. A failed LikeC4 picture is drawn by Mermaid, and the page names the renderer that drew it; the same figure fills the window and Escape leaves it.
  Kind: command
  Place: `wiki/app` — `bun test src/components/diagram.test.tsx`
4. A template's findings are listed above a page that still stands.
  Kind: command
  Place: `wiki/app` — `bun test src/page.test.tsx` (template finding case)
5. A document opens with its Markdown body under a header with its path, its folders and its repository.
  Kind: command
  Place: `bun scripts/check-catalog.ts` (template everything: 83 kinds, no finding), `bun test test/page-contract.test.ts`
6. Item 72 (a page's own problem badge) is left: the problems listing answers product-wide counts only.
  Kind: internal
  Reason: it needs a per-entity filter the problems read does not answer.
