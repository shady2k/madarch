# Mention scanning follows authored prose, not evidence bytes or engine words

Change: madarch-47vw.9
Base: 898838c8755a5341923ecf16e24d022bde4e662f
Tasks: madarch-47vw.9
Kind: no-behavior

## Intent

ALX-1717 Step 1 could not reach the SQL, glossary and imports stages of the deterministic fill: writing the immutable blob of a document that quotes the mention grammar aborted the disk stage (ALX-2025, `fill-20261128T065548001Z` on main `6a55050a7`, zero model calls). Decision 0039's diagnosis (ALX-2073, section 2 and PR C) found two defects in one place — `src/graph/write.ts` scanned every field of every vertex and edge for mention tokens:

- `scanMentions` ran on the content of immutable evidence kinds (`code.blob`, `system.content-snapshot`), so a repository that documents its own token syntax, or stores an inventory of paths that contain one, made every later stage unreachable. Any repair at the caller would have had to change those bytes, which contradicts the digest the blob is keyed by and moves the evidence spans of every locator into it.
- The engine records the refusal of an authored token in its own fields (`system.progress.summary`, `system.run.end_message`, and the unit, plan, applicability and problem records). Those fields are scanned strings too, so recording the refusal threw a second `MentionSyntaxError` — the one that escaped `driveRun` in the observed run — and the diagnostic could not state the words it refused.

## Rationale

Kind `no-behavior`: decision 0039 already states both requirements. Items 5 and 29 govern authored graph text: tokens in text and JSON strings materialize `system.assertion-mentions` edges and a malformed reserved token refuses. Item 31 states that immutable evidence stores verbatim source content verified against its SHA-256 digest, with exact span and line locators. Item 29's text now says which payloads the mention grammar reads, because the writer applied the rule to every stored string whereas the requirements name authored prose.

The change introduces one predicate, `fieldScansMentions` in `src/graph/write.ts`, and every scan site reads it: the six `scanMentions` call sites of the assertion and draft writers, and the hint reader in `src/graph/graph-writes.ts`. A field the engine writes declares `mentions: false` — a new optional field of `FieldContract` in `src/graph/contract.ts`, defaulting to scanned — and an immutable evidence kind's `evidence.contentField` is never scanned. `system.operation.words` is neither: it is the verbatim record of the request as it was received, which an HTTP author's own `words` fill (`src/server/knowledge.ts`), so it may hold user input, it is stored exactly as given and it creates no mention edge; decision 0039 item 29 states it apart from the diagnostics and from the fields of the entity being written. Nothing else changes: authored fields, key fields and strings inside authored JSON are scanned exactly as before, and a kind the contract does not declare is still read as prose.

## Preserved contracts

- fill-orchestrator/attempt: a worker still follows one unit through a lease, a draft and a validation, and an authored malformed token still refuses the draft with `SCHEMA_INVALID`, so the unit fails exactly as it did; what changes is that the refusal can be recorded.
- fill-orchestrator/publish: one publication per unit generation, by the one graph writer, under the run-and-unit fence; the writer's phases, its digest check and its evidence locators are untouched, and the immutable blob keeps its exact bytes and digest.
- fill-orchestrator/completion: a run finishes with what it covered — and now reaches the stages after the one that used to abort, because a repository's own mention examples no longer stop it; a named later plugin, `db-schema`, publishes its table from the files the disk stage published.

## Coverage

- fill-orchestrator/attempt: static, test, mutation, review
- fill-orchestrator/publish: static, test, mutation, review
- fill-orchestrator/completion: static, test, mutation, review

## Where it is seen

Kind: internal
Place: the run trace of a deterministic fill — `madarch fill` in a terminal and the run page `/p/runs` — and the graph the wiki reads
Reason: the change is the writer's reading of stored strings; no page gains a control or a field, while a fill that used to die on its own evidence now finishes its stages.
1. A person fills a product whose repository documents the mention syntax, in a code comment or a document: the disk stage publishes the blobs, the stages after it run, and the blob's content reads back byte for byte with the digest it is keyed by.
2. A person's own text names a malformed reserved token: the unit still fails with `SCHEMA_INVALID`, and the run's progress and its end message state that refusal exactly as the parser wrote it.
3. A person's request text (`system.operation.words`) holds a token: the request is stored exactly as given and no mention edge is made from it, because it is a request record and not authored prose about an entity.

## Out of scope

- Queue recovery (`madarch-47vw.7`) and the browser read timeouts after a fill ends: separate cards, separate defects.
- Which engine fields exist, and any change to the grammar, the escape rules or the `system.assertion-mentions` edge shape.
- The ALX-1717 Step 1 rerun itself, which belongs to its own card.

## Blocking questions

None.

## Acceptance evidence

`bun run check` green on the patched tree (tsc, the architecture check, and the catalog, workflow and slow-test checks) and GitHub CI as the full gate. The boundary is proven by two files: `test/graph-mentions-boundary.test.ts` holds the fast writer and refusal cases (two cases, 4.972 s alone, so the normal shards run it), and `test/graph-mentions-fill.test.ts` holds the one repository-owned confined plugins-only fill — `disk` publishes a document that quotes the mention grammar and a SQL source, `db-schema` then publishes the table of that source — 36.5 s for the case and 40.059 s for the file alone on the reviewed tree, so the required `slow-files` matrix of `.github/workflows/ci.yml` runs it every push with `cases: 1`. On the writer at `2141fb1e` the same fill dies on its literal example; with this commit it finishes, the blob keeps its bytes and digest, and the later stage runs. The refusal path is proven on the writer itself, which stores the engine's exact words in `system.progress` and `system.run`, so no second full fill pays the retry waits. The red baseline and the green patched run are recorded in ALX-2082. The mutation check is owed at the review gate: this card's scope runs targeted tests and GitHub CI, and its estimates name no Stryker run.

## DONE WHEN

A repository that quotes the mention grammar fills to its last deterministic stage with zero model calls, its evidence blobs hold their exact bytes and digests, an engine diagnostic states a refusal verbatim, and an authored malformed token still refuses while an authored mention still writes its edge.
