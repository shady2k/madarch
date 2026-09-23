# 0012. No authentication in the first milestone

Status: accepted
Date: 2026-09-24

## Context and problem
Architecture data is sensitive, but authentication and single sign-on would
slow the first milestone, whose users are the owner, CI and agents.

## Decision
No user authentication in the first milestone, with three safeguards: the server
listens on localhost unless configured otherwise; webhook signatures are still
verified; the HTTP layer is built so that authentication is added as one layer
without changing handlers.

## Consequences
- Anyone who can reach the server can read and trigger ingest.
- Revisit before any deployment reachable by more than its owner: API tokens
  with scopes first, then OIDC.
