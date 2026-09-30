# 0013. One graph per server, with a hidden graph id in storage

Status: accepted
Date: 2026-09-24

## Context and problem
An organisation may want separate pictures for products or business lines, but
shared services (authentication, event bus) belong to all of them, and the
interactions between products are often the most important question.

## Considered options
1. Several independent graphs ("landscapes") per server.
2. One graph per server; products and business lines are groupings inside it.

## Decision
Option 2. Products, business lines and domains are groupings and views of one
graph, so shared services exist once and cross-product interactions stay visible.
Storage carries a graph id column from the start, always `default` in the first
milestone and absent from the API and the model.

## Consequences
- Isolated organisations (a holding, a hosted service) need their own server
  until several graphs are supported.
- Revisit when isolation is required; the storage is ready for it.

## Amendment 2026-09-30 (change server-views)
For the MVP's server the owner kept one repository per graph and asked that
the architecture provide for a product of several ("Остаемся с одним для
MVP, но мы должны предусмотреть в архитектуре"). A graph is a named list of
sources; the server keeps one history per source and builds one query engine
per graph from the assertions of every source it lists. In this milestone
each repository sent is a graph listing only itself, named after it, so
repositories sharing an id (the reference system and nocx both declare
`platform`) do not refuse each other. Joining a product's repositories
(`live-graph`, madarch-bwt) adds graphs that list several sources, where a
clashing id is reported when the graph is built (decision 0003), without
changing how a source is sent or stored. The graph id column this decision
planned was never added; the list of sources takes its place.
