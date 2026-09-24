# Model history

Capability: model-history

## Purpose
Keeping every version of every source's model with both time axes from the
first write, so that the graph as it was, and as it was known, can be read
back, and nothing is ever overwritten.

## Requirement: store-version — Storing a source's model at a commit
When a compiled model is stored for a source at a commit with the commit's
time, the history shall record each of the source's assertions (elements,
interfaces, relations, zone memberships, bindings, environments, states) with
the commit's time as the start of its valid time and the storing moment as the
start of its recorded time.

### Scenario: first-version
- Given: an empty history and a source `shop` whose model at commit `c1` (committed on 1 September) has three elements
- When: it is stored on 2 September
- Then: reading `shop` as of valid 1 September, known 2 September returns the three elements

## Requirement: replace — A new version replaces what the source asserted
When a newer commit of a source is stored, the history shall close the
assertions the source no longer makes (valid until the new commit's time,
recorded until the storing moment), open the new ones, and leave unchanged
ones as they are. Nothing is updated in place or deleted.

### Scenario: element-removed
- Given: `shop` at `c1` (1 September) with `legacy-billing`, and at `c2` (10 September) without it, stored on 11 September
- When: `shop` is read as of valid 5 September and as of valid 12 September, both known 12 September
- Then: `legacy-billing` is there on 5 September and not on 12 September

### Scenario: what-we-knew
- Given: the same two versions
- When: `shop` is read as of valid 12 September, known 3 September
- Then: `legacy-billing` is there, because on 3 September the history did not yet know about `c2`

## Requirement: idempotent — Storing the same commit twice changes nothing
If a source's commit already stored is stored again, then the history shall
record nothing new.

### Scenario: repeat
- Given: `shop` stored at `c2`
- When: `c2` is stored again
- Then: the history holds exactly what it held before, and every read returns the same

## Requirement: order-by-commit — Commits are ordered by their time, not by arrival
When an older commit of a source arrives after a newer one, the history shall
place it by its commit time and shall not let it replace the newer version.

### Scenario: late-arrival
- Given: `shop` at `c2` (10 September) stored, then `c1` (1 September) stored after it
- When: `shop` is read as of valid 12 September, known now
- Then: the result is the model at `c2`

## Requirement: sources — A graph is the union of its sources
The history shall hold any number of sources, and the graph at a time shall be
the union of their models at that time. If a source's model declares an id
another source's current model already declares, then storing it is refused,
naming the id and the other source.

### Scenario: two-sources
- Given: sources `shop` and `payments`, each stored once
- When: the graph is read as of now
- Then: it holds the elements of both, and a relation from `shop`'s element to `payments`' element joins them

### Scenario: id-clash
- Given: `payments` declares `payments-api`, and `shop` is stored declaring `payments-api` too
- When: `shop` is stored
- Then: storing fails naming `payments-api` and the source `payments`, and the history is unchanged

## Requirement: lossless — What is stored reads back as compiled
When a compiled model, environments and states included, is stored and read
back as of its commit's time, the history shall return the same compiled model.

### Scenario: round-trip
- Given: the reference example with two environments and two states, compiled
- When: it is stored and read back as of its commit's time
- Then: the model read back equals the compiled one

## Quality requirements
- Performance: storing a new version of a 10 000-element model takes under
  five seconds.
- Reliability and recovery: a version is stored in one transaction: all of it
  or none; a failed store leaves the history as it was.
- Data: append-only; retention is unlimited in this milestone.
- Security and data protection: no secret values (they are never in the model).
- Usability, compatibility: not applicable (a library).

## Context
Decisions 0007 (ingest replaces what a source asserts), 0009 (bitemporal log,
amended: in this milestone the log holds model versions).

## Coverage limits
A source is identified by a name given by its caller; how sources are added
from repository addresses belongs to the server (outcome 4). Extracted facts
join the history in the next milestone.
