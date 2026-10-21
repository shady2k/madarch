# The deterministic extraction reads every code fact the training repository's answer key names

Change: madarch-o0eq
Base: 65d1b549541b44d88532e75e794a0656587a2e19
Tasks: madarch-o0eq.1, madarch-o0eq.2, madarch-o0eq.3, madarch-o0eq.4, madarch-o0eq.5, madarch-o0eq.6
Kind: no-behavior

## Intent
Pure extractors over a repository tree return graph records of decision 0028 (src/extract/records.ts): contracts and routes, the data model and table access, configuration, build, deploy and dependencies, and the history analyses. Each is proven on the generated training repository against its answer key.

## Out of scope
- Writing the records to the graph store, and the driver that gives them time.
- Pages and agent stages.
- Removing today's fill stages; they stay until the pages move to the graph.

## Rationale
New modules that nothing in the product calls yet; the product's behaviour and capability requirements do not change until the driver and the pages use them.

## Preserved contracts
- product-repository/manifest: the extractors read a tree and write nothing; manifest behaviour is unchanged.

## Coverage
- product-repository/manifest: test

## Where it is seen

Kind: internal
Place: src/extract and its tests
Reason: nothing a person reaches calls the extractors until the driver writes their records to the graph and the pages read them.

1. A developer runs the extractor tests on the pod and sees each answer-key item asserted on the generated training repository.

## Blocking questions
None.

## Design and decisions
Decision 0028. Records carry logical keys, no time and no database ids; kinds and relation types are the engine's extractor schema under the `code.` prefix.

## Acceptance evidence
To be filled by each task with the test run on the pod.
- madarch-o0eq.1 (contracts, entrypoints, interactions, security): test/extract-contracts.test.ts names one case per answer-key item of those areas (19 items, all code-fact) and runs green on the SkyPilot pod beside test/neutral-repository-names.test.ts: 24 tests across 2 files, 0 fail, madarch-sky-test exit 0, 2026-10-21, after the review round, log run-20261021-211959.log.txt under ~/.cache/madarch-sky-test/madarch-feature-madarch-extract-0f9468.
- madarch-o0eq.5 (driver): all four extractors (contracts, data-model, operations, history) wired, plus the tree lister that owns every code.file node (one owning producer per node key; other producers' copies are dropped, their extra properties kept as a code.facet node, their edges end at the owner's node). PGlite `madarch-sky-test <worktree> test/neutral-repository-names.test.ts test/extract-driver.test.ts` on the pod (run-20261022-003528.log.txt), exit 0: 15 pass, 0 fail. Server PostgreSQL `madarch-sky-test --cmd <worktree> bash .pod-pg.sh bun test test/extract-driver-postgres.test.ts` on the pod (run-20261022-003718.log.txt), exit 0: 12 pass, 0 fail. The fill of the generated training repository (70 first-parent commits) takes 60.8 s on PGlite and 62.7 s on the server, and writes 2332 node versions and 1781 edge versions; a second fill writes no row in any table. Per-table sizes in the worker report.
- madarch-o0eq.3 (operations): `madarch-sky-test /home/dev/.herdr/worktrees/madarch/feature-madarch-extract-operations test/extract-operations.test.ts` on the pod, exit 0: 29 pass, 0 fail, bun test 4.99 s, pod wall 25 s (run-20261021-193312.log.txt). Every item of the areas config, deploy, build, dependencies, obs, stack and newcomer is asserted by its named case; no todo. Known defect on the base branch, unchanged by this task: the neutral-names scan flags src/extract/records.ts lines 19 and 20, the contract's own docstring examples, reported to the coordinator.
- madarch-o0eq.2 (data model and table access): `madarch-sky-test /home/dev/.herdr/worktrees/madarch/feature-madarch-extract-data-model test/extract-data-model.test.ts test/neutral-repository-names.test.ts examples/training-repository/generator.test.ts` on the pod, exit 0: 42 pass, 2 todo, 0 fail, bun test 18.50 s, pod wall 67 s (run-20261021-213945.log.txt). Every code-fact item of the areas database, table-access and outbox is asserted by its named case on the generated training repository; outbox.adr (document-fact) and the Kafka-publish and at-least-once facets of outbox.relay stand as the file's two named todo cases with their reasons. A read-only glm review round (5 findings, none blocking) is fixed and tested: byte-accurate call spans, holderless sites filed at the file, ALTER and CREATE INDEX on undeclared tables as gaps, the roll-up's access map keyed per directory, and the unsupported facets named.
- madarch-o0eq.4 (the history extractor): `bun run check && bun test test/extract-history.test.ts` on the pod, exit 0, 16 pass / 0 fail, 95 expect() calls (run-20261021-202314); `bun test test/neutral-repository-names.test.ts test/extract-history.test.ts`, exit 0, 20 pass / 0 fail (run-20261021-202541).
- madarch-o0eq.6 (code structure: modules, architecture, flow, exports, pattern, tests, payments.cycle, dead-export): `bun run check` and `bun test test/extract-code.test.ts test/extract-code-units.test.ts test/extract-data-model.test.ts test/extract-contracts.test.ts test/extract-operations.test.ts test/extract-history.test.ts test/neutral-repository-names.test.ts examples/training-repository/generator.test.ts` on the pod, exit 0: 167 pass, 9 todo, 0 fail before the review round and 109 pass, 9 todo, 0 fail over the five directly related files after it (run-20261022-001914.log.txt under ~/.cache/madarch-sky-test/madarch-avx2-feature-madarch-extract-f7a692). Every code-fact item of the eight areas (and the two inference items flow.orders.interface and exports.not-entrypoints, pattern.not-singleton) is asserted by its named case in test/extract-code.test.ts on the generated training repository, and the extractor's rules on small repositories by test/extract-code-units.test.ts; seven facets the call graph does not decide stand as named todo cases with their reasons. The extraction of the training repository has 0 gaps and one dead export (formatInvoiceLegacy). The data-model extractor's function nodes and the contracts extractor's route handlers now use the code extractor's symbol key (code.symbol:<path>#<qualified name>).

## DONE WHEN
Every code-fact and history-fact item of the answer key in the extractors' areas is produced and asserted by a test on the generated training repository; what cannot be read is named as a gap.
