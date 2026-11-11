# Walk a served wiki

Build and serve the wiki first, then run from the repository root:

```sh
bun run wiki:shots --url http://127.0.0.1:4291/products/shop/ --out /tmp/wiki-walk
```

`--role` defaults to `everything` and saves the reader role on the served wiki.
`--out` must be outside the repository. The walk never starts a fill or agent.
The URL must be the product base, not a specific page.

The HTML index shows full-page 1400px and 390px PNGs, URLs, settle times and
errors. Red borders mark errors; the command exits nonzero if any occur.
`results.json` is machine-readable; `plan.json`, `status.json` and `catalog.json`
retain discovery evidence. Four isolated Chromium lanes avoid SSE connection
limits. Readiness scrolls deferred content and waits for finite requests, DOM
changes and diagram loaders, not permanent SSE connections.

Only catalogue kinds with page policy, plus live status kinds, have kind routes;
non-page declarations remain in catalog.json but are not bogus page visits.
A file, term and commit use their normal entity routes, included by kind.

## Legacy script audit

Inventory: main has 14 tracked `scripts/*-shots.ts` files; the new
`walk-shots.ts` makes 15 in the working tree. No missing fifteenth legacy file.

The plain walk is the default for screenshots of an already served wiki. It
covers ordinary page navigation, a representative entity per kind, desktop and
phone captures, and optional catalogue Table/Graph navigation. It does not
replace interaction acceptance or exhaustive renderer measurements.

| Legacy script | Decision and reason |
| --- | --- |
| overview-shots.ts | Remove. Static overview navigation and screenshots duplicate the home visit. Its old Russian-only section/content assertions are task-specific, not an interaction suite. Diagram measurements remain in diagram-shots. |
| catalogue-shots.ts | Retain. Opens/dismisses the fill side panel; checks panel geometry, labels, input fit and nonblank pixels, in addition to static catalogue/dependencies shots. |
| contract-shots.ts | Retain. Opens lazy Definition disclosures, verifies no renderer loaded before opening, selected OpenAPI operations, paginated operation catalogue, external-request refusal and all three formats with exact-head provenance. |
| diagram-shots.ts | Retain. Selects diagram views/renderers and fullscreen states; strict label/overlap/clipping measurements and frozen exhaustive acceptance plan are not a plain page walk. |
| file-page-shots.ts | Retain. Source/rendered Markdown switching, soft wrap, History/Co-change tabs and invalid history date acceptance. |
| journal-shots.ts | Retain. Synthetic agent-call/refusal fixture and opened refusal details are not discovered by the generic representative-entity walk. |
| knowledge-shots.ts | Retain. First fill/progress, agent selection, fill panel, grounds navigation/switching, tabs, fresh reset, and graph-truth/rebuild acceptance. Broad, but not just a static page gallery. |
| loop-shots.ts | Retain. Answers questions, previews/runs refresh, checks closure after rewrite, and exercises repository edits/corrections with a fake agent. |
| questions-once-shots.ts | Retain. Focused questions-once, missing-document and reset acceptance with owned fixture/evidence accounting; delegated to by loop-shots. |
| relations-shots.ts | Retain. Opens each relations renderer and measures rendered diagram geometry, including archify iframe content. |
| roles-shots.ts | Retain. First-open role card, skip/menu/help interactions, role-dependent text and ambiguous glossary terms. |
| settings-shots.ts | Retain. Fake ACP adapter settings plus destructive reset and assertions that manifests/templates survive while graph/pages disappear. |
| shell-shots.ts | Retain. Drag selection vs click, source/ground cards, tab deduplication and loaded titles. |
| wiki-shots.ts | Retain as specialized legacy mockup-fidelity acceptance. Side-by-side image composition, phone drawer and language menu/switching are not a normal page walk. Package default moves to walk-shots separately. |

Reference search found no references to the removed overview script.
The specialized suites remain opt-in; `wiki:shots` now runs the shared walk.
