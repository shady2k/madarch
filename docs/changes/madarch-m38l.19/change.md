# The Problems page covers the whole product: deterministic findings in the code, in the documents and in the wiki

Change: madarch-m38l.19
Base: 1b55fdf3bde820b496c17133fd09601404b2833c
Tasks: madarch-m38l.19
Kind: behavior

## Intent
The Problems page shall show the product's defects, not only what the wiki can
see of its own pages. It shall list findings from the code, the documents and
the wiki in one place, each with a rule, a SonarQube kind and severity, a place
and entity link, one plain-language reason, an evidence path, and the actions
«Создать задачу» and «Не проблема». The code and document findings shall be
deterministic reads of facts the product already has; no agent shall run to
produce them. A product's kinds manifest shall be able to switch a rule off,
change its severity and set the thresholds. The page shall be reachable at
`/k/problems`, and an entity page shall carry the count of its open findings.

## Out of scope
- New extraction: the rules read the existing code graph, contract, environment,
  dependency and question files and the wiki's findings.
- An agent, model or network call to judge a finding.
- Rewriting the starter wiki templates or moving page data into the rendering
  layer; the parallel LiquidJS migration keeps that boundary.
- Editing current capability files, the vision or the milestone in this change;
  the proposed product-wiki capability is complete under `capabilities/`.
- Fixing a listed finding automatically. A person creates a task or records why
  the finding is not a problem.

## Changes to requirements
- product-wiki/problems (new at Base): one page at `/k/problems` with three
  sections, deterministic code and document rules, the wiki's existing findings,
  stable ids, Sonar kind and severity, place/entity/evidence links, plain-language
  reasons, problematic manifest settings, dismissal records and scoped tasks,
  and an entity-page badge. Scenarios:
  `three-sections-and-links`, `actions-keep-the-place`,
  `manifest-tunes-the-rules`, `entity-badge`, `no-silent-loss`.

Complete proposed capability: `capabilities/product-wiki.md`. Every accepted
requirement is retained verbatim from Base; no hand-written delta is stored.

## Rationale
The page already exists for the loop's own corrections and wiki findings. Its
`ProblemListing` carries only a kind, a reason and a target, so a reader cannot
see a dependency cycle, unparameterised SQL, a route outside the auth group, a
large file or change hotspot, a dead export, a debt-comment, a development
setting checked in, a dependency that is declared but unused or used but
undeclared, or a contract operation and route that do not meet. The questions
already record contradictions, stale grounds and gaps, and the wiki already
records broken grounds, unread files and manifest findings; they are not shown
together.

The facts needed for the code rules are already stored by the code, contract,
environment, dependency and history extractors. Reading them is deterministic,
has no model cost and no run-time agent. The rule set is data so a product can
tune it; the thresholds live beside the rules in the manifest. A stable id
(rule and identity, not a position) lets a dismissal survive a refresh and a
task be opened from the same finding. The Sonar taxonomy gives one vocabulary to
findings of every origin, and the severity lets a reader act first on the
security findings.

## Preserved contracts
- product-wiki/pages: the product's documents remain the wiki's pages; the Problems page is a separate loop page and does not become a document.
- product-wiki/questions-and-overview: questions remain the source of the document findings; the page reads them and does not rewrite them.
- product-wiki/serve: the local server still serves the app and its reads still do not change product files; the two new endpoints are additive.

## Coverage
- product-wiki/problems: test, static
- product-wiki/pages: test
- product-wiki/questions-and-overview: test
- product-wiki/serve: test

## Where it is seen

Kind: screen
Place: the Problems page at `/k/problems` and the Problems badge on an entity page
Mockup: docs/changes/madarch-m38l.19/problems-page-mockup.html

1. Open a product's Problems page and read the In the code, In the documents and In the wiki sections, each row's rule, Sonar kind, severity, place, entity, reason and evidence path.
2. Press «Не проблема» on a row, write why, and see the row leave the open list and the dismissed count change. Open the recorded file under the product's `docs/problems/`.
3. Press «Создать задачу» on another row and open the created task; its scope is the row's place and its record names the finding.
4. Open an entity page that is the place of open findings and follow its badge back to the Problems page.
5. In Russian, read the three section names, the kind and severity words, and both actions.

## Blocking questions
None.

## Design and decisions
- The rule catalogue is manifest data: the starter set writes every rule in full into `madarch/kinds.yaml` (`problems.rules`), and the engine keeps only the predicates a rule may name (`src/problems/rules.ts`). A rule declares its predicate, kind, Sonar kind, severity, section, action, labels and parameters; `problems.thresholds` carries `largeFileLines`, `hotspotLines`, `hotspotCommits` and `hotspotScore`. A rule the manifest does not declare is not run, and the listing says so.
- Code rules read one snapshot of the graph. A rule that throws is a note in the result, never a missing section; a listing never silently loses rows. Comment debt comes from the syntax tree's comment nodes, not a text search, and the markers read are the manifest's `params.marker` words.
- A problem's id is `rule + NUL + identity`. Code identities come from graph keys (file, symbol, operation, route, dependency, sink/build), document identities from the question target, and wiki identities from the page/file and the finding's key. A debt marker's identity is its file, its normalised comment text and its enclosing symbol, not its byte offset, so it survives a move and does not hide a different comment at the old offset.
- Auth coverage reads the contract's secured operations as well as a service's protected path roots, and a `public: true` operation is respected. A contract's operation carries the service its server authority resolves to, so every route of that service is judged against the contract. The entity badge counts open problems only.
- «Не проблема» is a file `docs/problems/<slug>.md` with front matter (`id`, `rule`, `kind`, `file`, `line`, `by`, `at`) and the reason; `docs/problems/` is loop data and is not extracted as documents. A malformed record is a finding.
- «Создать задачу» writes the madarch-m38l.14 task file directly with an empty question, the finding's scope and a provenance line naming the problem; it does not require an answered question and does not change the task format for answer-born tasks.
- The entity badge is counted on the server after the page transaction, only for the current page, so a historical page does not claim today's findings.
- The old `problems` response array and old wiki kinds remain; the new fields are additive. The Problems page renders the three section wrappers and keeps the old closed-problems wrapper.

## Acceptance evidence
- `bun run check` and `bun run views:check` at the repository root exit 0; so does `bun run check` in `wiki/app`.
- 102 focused root tests pass across the eight touched files (problems rules, manifest, dismissals, wiki listing, loop refresh, starter upgrade, code extraction, contract ownership); the knowledge suite passes 487 tests, the loop suite 72, and the wiki app 227.
- On the Base `4b620be1` the same seven changed test files fail: ten assertions in `extract-code-units` and `extract-contract-ownership`, and four load errors because `STARTER_PROBLEM_RULES`, `starterProblemSettings` and `openProblemsOf` do not exist; the tests are new behavior.
- `bun scripts/wiki-walk-ci.ts --baseline scripts/wiki-walk-baseline.json` prints `ratchet: raw-key 4810 → 4704 (−106) — below the baseline`. Before the `service` property label it printed `4810 → 4824 (+14) — above the baseline, so the walk fails`.
- Raw document-gate output is `out/gate-raw.txt`; the feature phase's only remaining refusal is the owner's approval and its digest.

## DONE WHEN
The Problems page has the three sections over the whole product. Each row shows
its rule and Sonar kind and severity, a place and entity link, one plain-language
reason and an evidence path. «Создать задачу» opens a task scoped to the place and
«Не проблема» keeps the reason as a file of the product. An entity page shows the
badge. Every rule is data the manifest can tune, with a test. The capability
`product-wiki/problems` is proposed complete, and the document gate leaves only
the missing owner approval.
