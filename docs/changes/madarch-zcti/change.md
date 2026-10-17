# Background server for local product wikis

Change: madarch-zcti
Base: cae006585e57003534307b997d5006c408797661
Tasks: madarch-zcti.1
Kind: behavior

## Intent
A person currently must keep `madarch serve` attached to a terminal for each product. This change adds a detached server shared by all products in the products home, a product directory at `/products/{folder}/`, and commands to start, stop and inspect that server. It enables a product wiki to stay available after the command returns. Owner approval pending (coordinator), as required by `.brief.md`.

## Out of scope
- Installing a system service or surviving reboot.
- Changing the existing `new`, `init` or `serve` output/help contract until madarch-74k4.2.6 lands.
- Model-serving configuration, authentication, remote binding or multi-user access.

## Changes to requirements
- server (existing requirement `serves-wiki`): add local daemon mode which serves a products-home index at `/`, each product's wiki under `/products/{folder}/`, and its app/API under `/products/{folder}/api/...`; retain the existing single-product foreground `serve` at `/`.
- product-repository/daemon: add `madarch start`, `madarch stop`, and `madarch status`, with detached server state, safe stale-state recovery, reuse of an existing server and status facts.

### Scenarios
- Given two valid products in a scratch products home and a free port, when daemon mode starts, then `/` lists both and each wiki and API is reachable beneath its own `/products/{folder}/` base.
- Given a single product and a free port, when `madarch serve` runs in foreground, then the wiki and `/api/...` remain available at root paths as before.
- Given no daemon, when `madarch start --home <home> --port <free-port>` runs, then it returns with detached server state; a second start reports/reuses the address and does not create another process.
- Given a stale state file whose pid is not a live Madarch daemon, when start runs, then it replaces stale state and serves; it does not kill an unrelated process.
- Given a running daemon, when status and stop run, then status reports its address, pid, uptime and products, and stop ends that process and clears its valid state.
- Given the daemon app URL under `/products/{folder}/`, when the wiki app requests data, then its API calls use that path base; with `madarch serve` at `/`, API calls remain `/api/...`.

## Preserved contracts

## Coverage
- server/serves-products-home: daemon-routes, app-route-base
- product-repository/daemon: daemon-controls

## Blocking questions
None.


## Design and decisions
Per coordinator decision in `.brief-3.md`, the daemon home is `/`; each product is routed under `/products/{folder}/`, with its app pages under `/products/{folder}/p/...` and API under `/products/{folder}/api/...`. The app reads its base path once from its location, with empty base for the established root foreground mode. Daemon state is validated against the running process command before reuse or termination; a stale pid is never assumed to be Madarch.

## Acceptance evidence
- Focused root checks: `bun run check` and `bun test test/product-daemon.test.ts test/server-wiki.test.ts test/product-cli.test.ts`.
- Wiki app checks: `bun run check`, `bun test`, and `bun run build` from `wiki/app`.
- Independent read-only review: no findings after fixes.
- Owner approval: recorded on `madarch-zcti.1`; approved decision digest `ec4292603fe2b0c99ef76d7d20e72a6458c06e64b00d9ebf45936b3e45cc18c8`.
- `new`/`init` start-or-reuse wiring remains deferred follow-up; do not change their output/help until the dependent task lands.

## DONE WHEN
`madarch start`, `stop`, and `status` manage one detached shared local server; it lists all products at `/` and serves each wiki at its isolated prefix. Existing foreground `madarch serve` still serves at `/`. Tests use a scratch products home and free ports only.
