# Keep registry examples at the contract boundary

Change: madarch-sqdd
Base: 195aaff555992397e802e522dc136d592662c088
Tasks: madarch-sqdd
Kind: no-behavior

## Intent
Keep the standalone contract examples neutral so madarch does not embed the skill set's kind vocabulary, and record where the set pins the schema and registry cases so a contract change is mirrored deliberately.

## Rationale
This is a documentation and fixture cleanup. The contract parser and registry behavior stay unchanged; the example remains a valid contract-1 registry, and each negative case still expects the same refusal. The decision note makes the cross-repository pin and deliberate mirroring visible without adding a dependency.

## Out of scope
- The skill set's own fixtures and pinned files; those remain owned by shady2k-skills.
- The wiki demo product, which may retain kinds written by the skill set.
- Runtime contract behavior and the published schema.

## Changes to requirements
None. This change updates examples and their test expectations without changing product behavior or the contract schema.

## Preserved contracts
- product-repository/contract: the registry reader and its accepted/refused case behavior remain unchanged; only example vocabulary and matching expected values are neutralized.

## Coverage
- product-repository/contract: test, contract:check, mutation, review

## Blocking questions
None.

## Design and decisions
Use neutral names, prefixes, and link fields in the madarch example registry and its registry case texts. Keep the case list and names unchanged. Decision 0021 names the skills set's pinned schema/case files and requires deliberate mirroring on a contract change.

## DONE WHEN
Registry examples and case text use no skill-set kinds, prefixes or link fields; all existing registry case coverage remains; decision 0021 names both pinned copies and says they are deliberately mirrored when the contract changes.
