# Linux Homebrew clean install walk

Change: linux-homebrew-walk
Base: 86b420841f1f4057bc19758cd11623d759874bd1
Tasks: madarch-lfhu.2.9
Kind: no-behavior

## Rationale
The workflow and clean-walk harness are CI tooling. This change validates existing Homebrew behavior on Linux and does not alter the released formula or binary.

## Intent
Walk Homebrew installation and use on Linux x64 as well as macOS, and add an explicit dispatch proof against the published release formula.

## Out of scope
Changing the product binary or formula behavior; editing the tap repository; publishing a release.

## Changes to requirements
None.

## Preserved contracts
- release-binary/installers: The Homebrew formula continues to select the platform binary and verify its checksum; test the local Linux and macOS install walks and the published Linux install path.

## Coverage
- release-binary/installers: static, test, mutation, review

## Blocking questions
None.

## Design and decisions
Use Linuxbrew on ubuntu-latest, preserve the local temporary-tap walk for built artifacts, and gate the published-release proof on workflow_dispatch only. Keep workflow concurrency and path scope unchanged.

## Acceptance evidence
Recorded in the task and worker report.

## DONE WHEN
Linux clean-install CI runs the Homebrew local-artifact walk. A manually dispatched workflow installs the published `shady2k/tap/madarch` formula, verifies version 0.1.0, and serves a product.
