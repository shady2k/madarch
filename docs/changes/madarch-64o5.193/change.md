# The entity command reaches the store a running wiki owns

Change: madarch-64o5.193
Base: 898838c8755a5341923ecf16e24d022bde4e662f
Tasks: madarch-64o5.193
Kind: no-behavior

## Intent

A product's store is prepared by the process that owns it (decision 0024): an API or fill role asks its owner for the
schema it needs instead of creating one itself. `madarch mcp` already made that request the way a second command can —
it borrows the preparation service a running daemon publishes in the products home, the file
`.madarch-store-owner.json`, or owns the preparation itself when no daemon runs beside it. `madarch entity` did
neither: it opened the store as an attach-only role with no address and no token, so beside a running wiki every one of
its commands refused the store with

    the file graph under the product:1: the store needs its owning madarch process for schema preparation (src/product/store-preparation.ts)

and exited 2. The acceptance walk of O1 met exactly that: `create`, `update` and `delete` of an authored entity through
the CLI worked only when `MADARCH_STORE_OWNER_URL` and `MADARCH_STORE_OWNER_TOKEN` were exported by hand from the
descriptor file, which no person or script does.

The reading of "borrow or own" now stands in one place, `withStorePreparation(home, work)` in
`src/product/store-preparation.ts`, and both commands use it: `src/mcp/cli.ts` keeps its behavior through it, and
`src/product/entity-cli.ts` gains it. The rule is unchanged — the descriptor in the products home decides — so the
daemon that owns the store prepares it, and a command with no daemon beside it now prepares the store itself. The command's own layer is untouched: `create`, `update`, `delete`, `list` and
`schema` keep their arguments, their exit codes (0 done, 2 refused) and their field-level refusals, and a field the
kind declares given a value of another type still names the field and the reason.

No requirement changes.

## Out of scope

The wiki's own surfaces for authored entities (the write route, its reader and the missing New/Edit/Delete controls) and
the author named in the journal's reader-facing text; the store-owner protocol, its descriptor's name and the daemon's
lifecycle; the standalone `madarch serve` command, whose own owner scope is unchanged.

## Rationale

Two call sites of one rule must not be able to disagree: the MCP command knew the rule and the entity command did not,
and the difference was invisible until a person ran the second one beside a wiki. The decision belongs where the two
paths meet the descriptor, so a later command that reaches a store reads it in the same place and cannot repeat the
omission. Nothing else moves: the descriptor is read by the same code, the request is the same request, and the
owner's transaction checks are untouched.

## Preserved contracts
- product-wiki/serve: a running wiki still owns its products home's store and its preparation service, a command run beside it only borrows that service exactly as `madarch mcp` does, the command's own refusals keep their shape and their exit codes, and a command with no daemon beside it now prepares the store itself with no address or token taken from the environment.

## Coverage

- product-wiki/serve: static, test, review

## Where it is seen

Kind: command
Place: the `madarch entity` command in a terminal beside the products home's running wiki, with `--product` and `--home` naming the fixture product and home

1. Start the products home's wiki, then run `madarch entity create note --title First --product PRODUCT --home HOME` with no `MADARCH_STORE_OWNER_URL` and no `MADARCH_STORE_OWNER_TOKEN` in the environment: the entity is written and the command exits 0, where before it exited 2 saying the store needs its owning madarch process.
2. Run `madarch entity update note UID --field count=4`, `madarch entity list note` and `madarch entity delete note UID` with the same environment: each exits 0, and the listing shows the change and then the removal.
3. Run `madarch entity create note --title Second --count lots`: the command exits 2 and names the field (`count`) and the reason (expected integer).
4. Stop the wiki and repeat the first command: with no daemon beside it the command prepares the store itself and exits 0.

## Blocking questions

None.

## DONE WHEN

With a product's wiki running, every `madarch entity` action on that product's authored kinds is written and read
through the store the wiki owns, with no address or token set by hand, exits 0 on success and 2 with the field and the
reason on a refused value; and with no wiki running the same actions prepare the store and succeed.
