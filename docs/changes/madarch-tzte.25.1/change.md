# Pages gain narrative text by importance, every sentence tied to its facts, kept in the product's git as proposed

Change: madarch-tzte.25.1
Base: 24ec77f2
Tasks: madarch-tzte.25.1
Kind: no-behavior

## Intent

Decision 0026, "Pages": "Every graph node of a page-worthy kind has a live page at
once, rendered from the graph without an agent …; it is a view, not a file in git.
Narrative text is a second layer written by agent units in order of importance, each
sentence tied to fact or claim ids, stored as Markdown in the product's git with
status proposed; a person's edits and answers are git as well." The self-filling
charter's outcome 4 says the same in its own words: assumptions show on the page
with an unverified badge.

The two changes before this one (madarch-tzte.23.1, 23.3) landed the graph-rendered
page and named the narrative layer out of scope: "agent-written Markdown tied to fact
ids, stored in the product's git as `proposed` — is not read or written here." This
change writes and reads it:

- **`src/fill/stages/narrative.ts`** — the pages stage, on the agent-stage shape of
  madarch-tzte.24.1. Its plan names one unit per page-worthy node for the most
  important `NARRATIVE_PAGES_PER_RUN` pages the product holds no *current* page of —
  most important first across the whole product (stage 5's PageRank, ties in code
  point order; a page is current when the unit that published it still holds it at
  its own current generation, which the plan reads the way the history stage reads
  its own SQL). The rest of the product's pages are a later run's: a run narrated
  its budget plans the next ones, and a page whose unit was replaced stands before
  any new one. A repository whose remaining pages would take the plan past the
  shape's own bound (`MAX_PLAN_UNITS`) stands as one unit — its own page — the
  shape's own collapse. A unit's packet is the shape's own for its node and one
  section of its own: the claims and rules the graph holds about the node, each with
  its id, so a sentence can name what it stands on.
- **The `narrative` fact kind** (`src/fill/facts.ts`) — the page's sentences, each
  tied to the fact or claim ids it stands on, and the node the page is about. The
  kind's stage is `14-narrative`, added to the schema's stage list beside 0026's
  stages 0–13. Its layer is `inferred` and its status is always `proposed` (0005);
  what the page says is `meaning` (self-filling's outcome 4: "meaning (only
  assumed)"). A sentence that names no fact is no sentence, and the facts a sentence
  names are read by the write path's own reference check: an id that stands nowhere
  in the graph refuses the write at once, naming the id (0026, "Writing": every
  write is checked at once).
- **`src/fill/narrative-text.ts`** — the page's own text, one deterministic form
  shared by its writer and every reader: the front matter that says what the page is
  about, that it is `proposed`, and that the fill wrote it (`writer:
  madarch-fill-agent`); one line a sentence, each ending with the comment that names
  the facts the sentence stands on. The bytes are a pure function of the fact, so
  the same page renders the same on every machine.
- **`src/fill/narrative-outbox.ts`** — the pages outbox, decision 0027's "separate
  idempotent outbox step": after a run's units settle, every published page of the
  product is carried into the product repository's git, which is where 0017 and 0023
  keep the truth of authored content. The step is idempotent (the same bytes stand —
  nothing to do), replaces a page the fill wrote before, and never writes over a
  file a person wrote: a person's edit wins over the agent's (the charter), and what
  acceptance does with such a page is stage 25.2's.
- **The page's model and the wiki app** (`src/fill/graph-pages.ts`,
  `wiki/app/src/graph-pages.tsx`) — the page shows the narrative as a layer above
  the graph-rendered facts, marked unverified, each sentence with the facts it
  names. A sentence whose facts stand in the graph no more is marked stale by
  itself, and the whole layer is marked stale when the unit that wrote it was
  replaced: the replan is on its way, and the page says so rather than standing as
  if it were current.
- **The service's run** (`src/fill/orchestrator-host.ts`) drives the outbox after a
  run settles, and names what it carried in the run's result. A registry without the
  pages stage — every run today, which names no agent — carries nothing and pays
  nothing: the step is not even started.

## Rationale

`no-behavior`: the change implements accepted decisions (0026's "Pages"; 0027's
publication and outbox; 0005's layers and statuses; the self-filling charter's
outcome 4) without moving a requirement of the product. The fill's capability is
proposed by `fill-pipeline-monday` and is not closed, so the rebuild's own
requirement text lands with the stage that closes decision 0026, exactly as
madarch-tzte.20.1 to 24.1 recorded theirs.

No served surface moves: the daemon's fill wiring names no agent
(`src/product/fill-stages.ts`, `daemonFillOrchestrator`), so a run registers no
pages stage today; the registry's change is visible to a run that wires an agent,
which is what the tests do. The page model gains a field that is `null` for every
product no pages stage has run for, and the app renders no section for it. No
route, command or help text changes. A run's stages today are unchanged for any
product whose wiring names no agent.

## Out of scope

- **Open questions and the next step on the same pages** — 25.2's, on the pages this
  stage fills; this change keeps its page change to the one narrative section.
- **Acceptance and answers on a page's proposed text**, and the person's edit of a
  page's file read back into the graph — 25.2's. The outbox keeps a person's file
  and names what it did; what a person's acceptance then means for the fact is that
  stage's.
- **The updates after a commit** (0026's "Updates", 26.1): a page whose facts moved
  is replanned by the run's own staleness sweep while the run runs, and the page
  marks the sentence stale the moment the fact stands no more; which units and pages
  a later commit reruns is the impact propagation's own task, and the seam is named
  in the design notes.
- **The three page kinds whose value names no repository** — `api-endpoint` (a
  contract), `environment-variable` (a name) and `rule` (a statement) — which the
  plan cannot enumerate per repository through the read grammar, and whose pages
  this stage does not narrate yet; they join when their values name their repository
  or the grammar gains a read that reaches them (named in the design notes).
- **The fill's capability text**, proposed by `fill-pipeline-monday` and not
  current, as the changes before this one recorded theirs.

## Preserved contracts

- fill-stages/registry: a stage is still one module plus its registration line, and the pages stage is one `.register` beside stage 8's, registered only where the run wires an agent.
- fill-stages/configuration: a product still enables, disables and limits a stage through its manifest; the numbers a page's unit is held to are the limits its stage resolved.
- fill-orchestrator/plan: a run still plans its units from the declared stages and reads the graph through the same reader; the pages plan is one unit per page in importance order, and the shape's own collapse bounds it.
- fill-orchestrator/attempt: a worker still follows one unit through a lease, a draft, a validation and a publication, under one fence, with the unit's own MCP server opened for the attempt and closed when it ends.
- fill-orchestrator/publish: a unit's facts are still published in one transaction, at most once per generation, with the reads rechecked and the queue settled inside it; the outbox runs outside it.
- server/protocol: the unit tool route, its refusals and its order are unchanged; a page's fact is written through the same checked write path as every write.
- release-binary/installers: the release binary still builds, installs and runs; the outbox's git steps run this program's own `git`, and no dependency is added.

## Coverage

- fill-stages/registry: test
- fill-stages/configuration: test
- fill-orchestrator/plan: test
- fill-orchestrator/attempt: test
- fill-orchestrator/publish: test
- server/protocol: test
- release-binary/installers: test

## Blocking questions

None.

## Design and decisions

- **The page's fact is the record, and the file is the product's git's own copy.**
  0026 puts the narrative's storage in the product's git ("stored as Markdown in the
  product's git"), and 0017/0023 make that git the truth of authored content. But
  the fill's units write facts, and the graph is what the page reads; so the unit's
  product is a fact of the kind `narrative` — the sentences and their ties — and the
  outbox renders the file from the published fact and commits it. The fact is not
  the truth: the file is. The fact is what the fill wrote, at which generation, and
  what the page reads; a person's edit of the file diverges from it, and the digest
  of the rendered bytes is the comparison (the outbox's person rule; 25.2's
  acceptance reads the same way).
- **The value names no repository, and the identity is the node and the words.** A
  page's file always stands in the product repository (0026's own words), so the
  value would only repeat the write path's provenance — and it would contradict it:
  the bytes a page's write cites stand in whichever repository the node's evidence
  stands in, and the write path refuses a fact whose value names one repository and
  whose place cites another. The identity is the node the page is about and the
  canonical digest of its sentences: a replanned unit that rewrites the page has
  written a different page, and the store must hold the words the newest generation
  wrote, not the first reader's observation of a node under one id. The outbox
  scopes the pages it carries by the product's own holdings, never by the bytes.
- **The plan skips a page whose current page stands, and the run's own cache key
  replans it.** A page is the unit's product, so the page stands exactly as long as
  the unit's cache key stands: 0026's own key — the recorded reads with their
  membership, the spans they read, the prompt, schema and model versions — which is
  what madarch-tzte.26.1 made the orchestrator's reuse rule. A commit that moved no
  fact a page's sentences stand on inherits the page whole; a commit that moved one
  replaces the unit, and the page is written again. Within a run, staleness is the
  same rule at the pass that would settle it: the recorded reads are rechecked, a
  read that answers something else marks the unit stale and opens its replacement
  generation (0027: "a published generation stays an immutable record, marked stale
  and linked to its replacement").
- **A sentence is stale when a fact it stands on stands no more.** The page reads
  the fact ids each sentence names and asks the graph for each; one that answers
  nothing marks the sentence. It is a reading of the page against the graph as it
  stands — no clock, no history — so it says exactly what a reader needs: this
  sentence named a fact, and the graph holds it no more. The layer's own stale mark
  is the holding's: a replacement generation standing for the writing unit means the
  unit was replanned, and the page says a new text is on its way.
- **The outbox never writes over a person.** The file's front matter names its
  writer; a file the fill wrote (`writer: madarch-fill-agent`) is the fill's own
  earlier page and the newer one replaces it; anything else — a person's file, or a
  file the front matter cannot read — is kept, and the step's result names it. The
  charter's "a person's edit wins over the agent's" holds at the only step that
  writes into the person's checkout. A person who edits the text and keeps the
  front matter would see a later generation replace it; what protects an edited
  page for good is the acceptance 25.2 records.
- **A replaced unit's page goes with it.** A unit's publication replaces the unit's
  own set, so a generation that publishes no page — one whose unit had nothing to
  say — retracts the page the earlier generation stood behind: the graph holds the
  words no more, and the page shows no narrative layer until a new one is written.
  The page had said it was stale while the stale record stood; the retraction is
  the store's own replace-by-unit rule (0027), and keeping a page the newest
  generation did not stand behind would be a second truth beside it.
- **One commit per outbox step.** The pages a step wrote are staged and committed
  together, as the fill, at the caller's clock. A fill of many pages is one commit a
  person can read and revert whole; the step's idempotence is HEAD's bytes: a second
  step whose page stands at HEAD byte for byte writes nothing and commits nothing,
  and a step that crashed after its write finds the commit still owed.
- **The schema's stage list grows by the pages stage.** 0026 numbers its fill stages
  0–13, and the Pages bullet is not one of them; but the kinds' own table decides
  which stage writes which kind, and the coverage the shape writes for every unit is
  admitted by the same table. So the list gains `14-narrative` — the pages stage —
  and the narrative kind's own entry names it. Nothing else in the table moves, and
  the questions an agent raises stay with the agent stages that raise them (25.2).

## Acceptance evidence

The checks, each command's own exit status, at hand-over. The branch's one commit
stands rebased on `origin/main` `dea75e75` (the stage 11 and stage 12 merges are in:
the pages stage's registration, the schema's `narrative` kind beside stage 12's
`answer` kind, and the impact test's page-unit expectations carry the merge); the
proposal's `Base:` names `24ec77f2`, the revision the work was written against, which
both mains hold.

- `bun run check` (`tsc --noEmit`) exit 0 at every edit round.
- The focused suites run in SkyPilot, not on this machine (the owner's rule),
  `madarch-sky-test <worktree> <files>`, each with the tests' own exit status:
  named in the tracker's check records at hand-over.
- The wiki app's own checks (`wiki/app`: install, `bun run check`, `bun test`,
  `bun run build`) run on the pod with `--avx2` (tree-sitter's wasm-simd): named
  beside them.
- The feature document gate (`node .shady2k/documents.mjs check --phase feature
  --change madarch-tzte.25.1 --candidate worktree --target origin/main`) exit 0,
  clean, after every edit round and at hand-over.
- CI on the exact SHA of the branch: named in the queue entry.
- The independent review, one fresh read-only session over the diff, told not to run
  anything on this machine: named in the queue entry with its verdict and findings.

## DONE WHEN

- Bounded agent units on the agent-stage shape write a page's narrative text in
  order of importance (PageRank), each sentence tied to fact or claim ids, stored as
  Markdown in the product's git with status proposed; the page shows it as a second
  layer above the graph-rendered facts, marked unverified.
- A sentence whose facts change is marked stale and its unit replanned; tested with
  the fake ACP agent.
