# The deterministic extraction reads every code fact the training repository's answer key names

Change: madarch-o0eq
Base: 65d1b549541b44d88532e75e794a0656587a2e19
Tasks: madarch-o0eq.1, madarch-o0eq.2, madarch-o0eq.3, madarch-o0eq.4, madarch-o0eq.5
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
- madarch-o0eq.5 (driver): PGlite `madarch-sky-test /home/dev/.herdr/worktrees/madarch/feature-madarch-graph-driver test/extract-driver.test.ts` on the pod (queued launch, run-queued-20261021-213412.log.txt), exit 0: 6 pass, 0 fail, bun test 48 s. Server PostgreSQL `.pod-pg.sh bun test test/extract-driver-postgres.test.ts` on the pod (run-pg-20261021-213928.log.txt), exit 0: 7 pass, 0 fail, bun test 58 s. The fill of the generated training repository (70 first-parent commits) takes 35 s on PGlite, 25 s on the server, and writes 1067 node versions and 347 edge versions; a second fill writes no row in any table. Full per-table sizes in the worker report. Rerun with all four extractors wired: see the driver line's update below once the new runs land.
- madarch-o0eq.3 (operations): `madarch-sky-test /home/dev/.herdr/worktrees/madarch/feature-madarch-extract-operations test/extract-operations.test.ts` on the pod, exit 0: 29 pass, 0 fail, bun test 4.99 s, pod wall 25 s (run-20261021-193312.log.txt). Every item of the areas config, deploy, build, dependencies, obs, stack and newcomer is asserted by its named case; no todo. Known defect on the base branch, unchanged by this task: the neutral-names scan flags src/extract/records.ts lines 19 and 20, the contract's own docstring examples, reported to the coordinator.
- madarch-o0eq.2 (data model and table access): `madarch-sky-test /home/dev/.herdr/worktrees/madarch/feature-madarch-extract-data-model test/extract-data-model.test.ts test/neutral-repository-names.test.ts examples/training-repository/generator.test.ts` on the pod, exit 0: 42 pass, 2 todo, 0 fail, bun test 18.50 s, pod wall 67 s (run-20261021-213945.log.txt). Every code-fact item of the areas database, table-access and outbox is asserted by its named case on the generated training repository; outbox.adr (document-fact) and the Kafka-publish and at-least-once facets of outbox.relay stand as the file's two named todo cases with their reasons. A read-only glm review round (5 findings, none blocking) is fixed and tested: byte-accurate call spans, holderless sites filed at the file, ALTER and CREATE INDEX on undeclared tables as gaps, the roll-up's access map keyed per directory, and the unsupported facets named.
- madarch-o0eq.4 (the history extractor): `bun run check && bun test test/extract-history.test.ts` on the pod, exit 0, 16 pass / 0 fail, 95 expect() calls (run-20261021-202314); `bun test test/neutral-repository-names.test.ts test/extract-history.test.ts`, exit 0, 20 pass / 0 fail (run-20261021-202541).

## DONE WHEN
Every code-fact and history-fact item of the answer key in the extractors' areas is produced and asserted by a test on the generated training repository; what cannot be read is named as a gap.
