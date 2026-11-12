# Walk a served wiki

Build and serve the wiki first, then run from the repository root:

```sh
bun run wiki:shots --url http://127.0.0.1:4291/products/shop/ --out /tmp/wiki-walk
```

`--role` defaults to `everything` and saves the reader role on the served wiki.
`--out` must be outside the repository. The walk never starts a fill or agent.
The URL must be the product base, not a specific page.

The HTML index shows 1400px and 390px PNGs, URLs, settle times and
errors. The first image uses Puppeteer fullPage capture. For the fixed reader shell,
additional overlapping scroll tiles cover the content below the first viewport
without changing its layout. `shots[].tiles` lists these images in reading order. Red borders mark errors; the command exits nonzero if any occur.
`results.json` is machine-readable; `plan.json`, `status.json` and `catalog.json`
retain discovery evidence. Four isolated Chromium lanes avoid SSE connection
limits. Readiness scrolls deferred content and waits for finite requests, DOM
changes and diagram loaders, not permanent SSE connections.

Only catalogue kinds with `page: true` have kind routes; status includes all
declarations, even non-page members. Question and task entries use the canonical
route constants rather than retired bespoke paths. Non-page declarations remain in catalog.json but are not bogus page visits.
A file, term and commit use their normal entity routes, included by kind.

## Legacy script audit

Inventory after consolidation: one shared `walk-shots.ts`, thirteen historical
specialized `*-shots.ts` scripts, and the `graph-truth-shot-plan.ts` helper.
The duplicated static `overview-shots.ts` was removed.

The plain walk is the default for screenshots of an already served wiki. It
covers ordinary page navigation, a representative entity per kind, desktop and
phone captures, and optional catalogue Table/Graph navigation. It does not
replace interaction acceptance or exhaustive renderer measurements.

The table records why historical scripts are not equivalent to static page
captures. It is not a claim that they pass against the current API. In particular,
`loop-shots.ts` and `questions-once-shots.ts` target retired question/refresh
workflows and are unsupported historical acceptance, not runnable current gates.
Other fixture scripts may also depend on earlier product contracts. Use the
shared walk for current pages; do not run an old script merely to capture one
page or treat its presence as current acceptance evidence.

| Legacy script | Decision and reason |
| --- | --- |
| overview-shots.ts | Remove. Static overview navigation and screenshots duplicate the home visit. Its old Russian-only section/content assertions are task-specific, not an interaction suite. Diagram measurements remain in diagram-shots. |
| catalogue-shots.ts | Retain. Opens/dismisses the fill side panel; checks panel geometry, labels, input fit and nonblank pixels, in addition to static catalogue/dependencies shots. |
| contract-shots.ts | Retain. Opens lazy Definition disclosures, verifies no renderer loaded before opening, selected OpenAPI operations, paginated operation catalogue, external-request refusal and all three formats with exact-head provenance. |
| diagram-shots.ts | Retain. Selects diagram views/renderers and fullscreen states; strict label/overlap/clipping measurements and frozen exhaustive acceptance plan are not a plain page walk. |
| file-page-shots.ts | Retain. Source/rendered Markdown switching, soft wrap, History/Co-change tabs and invalid history date acceptance. |
| journal-shots.ts | Retain. Synthetic agent-call/refusal fixture and opened refusal details are not discovered by the generic representative-entity walk. |
| knowledge-shots.ts | Retain. First fill/progress, agent selection, fill panel, grounds navigation/switching, tabs, fresh reset, and graph-truth/rebuild acceptance. Broad, but not just a static page gallery. |
| loop-shots.ts | Historical, unsupported. Exercises the retired answer/refresh/rewrite workflow with a fake agent. Not a current page-capture command. |
| questions-once-shots.ts | Historical, unsupported. Retired questions-once workflow and reset evidence accounting; imported by loop-shots. |
| relations-shots.ts | Retain. Opens each relations renderer and measures rendered diagram geometry, including archify iframe content. |
| roles-shots.ts | Retain. First-open role card, skip/menu/help interactions, role-dependent text and ambiguous glossary terms. |
| settings-shots.ts | Retain. Fake ACP adapter settings plus destructive reset and assertions that manifests/templates survive while graph/pages disappear. |
| shell-shots.ts | Retain. Drag selection vs click, source/ground cards, tab deduplication and loaded titles. |
| wiki-shots.ts | Retain as specialized legacy mockup-fidelity acceptance. Side-by-side image composition, phone drawer and language menu/switching are not a normal page walk. Package default moves to walk-shots separately. |

Reference search found no references to the removed overview script.
The historical specialized scripts are not part of the default gate. `wiki:shots`
runs the shared walk; specialized fixture coverage needs separate validation
before it can be cited for the current API.
