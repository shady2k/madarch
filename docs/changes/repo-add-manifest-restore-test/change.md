# Exercise the manifest-restore failure after `repo add` commit failure

Change: repo-add-manifest-restore-test
Base: 6476a17ce645577f90dbea797af2d22c65d52acb
Tasks: madarch-74k4.1.3
Kind: no-behavior

## Intent
Add deterministic test coverage for the recovery path where `git commit` fails and the product manifest cannot be restored. A local pre-commit hook replaces `workspace.yaml` with a directory and exits unsuccessfully. The test checks the reported manifest path and restore error, the printed connection path, and the presence of the only moved checkout at that path.

## Out of scope
- Changing normal commit-failure rollback.
- Changing clone behavior or cross-device move behavior.
- Changing product code or product requirements.

## Changes to requirements
None. This test-only change checks existing recovery behavior and changes no product behavior.

## Rationale
The required mutation check for `madarch-74k4.1.2` identified the manifest-restore catch path as surviving. A deterministic fixture exercises that path without adding a production injection seam or using an outside repository.

## Preserved contracts
- product-repository/manifest: the product still reads its schema-versioned `workspace.yaml`; the fixture changes only the path during an injected restore failure.

## Coverage
- product-repository/manifest: test

## Blocking questions
None.

## Design and decisions
The failure is injected by a fixture-only POSIX pre-commit hook. It removes the working-tree manifest file, creates a directory at that path, and exits with a commit failure. No production code or interface is changed.
