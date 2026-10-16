# Reduce unnecessary and superseded CI runs

Change: madarch-0dn8
Base: d48793869fddb408b8157c4befcc70e1dadaf7ce
Tasks: madarch-0dn8
Kind: supporting

## Intent
Reduce CI work for unrelated pushes and stop older branch runs when a newer push supersedes them, without changing release publishing or job behavior.

## Out of scope
- Changing what any job tests.
- Changing tag release or publishing behavior.

## Rationale
This is a supporting workflow-tooling change. It reduces duplicated work from unrelated branch pushes and cancels superseded runs, while retaining the existing release publishing path.

## Blocking questions
None.

## Design and decisions
Each workflow uses its workflow name and ref as its concurrency group. Cancellation is disabled on main and tag refs. Clean-install walks run on main and v* tag pushes, relevant pull requests, and manual dispatch. The release publish job remains gated to v* tag pushes.

## Acceptance evidence
Pending review, local checks and PR runs.

## DONE WHEN
A branch push runs only the workflows its change needs; a newer branch push cancels older runs of each workflow; main and tag runs are not cancelled; clean-install triggers and tag-only publishing match the tracked task; two pushes on the PR prove cancellation and no red release run.
