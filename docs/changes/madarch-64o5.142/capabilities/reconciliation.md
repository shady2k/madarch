# Plugin reconciliation

Capability: reconciliation

## Purpose
Plugin-owned source reconciliation.

## Requirement: deltas — Publish only source differences
The shared SDK compares canonical identities and values. Each writing starter uses this path. A complete source yields only explicit add, update or remove requests, with evidence; unchanged values yield no request. Partial or problematic extraction never retracts unseen facts. Duplicate identities fail rather than shrink the result.

### Scenario: source-changes
- Given: a source fixture with added, changed, removed and unchanged items
- When: each writing starter extracts and reconciles
- Then: it emits exactly add, update and remove, each with evidence

## Requirement: read-only — Refuse all mutations
The plugin manifest's readOnly flag is authoritative. The host refuses explicit writer calls and returned mutations from read-only plugins. Protocol v2 and returned mutation lists are not supported.

### Scenario: prohibited-write
- Given: a plugin declared read-only in plugin.json
- When: it calls the writer or returns mutation lists
- Then: the host refuses the mutation

## Requirement: evidence — Check current applicability
The graph read returns only the selected producer's current open opinions, including values and file evidence. Closed opinions remain historical. Current applicability checks report missing supporting source separately from unavailable historical evidence. This task does not create immutable source spans or reinterpret historical facts as false.

### Scenario: disappeared-source
- Given: an open opinion with evidence from an older revision and a closed historical opinion
- When: the supporting path disappears from the current tree
- Then: the current fact has an applicability problem and the closed historical opinion remains untouched
