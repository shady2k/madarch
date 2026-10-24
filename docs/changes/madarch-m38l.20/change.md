# The extracted graph holds only repository evidence and follows the relationships the code declares

Change: madarch-m38l.20
Base: e8e971b852f410cf131b9eaf55fa774cd3d319ae
Tasks: madarch-m38l.20
Kind: behavior

## Intent
A reader following the generated training product from a route, field, file,
channel, metric or logger should find the code and configuration that give it
meaning. The graph must not invent a database merely because a service has
source files. Correct, evidenced relationships matter more than making every
page appear connected. This proposal implements all nine extraction areas of
the task and an exhaustive before/after audit; it does not change page layout.

## Rationale
This is a behavior change because the facts and relationships a person reads
in the knowledge wiki change. The complete proposed capability is
`capabilities/product-wiki.md`: the accepted capability at the pinned `Base:`
plus the extraction requirements listed below. Current specifications stay
unchanged until acceptance and closure. The baseline is `origin/main` at
`e8e971b852f410cf131b9eaf55fa774cd3d319ae`, fetched before this proposal.

The task's owner walk reports an unsupported database, route-to-file links,
isolated symbols and files, missing external imports, broker relationships,
individual metric definitions and logger uses. Those reported counts are
observations from that walk, not a measurement made by this worker. The
committed training audit will measure the baseline and changed code against
the same generated fixture after approval; no before/after result is claimed
yet.

The coordinator's read-only Codex advice is incorporated: a function passed
as a value is a **reference relation**, not a call. Callback registrations and
handler maps retain that distinction even if a later chain follows them.

## Out of scope
- Agent checks, Jev validation and real agent runs. Fill acceptance uses only the scripted ACP test agent.
- Page layout, diagrams, block wording and template changes owned by madarch-m38l.15 and madarch-m38l.21; questions and writer changes owned by madarch-m38l.22.
- SQL-injection findings owned by madarch-m38l.19. Preserve the existing input-to-builder-to-unsafe-sink flow chain.
- New graph storage, a new extraction architecture, runtime instrumentation, arbitrary-language support or guesses about code the supported deterministic extractors cannot resolve.
- Outside repositories, owner infrastructure and product data retained in the engine.

## Changes to requirements
- product-wiki/extraction-evidence (new): nodes require positive evidence; service source alone creates no database; unresolved or unreadable inputs are explicit.
- product-wiki/extraction-route-chain (new): routes reach handler symbols, service-scoped operations and the handler's remote calls, traversable in both directions.
- product-wiki/extraction-probes (new): separate Kubernetes readiness, liveness and startup probes and compose healthchecks retain their own settings and resolvable route links.
- product-wiki/extraction-symbol-relations (new): member ownership, type uses, field/property/constant reads and writes, constructors and callback references retain their distinct semantics.
- product-wiki/extraction-file-declarations (new): files reach every supported declaration using its owning identity.
- product-wiki/extraction-package-imports (new): internal, external and standard-library imports are represented with declared versions where available.
- product-wiki/extraction-messaging (new): grounded broker instances reach channels, services and address settings; publisher and consumer functions are identified; no consumer found in the product is explicit.
- product-wiki/extraction-metrics (new): individual counters, gauges and histograms retain their type, labels, definition, update functions and exposing endpoint.
- product-wiki/extraction-logger-users (new): loggers reach their actual using files and functions, not just their declaration file.
- product-wiki/extraction-training-audit (new): an exhaustive generated-fixture audit prints per-kind totals, no-edge and no-evidence counts before and after, and named regressions check semantics.

Complete proposed capability text: `capabilities/product-wiki.md`. It is the
full baseline capability plus these requirements, not a hand-written delta.

## Preserved contracts
- product-wiki/pages: the product repository remains the source of page content; no product content moves into the engine.
- product-wiki/internationalization: the wiki supports English and Russian; any new reader-facing messages are supplied in both languages, without translating source identifiers.
- product-wiki/serve: existing wiki and JSON API routes retain their addresses.

## Coverage
- product-wiki/extraction-evidence: test, generated-training-repository-audit
- product-wiki/extraction-route-chain: test, generated-training-repository-audit, browser-walk
- product-wiki/extraction-probes: test, generated-training-repository-audit, browser-walk
- product-wiki/extraction-symbol-relations: test, generated-training-repository-audit, browser-walk
- product-wiki/extraction-file-declarations: test, generated-training-repository-audit, browser-walk
- product-wiki/extraction-package-imports: test, generated-training-repository-audit, browser-walk
- product-wiki/extraction-messaging: test, generated-training-repository-audit, browser-walk
- product-wiki/extraction-metrics: test, generated-training-repository-audit, browser-walk
- product-wiki/extraction-logger-users: test, generated-training-repository-audit, browser-walk
- product-wiki/extraction-training-audit: test, generated-training-repository-audit
- product-wiki/pages: test
- product-wiki/internationalization: test, browser-walk
- product-wiki/serve: test

## Where it is seen

Kind: screen
Place: the generated training product's knowledge wiki, on route, operation, health, symbol, file, package, broker, channel, metric and logger pages
Mockup: docs/prototypes/madarch-m38l.9/function-pay-1150-light.png

1. A reader opens a route, follows its handler and contract operation, and follows the handler's remote call to its target.
2. The reader opens a health operation and finds its serving route and every configured probe with its own port and timing.
3. They follow a type to a member, its reads, writes and type uses; constructor calls and callback references remain distinguishable.
4. They open files of each supported format and follow declared entities, and follow imports to internal modules, standard-library packages or declared dependency versions.
5. They follow a channel to its broker, address settings and publishing or consuming function, a metric to its definition and updating function, and a logger to the code using it.
6. The training service without positive storage evidence has no invented database page. Existing page components render the new relations; layout and template corrections are coordinated separately.

## Blocking questions
None.

## Design and decisions
- Keep the existing pure `TreeReader` to `Extraction` boundary and driver publications of decision 0028. Extend the owning extractors and their shared symbol identities; do not introduce a second graph or depend on an agent to infer deterministic facts.
- In `extractDataModel()` (`src/extract/data-model/extract.ts`), stop calling `databaseOf()` unconditionally for every source file's service. Allocate resources from positive storage evidence only. A missing driver alone does not establish absence; describe unconfirmed evidence as not found.
- In `extractContracts()` (`src/extract/contracts/index.ts`), materialize handler relations from resolved handler keys and scope operation matching by service/server. The global suppression of repeated `/healthz` matches is not an acceptable replacement for scoped matching. Remote call sites belong to their resolved enclosing functions.
- In `src/extract/code/index.ts`, declaration/resolution and `memberSites()`, add `code.contains` from class/struct/interface symbols to members, initializer evidence where present, reads/writes, constructors and type uses. Passing a function as a value creates a reference, not a call; use scope-aware symbol resolution rather than matching names globally.
- Preserve package relations for external and standard-library imports instead of dropping imports whose targets are not internal files. Use the importing manifest's declared version when available, never an invented standard-library version.
- In `k8sWorkloads()` (`src/extract/operations/deploy.ts`), replace the single overwritten probe-path reading with separate readiness/liveness/startup facts, preserving path, port, period and thresholds. Compose healthchecks keep their own command and timing semantics.
- In `metricsEndpoints()` and `loggers()` (`src/extract/operations/observability.ts`), retain individual metric definitions and resolved update sites, and logger uses. Ground broker instances in compose, Kubernetes or config, then resolve their channels, connecting services and address settings.
- Connect file declarations across extractor outputs through real owning identities. Extend driver ownership only where needed to prevent duplicate or evidence-free stub nodes. Keep publication determinism, code-point sorting, snapshot behavior, rename identities and idempotent refill.
- Supply actual CI YAML job ranges from the operations extractor instead of whole-file spans, so the page-content worker can render precise source locations without changing the extractor lane.
- The file template's Declares block currently filters to `code.symbol`; changing that filter belongs to madarch-m38l.21. This worker supplies graph edges and reports the integration requirement without editing the other worker's templates.
- Preserve `extractSqlFlow()` and its source-to-builder-to-unsafe-sink edges; creating a potential SQL-injection finding belongs to madarch-m38l.19.
- Extend the committed training generator where it lacks the named cases: a service without storage, all three Kubernetes probes, metric definitions and updates from service methods, and the required reference/use patterns. Tests use only repository-held or generated fixtures with neutral names.
- Add or extend an exhaustive audit at the extractor and published-driver seams. Count every node by kind, no-edge nodes and no-evidence nodes; report exact keys and sources on failures. Keep legitimate standalone and history evidence rules explicit rather than manufacturing links to improve totals.

### Acceptance plan and baseline
- Before implementation, commit this proposal and run the feature document gate. Stop for the coordinator's approval record; never bypass a refusal.
- After approval, use TDD for the named capability scenarios through the existing extractor entry points and published driver. First measure the pinned baseline using the same generated fixture used for the changed extraction; retain both per-kind reports.
- Run type checks and focused extractor, driver, generator and affected knowledge integration tests only on an AVX2 SkyPilot pod. Use 8 GB for wiki/fill work, queue one identical retrying launch if capacity is unavailable, and bring the cluster down when done. Run the full suite through CI, not local Bun.
- Use bounded Stryker mutation checks over changed line ranges and fast related test files on the pod; record actual killed/surviving mutants and limits, never call a skipped mutation run passed.
- Fill the generated training product with the scripted ACP agent, seed the everything role, enumerate every touched kind and walk every affected page through `/products/<p>/api/k/page?id=<id>&lang=ru` and the corresponding kind lists. Record all page checks, not a sample.
- Render the affected reading paths with `bun scripts/knowledge-shots.ts` or the relevant script on the pod; inspect English and Russian, light and dark, at 1150 px and 390 px. List exact screenshot paths and observed defects in the report. The mockup above identifies the existing reader surface, not completed acceptance evidence.
- Consult Codex read-only before the PR and resolve valid findings. The coordinator's initial code pointers are planning advice, not a final review receipt.
- Merge current `origin/main` before the final push, record evidence for the resulting revision, open one PR to main and wait for green CI on its head. Do not merge the PR or close the task before stage acceptance.

## Acceptance evidence
Proposal only. No product code has been changed, no Bun tests or builds have
run, and no screenshots, mutation results, baseline audit or final review are
claimed. The fetched baseline and source inspection support the implementation
plan above. Final evidence will be added after approval and implementation.

## DONE WHEN
The generated training product's graph asserts only evidenced resources and
supports all nine task areas with the corrected callback-reference semantics.
Named regression tests and the committed exhaustive audit prove the exact
relationships and print before/after per-kind no-edge and no-evidence counts.
Every affected wiki page is walked through the JSON API and the relevant
reader paths are inspected in both languages, themes and widths. Scoped pod
checks, mutation evidence, read-only Codex review and CI on the PR head are
recorded, with any limits stated explicitly and no outside repository or real
agent run required.
