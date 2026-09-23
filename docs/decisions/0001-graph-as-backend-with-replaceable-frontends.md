# 0001. The graph is the product; frontends are replaceable

Status: accepted
Date: 2026-09-24

## Context and problem
Diagram tools tie the architecture to one way of drawing it. Structurizr's fixed
C4 levels could not group by domain or zone, and large diagrams became
unreadable. We want the architecture to be data that people, documents and AI
agents can all use.

## Decision drivers
- Any agent or tool can read the architecture: raw, over HTTP, over MCP, from a graph database.
- No lock-in to one renderer or DSL.
- Views that group, filter and drill down.

## Considered options
1. Adopt a diagram DSL (Structurizr, LikeC4) as the model and add checks around it.
2. Keep our own graph as the source and export to renderers.
3. Keep only generated documents (Mermaid in Markdown).

## Decision
Option 2. madarch owns the graph and its semantics. Mermaid, LikeC4, our own
viewer, graph databases and MCP are frontends that read the compiled model.
A prototype exported one graph to both Mermaid and LikeC4 (`likec4 validate`
passed on the first attempt).

## Consequences
- We maintain our own format, its versions and migrations.
- Each frontend loses what it cannot express: for example, LikeC4 has no rules
  and renders zone grouping mixed with domain frames. It is a view, not the truth.
- Revisit if one frontend becomes the only one used and its model covers ours.
