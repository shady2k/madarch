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
- madarch-o0eq.3 (operations): `madarch-sky-test /home/dev/.herdr/worktrees/madarch/feature-madarch-extract-operations test/extract-operations.test.ts` on the pod, exit 0: 29 pass, 0 fail, bun test 4.99 s, pod wall 25 s (run-20261021-193312.log.txt). Every item of the areas config, deploy, build, dependencies, obs, stack and newcomer is asserted by its named case; no todo. Known defect on the base branch, unchanged by this task: the neutral-names scan flags src/extract/records.ts lines 19 and 20, the contract's own docstring examples, reported to the coordinator.

## DONE WHEN
Every code-fact and history-fact item of the answer key in the extractors' areas is produced and asserted by a test on the generated training repository; what cannot be read is named as a gap.
