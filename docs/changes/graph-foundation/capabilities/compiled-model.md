# Compiled model

Capability: compiled-model

## Purpose
The normalized JSON every frontend and agent reads: a loaded intended model
with its references resolved, its zones worked out per environment and state,
and its contract ids normalized.

## Requirement: shape — The compiled model is published with its schema
When a valid model is compiled, the compiler shall produce `model.json` with a
schema version, the model's elements with their ancestors, interfaces,
relations and interactions with their refinements and transfers, zones,
categories, environments and states, validated against a published JSON
Schema.

### Scenario: compiled-validates
- Given: the reference example of the format
- When: it is compiled
- Then: the result validates against the published compiled-model schema and holds every element, interface, relation, zone, category, environment and state of the example

## Requirement: deterministic — Same model, same bytes
When the same model is compiled twice, from the same files or from the same
content split differently across files, the compiler shall produce byte-identical
output.

### Scenario: twice
- Given: one model
- When: it is compiled twice
- Then: the two outputs are byte-identical

## Requirement: effective-zones — Zones are worked out per environment and state
The compiled model shall give each element the zones it is in, in general and in
each environment, after inheritance, additions, exclusions and replacements,
so that a reader never repeats that computation.

### Scenario: per-environment-zones
- Given: `payments-api` inherits `internal`, adds `pci`, and adds `dmz` in production
- When: the model is compiled
- Then: its zones are internal and pci in general and in test, and internal, pci and dmz in production

## Requirement: presence — What exists where and when is explicit
The compiled model shall say for each element and relation in which
environments and in which states it exists, so that a reader can select one
environment and one state without the model's rules.

### Scenario: presence
- Given: `payments-stub` in test only and `billing-api` since to-be
- When: the model is compiled
- Then: `payments-stub` lists test as its only environment; `billing-api` lists to-be as its only state

## Quality requirements
- Performance: as for loading (intended-model).
- Data: the compiled schema has its own version; a change that breaks readers
  raises it.
- Compatibility and operation: the compiled schema is a public contract for
  frontends and agents.
- Reliability, security, usability: not applicable beyond intended-model.

## Context
Glossary: compiled model. Decisions 0001 (the graph as backend), 0014.

## Coverage limits
Rules and flows are not compiled yet.
