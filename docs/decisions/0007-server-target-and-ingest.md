# 0007. A server is the target; ingest is one idempotent operation

Status: accepted
Date: 2026-09-24

## Context and problem
The graph must stay current as many repositories change, and serve people and
agents. A command-line tool run in CI would be a second path to maintain.

## Considered options
1. CLI first, run in CI; a server later.
2. Server first; a CLI only where the server cannot reach the code.

## Decision
Option 2. The first milestone has no CLI. One operation,
`ingest(source, ref)`, updates the graph and is triggered by webhooks from
GitHub and GitLab (only the repository is taken from the payload, after its
signature is verified; the server fetches the ref itself), by a call from CI,
and by polling. Ingest is idempotent, orders by ref rather than arrival, and
**replaces everything a source asserts**: assertions the source no longer makes
are closed, not deleted (see 0009). A pull-request check is the same replacement
on a what-if overlay.

Amended 2026-09-24 by the MVP charter: the first milestone adds sources on
request by repository address (`POST /sources`); webhooks, CI calls and polling
come in the next milestone. The server remains the target.

Amended again 2026-09-24 (madarch-tid): in the first milestone a source is a
repository holding an intended model; ingest reads that model at a ref and
replaces the source's model version. Facts from plugins join ingest in
`live-graph`. The server also returns a view on request (`POST`, parameters in
the body).

## Consequences
- Operating a server (queue, retries, credentials) is needed from the start.
- Closed networks the server cannot reach need a runner that uploads facts;
  the ingest operation accepts ready facts for that later.
- Revisit if most adopters cannot run a server.

Amended again 2026-09-30 (change server-views, after the charter's revision
of 2026-09-29): in the first milestone the server reads no repository. The
send command, run beside the model check, sends a repository's compiled model
with its commit and commit time (`POST /models`); storing it is the ingest,
idempotent and ordered by commit time. `POST /sources` by repository address,
and decision 0011's cloning, wait for `live-graph`. The first consequence
below (a queue, retries, credentials) is deferred with them: the MVP's server
stores what is sent, synchronously, and has no authentication (decision 0012).
