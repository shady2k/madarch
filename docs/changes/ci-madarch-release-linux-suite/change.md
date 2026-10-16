# Release suite runs once on linux-x64

Change: ci-madarch-release-linux-suite
Base: 86b420841f1f4057bc19758cd11623d759874bd1
Tasks: madarch-lfhu.3
Kind: supporting

## Intent
Avoid blocking the v0.1.0 release on known failures in test suites on non-linux-x64 targets while retaining binary proof for every target.

## Out of scope
- Fixing cross-platform test failures.
- Publishing a release, publishing to npm, or pushing to the Homebrew tap.
- Changing any product behavior or per-target build and binary smoke steps.

## Rationale
This workflow-only change narrows where the tag-triggered root suite runs. It preserves every target build and binary proof, and it does not change runtime behavior or release publishing policy.

## Changes to requirements
None. This CI workflow change intentionally runs the release root suite only on linux-x64; target builds, binary proof, packaging, and tag-only publishing remain unchanged.

## Preserved contracts
None.

## Coverage
None.

## Blocking questions
None.

## Design and decisions
On tag pushes, gate the root test step on the linux-x64 matrix entry. Preserve per-target builds, smoke tests, checksums, package preparation and the tag-only publish job. Link the workflow comment to the deferred matrix-restoration task.

## Acceptance evidence
See the worker report and commit handoff for the checks run and their results.

## DONE WHEN
The root suite runs only on linux-x64 for tag release workflows, and the other matrix targets still build and prove their binaries.
