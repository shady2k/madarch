# 0004. A source-agnostic core; extraction plugins emit atomic facts

Status: accepted
Date: 2026-09-24

## Context and problem
Facts come from code, Helm values, Kubernetes manifests, API specifications,
tracing, broker ACLs, code-graph tools and AI agents. The core must not know
any of them, and a new source must not require changing the core.

## Considered options
1. Built-in extractors in the core.
2. Plugins that emit finished relations (service A calls service B).
3. Plugins that emit atomic facts; the core joins them into relations.

## Decision
Option 3. A plugin reports only what it sees, as typed facts:
`provides` (an element provides a contract id), `consumes` (an element uses
an interface through an environment variable), `binds` (in an environment a
variable has a value), `resolves` (an endpoint belongs to an element instance),
`observed` (runtime traffic), `coverage` (what was read and what could not
be). The core joins chains into relations and keeps the chain as evidence.

Plugins are separate processes speaking JSON over stdin/stdout: `describe`
(capabilities, protocol version) and `extract` (request in, a stream of JSON
lines out). Every fact carries its source (plugin@version, repository@ref,
file and line) and the basis of its valid time. Output plugins (Mermaid,
LikeC4, graph databases) read the compiled model the same way.

Amended 2026-09-24 by the revised MVP charter (madarch-tid): the first
milestone has no extraction plugins or facts. An agent skill writes the
intended model with its own tools and names its evidence; plugins arrive in
`live-graph`. The decision stands for them.

## Consequences
- Plugins are small, in any language, and licence-isolated: wrapping an AGPL
  tool's JSON output does not bind the core.
- Joining logic exists once, in the core, and must be well specified and tested.
- The fact schema is a public contract with its own version.
- Revisit if a class of sources cannot be expressed as atomic facts.
