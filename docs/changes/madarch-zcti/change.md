# Background server for local product wikis

Change: madarch-zcti
Base: cae006585e57003534307b997d5006c408797661
Tasks: madarch-zcti.1
Kind: behavior

## Intent
A person currently must keep `madarch serve` attached to a terminal for each product. This change adds a detached server shared by all products in the products home, a product directory at `/products/{folder}/`, and commands to start, stop and inspect that server. It enables a product wiki to stay available after the command returns. Owner approval pending (coordinator), as required by `.brief.md`.

## Out of scope
- Installing a system service or surviving reboot (the service install is its own task after Monday).
- Changing the `madarch serve` foreground contract, or the `madarch new`/`init` output contract beyond not blocking: their accepted `new`/`init` wording stays the one madarch-74k4.2.6 landed; `--host` stays theirs alone where the shared daemon cannot honor it, because the daemon binds loopback only.
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
- Focused root checks (single `bun test` processes, free ports only): `bun run check` exit 0; `test/product-daemon.test.ts`, `test/product-cli.test.ts`, `test/product-serve.test.ts`, `test/server-wiki.test.ts`, `test/product-cli-script.test.ts` exit 0 (167 pass pre-fix, re-run green after the review fixes); `wiki/app`: `bun install --frozen-lockfile`, `bun run check`, `bun test` (174 pass), `bun run build` exit 0.
- The `new`/`init` start-or-reuse wiring is implemented against the contract madarch-74k4.2.6 landed (PR #52, `63eaa62b`): the commands return at once, print what happened, the address under `/products/<folder>/`, the SSH tunnel hint over SSH and the next step, and `--json` carries folder, id, name, url, pid, port and reused.
- Independent read-only review by a fresh `prime-agent --provider shady2k-gateway --model glm-5.3-flash-auto` session over `bee81955`: verdict `fail`, four findings, all fixed and tested — `--port 0` resolved to a free port instead of recording 0 and failing the readiness probe; `--host` refused on the daemon path (start, daemon-serve, new, init) naming what it accepts, kept on the foreground `serve`/`demo`, help and usage lines corrected; `--json` coverage added for `new` and `init`; this record corrected to match the landed wiring.
- Re-run after the fixes: `bun run check` exit 0; `test/product-daemon.test.ts` 7 pass; `test/product-cli.test.ts` 92 pass; `test/product-serve.test.ts`, `test/product-cli-script.test.ts` 121 pass.
- Coordinator's look follow-up (2026-10-17): the products home answered raw unstyled HTML; it now answers in the wiki app's own look — the app's built stylesheet at `/assets` (the same build the wikis read, so the same tokens and fonts), the shell's brand, toolbar and reading area, one card per product with the name and the one-line description the product itself declares (nothing where none is declared), and the wiki's language switch (en/ru over the same `madarch-wiki-language` storage key); the plain page remains the fallback where no built stylesheet exists. Test: `the home answers in the app's own look with product cards and a language switch` (`test/product-daemon.test.ts`, 9 pass).
- Owner approval: recorded on `madarch-zcti.1` (comments 4127, 4130, 4131; decision digest `ec4292603fe2b0c99ef76d7d20e72a6458c06e64b00d9ebf45936b3e45cc18c8`); the record correction after the dependency landed carries its own approval record naming the same owner decision.

## DONE WHEN
`madarch start`, `stop`, and `status` manage one detached shared local server; it lists all products at `/` and serves each wiki at its isolated prefix. Existing foreground `madarch serve` still serves at `/`. Tests use a scratch products home and free ports only.
