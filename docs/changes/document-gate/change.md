# Wire the document gate

Change: document-gate
Base: 1fa3767ccca81164d576a1797188b36094eb8794
Tasks: madarch-9jo
Kind: supporting

## Intent
Check the living documents against the work at the moments that matter: the
vision and charter on every commit, a change's readiness before its product
code lands, its evidence at stage acceptance, and the replay into the current
specs at closure. Until now documents were checked only by reading.

## Out of scope
Protected CI, receipt verification and tamper defences (the evidence level is
records); commands for static checks and tests, which arrive with the first
product code; any capability document.

## Rationale
Process tooling and documentation only: a deterministic adapter from the
project's Markdown and tracker to the shipped checker, its wrapper and hooks,
the document policy and the capability catalogue. No product contract changes.

## Changes to requirements
None.

## Preserved contracts
None.

## Coverage
None.

## Blocking questions
None.

## Design and decisions
The preflight accepted by the owner on 2026-09-24 (Handoff comment on
madarch-9jo, items 1-9), with these run decisions:

- A change pins `Base:`, the main-line revision its proposal was written
  against. Deltas are computed from that base, so a target that moved since is
  refused as a stale requirement instead of being silently reverted.
- The revision evidence is recorded against is a digest of the tree without the
  tracker export and the current specs: recording evidence and syncing specs at
  closure do not stale it; any other edit does. Check records carry it as
  `revision`.
- Approval is required for behavior changes only (`approvalFor` in
  `.shady2k/documents.json`); the stored policy keeps the checker's schema.
- A supporting change owes review. The tooling's own tests run in pre-commit
  whenever `.shady2k/` or `.githooks/` is staged, instead of a recorded receipt.
- Root dotfiles count as tooling, not product code.

## Acceptance evidence
Recorded on madarch-9jo as `check:` comments and in its acceptance record.

## DONE WHEN
check-docs runs from the local hooks on real documents, each phase rejects its
planted violation, and the integration doc no longer says the gate is not
installed.
