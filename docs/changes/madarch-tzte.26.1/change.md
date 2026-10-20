# A commit reruns only the agent units and pages its changes reach over the graph's edges

Change: madarch-tzte.26.1
Base: 24ec77f2
Tasks: madarch-tzte.26.1
Kind: behavior

## Intent

Decision 0026's "Updates" is the last part of the fill's cycle: "On a
default-branch commit: the deterministic stages run for what changed; impact
propagates over graph edges; only affected agent units and pages rerun, in
dependency order. A unit's cache key is its queries with their result membership
(empty results included), the spans it read, and the prompt, schema and model
versions."

The deterministic half landed (madarch-tzte.21.1 to 21.11): a second run after a
one-file commit plans that file's units and its dependants' and no others. The
agent half did not:

- **A span read could not move.** A tracked read recorded the span's *commit*, and
  the reader refuses a span asked at a commit other than the run's pin, so after a
  commit every unit that had read a span either could not be rechecked at all (the
  reader raised) or, had it answered, answered the same bytes from the old commit.
  The part of the cache key 0026 names as "the spans it read" did not exist.
- **A run inherited a unit on its inputs alone.** Planning compared the digest of the
  unit's *named inputs* and inherited a published generation whose digest matched,
  without rechecking one read. A unit whose reads or spans had moved was inherited
  and never rerun, and the read recheck the machine performs at publication was not
  consulted across runs at all.
- **A run could not reach what it did not plan.** The staleness sweep walked the
  run's own units. A published generation another run left was rechecked by nobody,
  so a change the deterministic stages published in this run propagated to no unit
  that consumed it — which is exactly the propagation 0026 asks for.
- **A commit invalidated every agent unit.** The product wiring named a unit's scope
  pin as its input, so every commit moved every agent unit's digest: the update
  would rerun the whole product's agent work on any commit.
- **Nothing measured it.** No test drove a commit through a product that has agent
  units, so "only those rerun" was unproven.

After this change a commit reruns exactly the units whose cache key it moved, in
the order the derived stage graph names, and the pages follow the facts the
publications land — measured on the training repository with the fake ACP agent.

## Out of scope

- **Who asks for the update run.** The background server's own watching of the
  default branch, its debounce and the limits the wizard sets are madarch-tzte.26.2.
  This change makes the run an update reruns the right things; it starts none.
- **The real agent, its model and its cost.** Every agent unit here is the fake ACP
  agent of `test/fixtures/acp-fake-agent`: no real prompt, no network, no token.
  The walk that spends tokens on the owner's machine is madarch-tzte.11's.
- **The deterministic stages themselves.** They are already incremental (21.x) and
  are unchanged: this change reads their publications and never alters what they
  plan or write.
- **Narrative text and diagrams of a page.** A page is a view of the facts this
  change already announces; its narrative layer is not landed anywhere yet.
- **A second writer.** Decision 0027 makes this process the home's only writer, and
  the propagation reads the same store a publication writes.

## Changes to requirements

Changed capability `fill-orchestrator`:

- `plan`: a unit carries the digest of its cache key's known part — its named inputs
  and the versions that decide what it reads and answers — and a published
  generation is inherited only when that whole key still stands; scenarios
  `inherited-key` and `key-moved` are added.
- `staleness`: the cache key's four parts are named, a span read is recorded as its
  place in the run's pins with the digest of its bytes, and a run reaches the
  product's published generations whose stage consumes a fact kind a stage of this
  run published; scenarios `span-moved`, `span-unchanged`, `version-moved`,
  `reached-over-the-edges` and `not-reached` are added.
- New requirement `update`, with the scenarios `one-file-commit`, `pages-follow-the-facts`,
  `page-cited-again`, `page-gained`, `dependency-order` and `disabled-stage`.

## Preserved contracts

- fill-orchestrator/publish: a publication is still one short transaction that rechecks every read the draft stands on before anything lands, still refuses a moved membership with `fill-publication/reads-stale`, and still writes one uniquely constrained record per generation; a replayed publication answers its record and writes nothing.
- fill-orchestrator/attempt: an attempt still leases its generation under a fencing token, records its draft, validates it and publishes it once; nothing about an attempt's own steps changed.
- fill-orchestrator/split: a split still seals its children atomically with its own checkpoint, and a child is still planned under a key computed the same way as its parent's.
- fill-orchestrator/cancel: cancelling a run still revokes the authority of the generations it planned and settles to `cancelled`.
- fill-orchestrator/host: the background server still owns the orchestrator, opens nothing before a fill is asked for, and answers the pages from the same store it publishes into.
- fill-orchestrator/join: a parent still joins only when every sealed child published and is still fresh.
- server/protocol: the routes, their shapes, their refusals and their order are unchanged. `GET /api/graph/events` answers the changes a publication recorded, in the same order, and holds fewer nodes for a publication that only cites a fact again — that is this change's `update` requirement, not a change of the route.
- product-wiki/live: a publication this process makes still wakes every open page channel and drops the page cache, so a page is never older than the change a client was told about.

## Coverage

- fill-orchestrator/plan: test
- fill-orchestrator/staleness: test
- fill-orchestrator/update: test
- fill-orchestrator/publish: test
- fill-orchestrator/attempt: test
- fill-orchestrator/split: test
- fill-orchestrator/join: test
- fill-orchestrator/cancel: test
- fill-orchestrator/host: test
- server/protocol: test
- product-wiki/live: test

## Blocking questions

None.

## DONE WHEN

- After a commit, the deterministic stages run for what changed (21.x, already incremental) and the change propagates over graph edges to the agent units and pages whose cache keys (tracked reads with membership, spans read, prompt/schema/model versions) moved; only those rerun, in dependency order.
- Measured on the training repository with the fake ACP agent: a one-file commit reruns the expected units and pages and nothing else (listed).

## Design and decisions

- **The cache key is one value per generation, and four parts are rechecked.** Decision 0026
  names the parts; the store keeps the digest of the two that are known before a unit runs
  (`fill_unit_generation.inputs_digest`), and the other two are compared with the store and the
  pins: `stageCacheVersions` folds the stage's own `id@version` and the stage's `cacheVersions`
  — the agent unit stage's prompt and answer-schema versions and the identity of the agent it
  drives — into that digest with the named inputs, and `generationFresh` rechecks the recorded
  reads against the graph. Planning inherits a published generation only when the whole key
  stands, and replaces it otherwise, naming what moved in the run's own progress. A stage whose
  prompt cannot change names no `cacheVersions`; a stage that has one is replaced the moment a
  run resolves another, which is what "the prompt, schema and model versions" is for.
- **A span's cache key is its bytes, not the commit.** `GraphRead`'s span read may now name no
  commit, and such a read is answered at the run's own pin (`spanRow`). A span read is recorded
  under that pin-independent text with `spanMembership` — the repository, the file, the lines
  and their text — so a recheck at the next pin compares bytes with bytes: a file the commit
  moved answers differently and the unit is stale, a file it did not move answers the same and
  the unit stands. Recording the commit would have made every span read move on every commit;
  recording nothing but the request would have made no span read ever move, which is the defect
  this change found first.
- **`movedRead` names the read.** The sweep and the planning decision report which read moved
  ("a read the generation recorded answers something else now: {"read":"facts-with",…}"), so
  the measure of an update says why a unit reran and not merely that it did.
- **A change propagates over the declared capabilities.** A run rechecks the product's published
  generations it did not plan whose stage consumes a fact kind that a stage publishing in this
  run produces (`propagatedUnits`), and replaces the ones whose key moved into this run. The
  capabilities `consumes`/`produces` are the graph's edges this is made of, so the sweep reads
  no more keys than the change can reach, and a generation whose stage the product disabled is
  left as its record. It runs where the sweep already ran — when the run has nothing else
  outstanding — which is also what puts it after the publications that moved the reads: the
  dependency order 0026 asks for is the run's own schedule, not a second one.
- **The agent unit's input is not its repository's pin.** The product wiring's `inputsOf` named a
  unit's scope pin (or the blob at its path) for every stage; for an agent unit that meant every
  commit moved every agent unit, which is the opposite of "only affected units rerun". An agent
  unit's facts stand on what it read — rechecked as reads and spans — and on the versions its
  stage names; the wiring therefore names no pin for it. Its scope's *bytes* are still covered:
  every span it read is compared at the new pin.
- **A product's fill can now be the agent one.** `createStagesFill` takes the agent its stages are
  driven with and registers the agent stages of 0026 this build holds beside the eight deterministic
  ones (`StagesFillOptions.agent`; madarch-tzte.24.1's shape registers stage 8, the product's
  overview). A product that names none keeps exactly the fill it had: no agent unit is planned, and a
  run never plans work it cannot run.
- **A page is announced when its facts changed.** `applyPublishedFacts` announced the pages of every
  fact a publication wrote, and a publication writes the facts it cites again — stage 5 re-measures a
  file's, a symbol's and a module's importance over the whole repository on every run. Measured on the
  training repository, a one-comment commit announced 65 pages where 4 facts had changed; after the fix
  it announces 4. The store now counts a fact as written only when its row is new or when the fields its
  kind measures (or its schema version, or the provenance a re-measuring publisher moves with it) differ
  from the row it holds — `measuredMoved`, the same rules the insert's own statement applies — and the
  pages it announces are those facts' pages plus the pages of the facts it stopped holding and no other
  unit does. A republished fact therefore announces nothing, which is what "pages its changes reach"
  means: a page is a view of the facts, and a view of the same facts is the same page.
- **The measurement is the training repository.** `test/fill-impact.test.ts` generates the
  training repository this project's generator makes, declares it as a product's one code
  repository, fills it with the fake ACP agent, commits a comment into one source file, and fills
  it again. It lists the units the update run reran, the units it inherited, and the pages its
  publications touched — the task's own bar — and asserts each list whole rather than by count, so
  a unit that leaves the list is named by the failure. Measured on 2026-10-20, the update run
  after one comment appended to `services/promotions/src/promotions.go`:
  - **the first run of the product plans no agent unit**, and its 41 units are the deterministic
    fill: a run plans before any stage publishes, and the agent stage's plan reads the graph the
    other stages write. The run after it plans the product's one overview unit — stage 8 of decision
    0026, the shape madarch-tzte.24.1 landed, whose scope is every repository the run pins — and
    inherits the six units the deterministic stages plan for a tree that did not change.
  - **the update run reruns 14 units and inherits 3.** Rerun: the changed file's inventory,
    syntax and resolution units, the three inventory units of the folders above it, the snapshot
    of the repository's pin, its clustering, its history at the new commit and the history unit of
    the commit it left (whose facts it retracts), the three resolution units the stage's own
    pins-input makes it compute again (madarch-tzte.21.8's documented exception, not this
    change's), and the product's overview unit, whose recorded span read — lines 1 to 200 of the
    changed file, which holds 5 lines before the commit and 7 after it — answers different bytes (its
    graph reads stand: a module fact's membership holds no rank, and the commit moved ranks only).
    Inherited: the product repository's snapshot, clustering and history. Its progress says what
    moved: `<unit> went stale (a read the generation recorded answers something else now:
    {"endLine":200,"file":"services/promotions/src/promotions.go","read":"span",
    "repository":"training","startLine":1})`.
  - **the update run announces four pages**: the training repository's module (its membership and
    importance were re-measured) and the three symbols the changed file declares (their importance
    moved, 0.013 836 481 472). The changed file's own page is not announced — a file fact's row is
    its identity and a later publication of it changes no row — and neither is the product
    repository's, any document's or any other file's symbols' page. Before this change's
    `applyPublishedFacts` fix the same run announced 65 pages: every fact it cited again, ranks
    that did not move included.
  - **the update rechecks what the change can reach.** The sweep considers the product's published
    generations whose stage consumes a fact kind a stage of the update published; in this product
    that is the overview unit and the previous commit's history unit. The base this measurement was
    first taken on (dbf138d8) planned two agent units, one per repository, and their rerun-or-inherit
    split was the sharpest contrast this page had; madarch-tzte.24.1's shape, which this change is
    rebased on, plans the product's one unit at stage 8, and the per-repository units of its splits
    carry the same key.
- **What the review changed.** Three independent read-only reviews over this diff — two
  `prime-agent` sessions on `deepseek-v4.1-flash-auto` (which hit its limit mid-confirmation) and the
  confirmation on `glm-5.3-flash-auto` — found three defects, eleven should-fix items and fifteen
  nits; all of them are answered here, with a test where a test can say it. The third round read the
  rebased tree (madarch-tzte.24.1's shape) and held two defects: a span record a previous build wrote
  (with its commit inside) replayed at a moved pin still raised, where the record claimed it was a
  moved read — a recorded read is now replayed as a recheck replays it (`recordedReadText`, in the
  sweep and in the publication's own recheck), with a test whose reader refuses any text that still
  names a commit; and the cache-key versions surviving only on the shape's reference declaration, so
  the stage a run registers had none — `createAgentStage` puts them on every stage it builds
  (`agentIdentity` beside them), with a test over the declared overview stage and another model.
  - The two defects: a span recheck **raised** where the graph could no longer answer the read — a
    commit that deletes a file an evidence span cited, or shortens it past the span's first line —
    so the update run failed instead of going stale; a read that cannot be answered is now read as
    a read that moved (`answerNow`, the sweep's reason carrying the reader's own words, and the
    publication refusing `reads-stale` with the same), its reason reading `a read the generation
    recorded can no longer be answered: …` where the read answers nothing at all, and a test walks it. And a page this product
    **gained** from another product was never announced: the row stands because the other product
    holds it, so the first holding here is no new row and is still a fact arriving in this
    product's graph; `applyPublishedFacts` now records the product's holdings before it writes and
    announces those facts too, with a test of both products' channels.
  - The should-fixes: the record claimed `server/protocol`'s answers unchanged while the channel
    now holds fewer nodes (the claim is corrected and the rule lives in `update`); the capability's
    old `reuse` scenario described the defect this change fixes (it now names the whole key); the
    `update` requirement said a unit is rechecked "never before" its producer's publication (it is
    rechecked once at planning and again at the sweep, and says so); a moved version was reported as
    two opaque digests (the plan row now records `cache_versions` and the reason names the version:
    `prompt packet@1 → packet@2`); `span-unchanged`, `disabled-stage` and the read-moved cause had no
    test at their own level (each has one now; the propagation's reached unit is replaced through the
    sweep, which writes the replacement's plan row into the run); the planning cost — one graph query per recorded
    read per published unit — is named here rather than measured, and the digest is no longer
    computed twice per unit in the sweep; and rows a previous build wrote (`fill_unit_read` with a
    span's commit inside, `fill_unit_plan` with no `cache_versions`) are handled rather than
    migrated: a span recorded the old way moves once and its generation is replaced once, the plan
    row's absent versions are reported as "not recorded", and a span record whose commit the reader
    refuses is a moved read, not a failure.
  - The nits: the `recordPagesTouched` doc still said every written fact; the now-unused
    `inputsDigest` helper is gone; the record's span figures are corrected (lines 1 to 200, 5 lines
    before the commit and 7 after); this section and the measured numbers are filled; the impact
    test's two lists are stated as the plan's units and the store's units, which need not add up;
    and the new `readProductUnits` reads its rows without the alias the older reader copies.
- **The mutation sample.** The owner runs Stryker once per assembled stage, so this change carries a
  bounded manual sample over its own new logic, each mutant killed by the test named: the recorded
  span text keeping its commit killed `a span read as a unit's cache key` (three tests,
  `test/fill-graph-reads.test.ts`); propagation's `enabled` set emptied killed `a change a run
  publishes reaches the published units of the stages that consume it` (`test/fill-orchestrator.test.ts`);
  and `measuredMoved` answering `false` killed `the pages the update announces are the pages its
  publications changed` (`test/fill-impact.test.ts`). Each probe was one throwaway edit on the pod,
  run once and discarded with the staging it ran in.
- **On madarch-tzte.24.1's shape.** This change is rebased on it (base `24ec77f2`): the landed
  agent stage of a run is stage 8, the product's overview (`src/fill/stages/overview.ts`), built on
  the shape's `createAgentStage`, and the generic `agent-unit` is the shape's reference declaration no
  run registers. The cache versions therefore live on the shape, every agent stage of it carries them,
  and the product wiring exempts an agent unit by the stage contract's own marker (`usesTools`), not
  by an id. The measured run's agent unit is the product's one overview unit; the per-repository units
  of its splits carry the same key. The old-build span rows the first measurement read (the base
  `dbf138d8` recorded them) are exactly what the round-3 defect fixed.
- **The planning cost.** A run now rechecks every recorded read of every published generation it
  considers, so planning a product of `n` published units costs `n × reads` graph queries more than
  the one digest comparison it cost before. That is the price of 0026's cache key being what decides
  reuse, and it is paid only where a run plans; a product whose fill is not re-planned pays nothing.
  The number is named, not measured: the training repository is two units, and a measurement on the
  current madarch tree belongs with the walk (madarch-tzte.11) rather than here.

- **What this change does not do, and what it found.** A run plans before any stage publishes, so a
  product's **first** run plans no agent unit and its agent work begins in the run after the graph is
  filled (measured here: 41 deterministic units in the first run, the two agent units in the second).
  That is the planning epoch decision 0027 fixes and not a part of this task, so it is filed as
  `madarch-tzte.26.3` (deferred: the milestone's finding budget is spent) rather than changed here. Two
  measured costs of the deterministic stages stand as madarch-tzte.21.x left them: the resolution
  stage's units stand on the run's pins, so any commit computes again the files its plan names
  (21.8's `inputsOf` says why), and a unit that reads a producer's facts can be replaced twice in one
  update as those facts land in two publications (measured on the training repository's clustering
  stage, 2 → 3).

The owner approval required for a behavior change is pending the coordinator; the record on the
task says so in the coordinator's own words.
