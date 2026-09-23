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
