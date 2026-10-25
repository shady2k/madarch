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
the task and an exhaustive before/after audit. It registers the new factual
kinds (metric, broker, probe, compose healthcheck and document section) with
English and Russian labels and the existing generic item template, so their
entities have reachable wiki pages. It does not change page layout.

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
- Register `code.metric`, `code.broker`, `code.probe`, `code.healthcheck` and `code.document-section` in `STARTER_KINDS` with bilingual names and the existing generic `item.md` template. This is the minimal integration needed to reach the new facts, not page redesign. Document sections are literal Markdown heading spans, not semantic document units or agent-written summaries; the later document-by-meaning work may replace that representation. Keep the page-content worker's facet/member and declaration-filter changes separate.
- Resolve canonical identities per actually declared key before publication. Publish cross-producer relations last under the driver's link producer, after real endpoint versions exist; retain the originating extractor on each link. Missing endpoints are located gaps, not evidence-free stub nodes. Preserve complete publications, rename identity, chosen-point bounds and unchanged refill. No graph-store API or schema changes.
- Preserve `extractSqlFlow()` and its source-to-builder-to-unsafe-sink edges; creating a potential SQL-injection finding belongs to madarch-m38l.19.
- Extend the committed training generator where it lacks the named cases: a service without storage, all three Kubernetes probes, metric definitions and updates from service methods, and the required reference/use patterns. Tests use only repository-held or generated fixtures with neutral names.
- Add or extend an exhaustive audit at the extractor and published-driver seams. Count every node by kind, no-edge nodes and no-evidence nodes; report exact keys and sources on failures. Keep legitimate standalone and history evidence rules explicit rather than manufacturing links to improve totals.

### Rebuild the derived graph when the extractor set changes (coordinator, 2026-10-25)

This rule **supersedes** the incremental link-revision design reviewed and rejected on 2026-10-25. Decision 0029 makes the graph a rebuildable index: a rebuild reads code and Markdown and loses nothing. The failed incremental design and original same-commit cache diagnostic stay in the acceptance evidence; they are not claims of passing behaviour.

- Persist the complete deterministic extractor-set digest, formed from each extractor's stable name and explicit version, beside the derived graph store. Include the fixed link-normalization/driver version so a changed graph interpretation cannot reuse an old marker by keeping function names unchanged. Do not add a graph-store table or public API.
- Before a fill reuses a graph, compare the stored digest with the running extractor set. An absent/changed digest rebuilds the derived store from scratch through the existing graph/fill lifecycle; it does not expand the old store in place. Progress explicitly says `graph rebuilt: extractors changed`, with English and Russian reader wording. Do not alter product Markdown, its bytes, Git history or other source repositories.
- Prefer the existing staged/copy-and-replace lifecycle: build the new derived store in a sibling scratch path, close its owners/readers before replacement, keep the prior working store until the new build succeeds, then switch the derived-store path/digest together. If the existing lifecycle cannot safely replace only graph state, stop at that exact seam rather than reuse a destructive product reset or invent a new store API.
- With the same digest, retain today's tree generations, aggregate link producer and complete publication path. An identical successful refill writes no node, edge or work rows. There is no independently numbered link revision, legacy stream retirement, same-commit in-place extractor expansion, new graph schema or store API.
- Normalize all producer contributions before the fresh store's publications. Retain every producer's original discriminator, exact source span and properties in canonical origin evidence; equal logical relations never use first-wins loss. Keep within-one-producer accidental duplicates as located errors. Edge ownership is stable under the canonical node ownership contract: when both endpoints have the same canonical owner, publish the normalized row in that owner's prepared extraction; when their canonical owners differ, publish under the existing aggregate. Never choose the publication owner from contributor presence/count, so adding/removing B's contribution at a later tip cannot transfer an A-owned identity. The destination extraction must exist. Node ownership is unchanged; this is not a solution for changing canonical node owners. Exact positioned occurrence identity follows the store's byte-start rule; choose the longest actual contributing span (producer code-point order breaks ties), never a fabricated union, while origin records preserve every exact span and original discriminator. The explicit driver-normalizer version bump forces a fresh index on deployment. Do not manufacture alternate identities or source spans.
- The exhaustive audit retains unchanged stored edge rows and audits each origin separately. A null single compatibility span is not structural success and cannot replace multi-origin evidence. Run the same hashed runner/evidence files for every later audit cell.

Required executable scenarios:
1. Fill A, then change the registered set to A+B at the same Git commit. The old derived graph is replaced; the new graph contains both real nodes and B's exact new link/origin. The old EXPECTED RED incremental-expansion fixture is superseded by this authoritative rebuild test, not weakened to accept missing links. Preserve its old diagnostic evidence separately.
2. Refill with identical names/versions/digest. Today's aggregate publication remains, zero node/edge/work rows are added, and no rebuild progress is emitted. Changing one version also rebuilds even if names and Git HEAD are unchanged.
3. A product Markdown file has identical bytes before/after changed-set rebuild, successful fill, failed rebuild and retry. The prior working graph remains readable on a failed staged rebuild when the lifecycle supports replacement; retry produces one complete current store/digest and an identical repeat is a no-op.
4. Fresh A+B producers contribute the same logical relation/occurrence with equal or differing properties and different reading sites. All origins survive and are individually auditable; malformed duplicates within A remain located errors. Same-set tip removal/empty aggregate, chosen-point bounds and rename/refill identities retain existing behaviour within that derived index.

No further design-Codex round is required for this coordinator decision. The feature gate and approval digest still govern implementation; normal correctness/PR review and all acceptance checks remain required.

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
Implementation is in progress and unverified. Partial product code, new
regressions and an exhaustive audit runner are present. No Bun tests or builds
have run for this implementation, and no screenshots, mutation results,
baseline audit or final review are claimed. The fetched baseline and source inspection support the implementation
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


### Correctness repairs after rebuild source review (2026-10-25)

The first rebuild checkpoint was not accepted. Its passing happy-path fixtures are not evidence for these repairs. The review and real `code.imports` publication failure remain retained.

- A snapshot carries a complete repository-pin set. Activate that set only after the candidate reader opens and warms. A failed candidate leaves the old reader and pins; delayed or already-consumed sequence notices change neither. This prevents fresh graph scope-ID reuse from attributing B to removed A.
- Every positioned occurrence retains original producer, discriminator, exact complete span and original properties, even with one owning producer. Positioned identity and endpoint-owner publication routing do not change.
- An accepted stop or pipe end after history, Markdown indexing or owner closure aborts a still-staged replacement before promotion. Do not enter the agent handshake on an already closed pipe. Product Markdown remains untouched.
- Audit output containment resolves physical existing ancestors before creation and uses native relative-path semantics. The executing runner, evidence helper, safety helper and code-point comparator have independent hashes, separate from the selected engine and fixture, and are rechecked on success and failures.
- `code.imports` keeps the existing nondiscriminated endpoint identity. Aggregate distinct actual syntax import sites with their exact specifiers, spans, metadata and count; alias bindings at one site are not extra imports. The compatibility span is one actual reading, never a union. Audit each retained import reading independently, including within original producer properties.

The code reader and driver/link-normalization explicit versions are 3 for this interpretation. No graph schema, API, producer-transfer protocol, all-relation aggregate ownership or Markdown migration is introduced.


### First empty aggregate and evidence identity repair (2026-10-25)

The first full pipeline retained the old publication-count failure: a lister-only fill reported two publications because the normalizer emitted a synthetic empty aggregate and the driver published it despite no existing aggregate stream. The driver now skips that never-used empty aggregate only when the same repository scope and aggregate producer have no earlier published work item. Failed or leased-but-unpublished work does not count as an earlier publication. A stream that published actual links still receives an empty publication when its last relation disappears, and unchanged refill remains zero. Actual source publication counts are not filtered or renamed; the original `1` expectation remains.

The reader walk keys each screenshot by the exact entity-ID hash plus kind, language, width and scheme. Its immutable plan includes eight rebuild-progress shots and eight combinations for each selected page. Completion requires every expected unique PNG and measurement and no extra truth PNG. Every page JSON is still walked in both languages. Cursor cycles, malformed totals and overflow are failures. Full-page truth shots and per-block numeric boxes accompany viewport dimensions; no first-window crop is passed off as the whole page.


### Resume repairs for the 15 legacy failures (2026-10-25)

The retained red command is the `legacy-five` stage of
`/tmp/madarch-m38l20-retry-0306/plan.json` (122 pass, 9 existing todo,
15 fail). Its raw stacks and source-grounded diagnosis precede these fixes.
No old class, type-reference, test-subject or dead-export assertion is removed.

- Explicit construction keeps the precise constructor call and a class
  reference at the same actual token. These are distinct facts, not two
  calls. The typed-site replacement removes only plain readings, so the
  second precise fact cannot erase the first. Class navigation, liveness
  and test subjects remain intact. Implicit construction still calls the
  class; no nonexistent constructor is fabricated.
- A precise type occurrence still folds to `code.uses_type`; it also folds
  to the established `code.references` navigation relation. It is neither
  a value read nor a call. Generic-shadowing negative checks stay intact.
- Two route-chain expectations now follow the actual registered inline
  handler. The approved callback-ownership requirement changed the old
  outer-function call attribution. Each test checks exactly one real
  `code.handled-by`, the factory's `callback-registration` reference with
  the callback's complete span, the inline function and its actual call,
  and the absence of a fabricated outer-function direct call.
- The package assertion still requires exactly the four repository service
  roots. It separately requires all 25 exact standard-library import
  identities, their import relationships and evidence, and 29 total
  package nodes. The old assertion counted all packages as roots, contrary
  to the approved standard/external-import requirement.
- The edge-endpoint assertion includes the real operations extraction,
  because dependency declarations belong to that producer. Every imported
  dependency must exist there, have its exact manifest/name identity,
  exactly one declaring-manifest edge with the same declaration span,
  source line containing its name and version, and the imported version.
  Code must not duplicate the declaration. All endpoints are still checked;
  no dependency-prefix exemption or fabricated known-set entry is used.

The code reader version advances from 3 to 4 because these semantics changed.
The extractor-set digest therefore triggers the approved rebuild boundary;
no schema/API change, in-place upgrade or revision allocator is introduced.
The single new complete pipeline is required before any acceptance claim.
