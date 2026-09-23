# 0014. Principles of the model format

Status: accepted
Date: 2026-09-24

## Context and problem
A prototype of the format (29 elements, 25 relations, zones, rules, a flow) and
two external reviews found where a first design breaks.

## Decision
- **Relations at any level.** A relation may connect elements at the level of
  detail known; refining it into detailed relations is explicit, so a general
  relation and its refinements are not counted twice. Views collapse relations
  by projecting each end to its visible representative.
- **Interactions are nodes.** An interaction between two elements is a node
  with its own stable id, so flow steps, decision records, evidence and data
  transfers can refer to it; a direct edge is derived for simple queries.
- **Data transfers have a direction each.** One request carries a customer id
  forward and a profile back; each transfer names its direction and data.
- **Confidentiality and data categories are separate dimensions**
  (`confidentiality: internal`, `categories: [personal, payment-card]`).
- **Interfaces, contracts and channels are distinct:** the capability offered,
  the message or operation structure and version, and where it is reachable.
- **Memberships differ by kind:** domain ownership may inherit; zones and
  regulatory scopes are explicit, with inherit, add, exclude and replace, and
  exclusivity only within a defined scope.
- **Stable ids** survive renames and moves; ids never encode path, domain or kind.
- **External recipients need explicit permission** in data rules; nothing is
  exempt by kind.
- **Names of domain concepts refer to the glossary** (`termRef`); technical
  names stay technical.
- Hand-written YAML objects span several lines so that diffs stay readable.

## Consequences
- The format is richer than a diagram DSL; its schema and examples must stay
  small enough to write by hand.
- Revisit any principle that a real model cannot follow without duplication.
