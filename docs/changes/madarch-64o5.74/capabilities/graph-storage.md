# Graph storage

Capability: graph-storage

## Purpose
Checked identities and relations in the graph's common writer.

## Requirement: edge-endpoints — Edges obey their declared and stored endpoint kinds

The common writer shall refuse an edge when an endpoint kind is not allowed by its declared edge kind. A supplied uid shall belong to the kind the endpoint names. A resolved endpoint shall be active and in the write context. Refusal shall roll back the operation transaction, including other vertices and journal entries. The endpoint lookup shall lock nodes against concurrent retirement and carry an observability span.

### Scenario: endpoint-kind
- Given: an edge kind from parent to child
- When: an edge names other as either end's kind
- Then: the write is refused with the end, declared expectation, full writer path and line

### Scenario: uid-kind
- Given: a stored other vertex and an edge from parent to child
- When: either endpoint claims the other vertex's uid belongs to the allowed kind
- Then: the write is refused and the transaction leaves no new vertex, edge or journal row

### Scenario: inactive-end
- Given: a removed endpoint or an endpoint in another context
- When: an edge names it
- Then: the write is refused

### Scenario: valid-edge
- Given: active parent and child vertices in the write context
- When: the edge names their actual identities and kinds
- Then: the writer creates the edge

## Requirement: assertion-selection — Reads apply the recorded assertion rule

At a requested context, valid time and recorded cutoff, a reader shall select typed assertions in SQL. It shall first apply each pinned ancestor's recorded cutoff and choose the nearest applicable context for each source stream. Within a stream of subject, property, language, context and source, it shall select the last-recorded assertion covering the valid time. Across streams it shall select the latest valid-from, then recorded sequence. A retraction shall mask its own stream. Vertex and edge attributes, existence, labels, filters, ordering and totals shall use this same rule. Selection shall require no mutable selected-value projection, dispute pin, preparation step or read-time TypeScript judgement.

### Scenario: backdated-correction
- Given: a source has an assertion and later records a correction whose valid-from is earlier
- When: a reader selects a date covered by both after the correction's recorded cutoff
- Then: the correction wins within that source stream, while a cutoff before the correction retains the earlier answer

### Scenario: pinned-base
- Given: a branch pins its ancestor's recorded sequence before a resolution or reopening in the ancestor
- When: the reader selects the branch
- Then: later ancestor assertions and question-state changes are excluded, while local branch assertions remain visible

## Requirement: writer-judgements — The writer records resolutions and question state

The common writer shall make dispute, resolution and evidence-validity judgements at write time. A resolution shall be an ordinary typed assertion in a source stream distinct from the principal's ordinary corrections, valid from the start of the judged segment over its judged scope. Question state shall be recorded as assertions with the same temporal and context semantics as values. Readers shall read that state rather than recompute it. No new storage table or column shall be required for resolution selection.

An unchanged value with unchanged valid scope shall reuse its assertion header and attach the new pass, evidence and seen lineage. A changed value or valid scope shall not be discarded as a repeat. A write that changes the dispute shall reopen the question and append a retraction in the resolution stream in the same transaction, beginning where the change takes effect. A backdated change at or before the segment start shall retract the entire judged segment. Withdrawn or invalid justifying evidence shall also retract the entire segment. Evidence that is merely stale because a file is absent from the current tree shall not invalidate the resolution. The writer shall update affected unpinned child layers that hold their own assertion for the same slot.

### Scenario: repeat-retains-resolution
- Given: a resolved disagreement between sources
- When: the losing source repeats its value with unchanged valid scope
- Then: no assertion header is added for the repeat, its new lineage is retained, and the resolution remains selected

### Scenario: changed-value-reopens
- Given: a resolution over a disputed segment
- When: a source writes a changed value effective inside that segment
- Then: the writer records an open question and retracts the resolution from the change's valid-from, preserving its earlier valid-time and recorded-time history

### Scenario: winner-withdrawal-and-ordinary-correction
- Given: the resolver also has an ordinary correction in a separate stream
- When: the winning source withdraws its assertion and the writer closes the resolution
- Then: the question reopens and the resolver's ordinary correction remains available for selection

### Scenario: invalid-evidence
- Given: a resolution justified by evidence
- When: that evidence is withdrawn or found invalid
- Then: the writer retracts the resolution over its whole judged segment and records an open question; a recorded cutoff before the withdrawal still shows the resolution

### Scenario: stale-evidence
- Given: valid evidence for a resolution refers to a file absent from the current tree
- When: the evidence is stale but neither invalid nor withdrawn
- Then: the resolution remains in force and the evidence link can report its availability issue without changing the selected value

### Scenario: historical-resolution
- Given: a resolution recorded after the start of the judged segment
- When: a reader selects a valid time within that segment with cutoffs before and after the resolution record
- Then: the earlier cutoff shows the original disagreement and the later cutoff shows the resolution

## Requirement: page-query-budget — Lists read membership and page data in two queries

A nonempty generated list page shall read its membership, ordering and full filtered total in one SQL query and hydrate only that page's records in a second query. Membership and hydration shall use the same assertion-selection rule, including resolved labels and existence. Selection shall not require a refresh query or per-record evidence judgement. An empty page shall preserve the full filtered total without a hydration query.

### Scenario: two-query-page
- Given: a generated list with selected labels and existence assertions
- When: a reader requests a nonempty page
- Then: exactly two SQL queries return the page and total, independent of the number of records on the page

### Scenario: resolved-page-membership
- Given: a persisted resolution selects a label or false existence
- When: a new transaction lists or searches records
- Then: the resolved label participates in search and ordering, false existence excludes the record, and cursor pagination preserves the full filtered total
