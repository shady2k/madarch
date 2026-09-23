# 0003. One graph across repositories, joined by normalized contract ids

Status: accepted
Date: 2026-09-24

## Context and problem
Systems are rarely monorepos. A service's code shows that it publishes to "the
topic in ORDERS_TOPIC"; who consumes it lives in other repositories.
Interactions must be visible across repository boundaries.

## Considered options
1. One central model; service repositories hold nothing.
2. Each repository owns a fragment; a list of repositories with pinned
   versions composes them.
3. Discovery only, as code-graph tools do (repowise workspaces,
   codebase-memory-mcp cross-repo links): no intended model.

## Decision
The graph is composed from a list of repositories (services, deployment,
contracts), each with a pinned ref. Fragments of the intended model may live in
the repositories or centrally. Every interface carries a **normalized contract
id**, the rendezvous point for providers and consumers from any repository and
any extraction tool:

```text
http::GET::/api/orders/{}
grpc::orders.v1.OrderService/Create
topic::order-placed
data::orders
```

Element ids are namespaced (`payments/api`) and stable across moves and renames.
Ownership: an element and the interfaces it provides are declared where they
live; a relation is declared by its initiator; domains, zones, data categories,
rules and cross-service flows at the graph level.

## Consequences
- Checks at the seams: a consumer of a contract nobody provides, a removed
  contract with consumers, duplicate ids. Unmatched references say why
  (no provider, internal only, unlinked, external host), after repowise.
- The contract-id vocabulary must be specified precisely (path normalization,
  topic naming per environment; see 0006).
- Revisit if contract ids fail to join facts from real tools.
