# Reduce model-check startup time without changing behavior

Change: madarch-24sy-7-test-time
Base: f5c778d02e3319468bc0f1cbc58a713672a568c4
Tasks: madarch-24sy.7
Kind: no-behavior

## Intent
Reduce startup overhead in model-check, model-send, and prepared-view paths while
preserving the current validation and rendered-view contracts.

## Rationale
These changes avoid repeated PGlite setup and redundant graph-problem analysis.
They preserve the existing model-check and view outputs, so no capability
requirements change.

## Out of scope
No timeout changes, query semantics, storage layout, public API, or model behavior.

## Changes to requirements
None. This change preserves the current requirements.

## Preserved contracts
- model-check/problems: default checks report recognized problems; send checks skip advisory analysis only after success.
- model-check/views: the same prepared engine and view set produce the same output.
- views/one-view: server view answers retain their existing output contract.

## Coverage
- model-check/problems: test
- model-check/views: test
- views/one-view: test

## Blocking questions
None.

## Design and decisions
Project assertions directly into the query database, reuse the prepared engine
and view set for rendering, and defer advisory problem analysis until a send
check fails. Keep the default model-check behavior unchanged.

## Acceptance evidence
Local focused checks are recorded in the integration queue. Full-suite evidence
will come from CI on the pushed branch.

## DONE WHEN
Successful model-send checks avoid unnecessary advisory analysis and temporary
HistoryStore startup; prepared rendering reuses its existing engine and view set;
all existing focused behavior tests pass without changing timeouts.
