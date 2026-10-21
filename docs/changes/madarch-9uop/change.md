# The training repository holds every element the wiki must explain, with an atomic answer key

Change: madarch-9uop
Base: 65d1b549541b44d88532e75e794a0656587a2e19
Tasks: madarch-9uop
Kind: no-behavior

## Intent
Grow the deterministic training repository of the ordering and payments slice into the product the wiki is judged against (the owner's decision of 2026-10-21): every element a newcomer must understand — documents, services, patterns, contracts, data, dependencies, build and deploy, configuration, tests, history — and planted observations (a cycle, a large file, a hotspot, change coupling, a dead export, a counter-example), each checkable against an atomic answer key. The specification is examples/training-repository/SPEC.md.

## Out of scope
- Running madarch or its fill pipeline on the generated repository.
- Any change to src/, the wiki app or the store.
- Including the answer key, SPEC.md or the generator in the generated output.
- Running the quality regression in CI.

## Rationale
The generator, its specification and its tests are tooling for judging the self-filling wiki. They do not change madarch's product behaviour or capability requirements.

## Preserved contracts
- product-repository/manifest: the training repository is generated outside the source checkout and does not change product manifest behaviour.

## Coverage
- product-repository/manifest: test

## Where it is seen

Kind: command
Place: `node examples/training-repository/generate.mjs ~/madarch-walk/training` (any folder outside the checkout) in a madarch checkout

1. The person runs the generator with a folder outside the checkout and gets a git repository of four services with documents, contracts, migrations, lock files, deployment files and a six-month history.
2. They open examples/training-repository/answer-key.json and, for any item, find its file and symbol in the generated repository at the named snapshot.

## Blocking questions
None.

## Design and decisions
The final state of the repository is real files under examples/training-repository/template; history.mjs plans about seventy commits and generate.mjs replays them, reading earlier states from the same files through since and until directives. The generator writes outside the source tree and creates a fixed git history with controlled authors, committer dates, messages and environment, so two runs give identical commit ids. The answer key holds one assertion per item (location, expected wiki statement, evidence class, viewpoints, whether it is required now, and a judge with the reader's task, what must be shown and linked and what must not be claimed); the planted counts are computed from the generator's commit plan and checked against the generated git log.

## Acceptance evidence
Run on the SkyPilot pod on 2026-10-21, 14 tests of examples/training-repository/generator.test.ts passing, bun run check exit 0.
The generated repository (72 commits, lines without the lock files counted in the final report): gofmt -l empty; go vet and go test exit 0 in orders and promotions (CGO disabled); tsc --noEmit exit 0 and jest passing in payments (18 passed, 1 skipped) and checkout (4 passed); every one of the 72 commit states passes gofmt syntax, go vet and tsc --noEmit.
The Docker images, the compose file and the Kubernetes manifest were not built or run. A walk of the pages against the key is not part of this change.

## DONE WHEN
The generator produces SPEC.md's repository deterministically, every SPEC item has an answer-key entry whose location resolves at its snapshot, today's key items are kept and remapped, the planted counts match git, and the key and SPEC.md never land in the output.
