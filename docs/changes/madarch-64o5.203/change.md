# The entity command answers a refusal without the engine's own location

Change: madarch-64o5.203
Base: 7f1bb9aac8ded6bc681f6a79d8aaaf1f5cdb2dc2
Tasks: madarch-64o5.203
Kind: no-behavior

## Intent

The built O1 acceptance edited an authored record with an invalid integer and read its refusal from the `madarch
entity` command: exit 2 and the field were right, but the reason began with the engine's own location in the compiled
bundle — `/$bunfs/root/…:1: field "queue_position": expected integer` — in the JSON answer and on
standard error alike. The command prefixed `import.meta.path` to every message that did not already begin with a
location (`src/product/entity-cli.ts`), and in a compiled binary that path is the bundle's own mount; a refusal that
already carried a location kept it, and a refusal wrapping another carried both, because each error names the module
that raised it (`src/graph/authored.ts`, `src/graph/validation.ts`). The acceptance saw the doubled form too.

A refused action now prints the reason alone, in both answers, and keeps what a person acts on: the field, the reason,
the conflict details where the refusal supplies them, the exit code 2, and any product location the reason itself
names (a product file and its line, a field path such as `/values/count`). A product location is kept even where the
product sits inside the checkout's own `src/` or `scripts/` folders, which the shared normalizer otherwise reads as
engine folders: the command knows the product folder it resolved, and a location below it belongs to the product. A
location's line number ends it — `path:12:` or `path:12:4:` — so a checkout folder whose own path holds a colon and a
space, like `…/rev: two/src/graph/validation.ts:1`, no longer defeats the classification. The command reaches the store
exactly as before through `withStorePreparation`, so a wiki running beside it still owns the preparation and a command
with no daemon still prepares the store itself. The engine's diagnostic — the location it names with `raise` or a
refusal class — stays where it is; only the entity command's printed answer changes.

## Out of scope

The `/$bunfs` path in `/api/problems` (`text.args.cause`, madarch-64o5.189); the messages the refusal classes build,
which the server log and the HTTP door already keep; the MCP door, which does not use this normalization — it emits
structured refusals through `GraphRefusal.toJSON()` and formats any other failure itself (`src/mcp/authored.ts`), so
its answers keep their own module location and an MCP change of its own would be needed.

## Rationale

The engine already has one place that decides what of a refusal a client reads: `stripEngineLocation` in
`src/server/engine-location.ts`, which the wiki's HTTP answers use (`wikiRefused`) and which knows the bundle roots of
every platform (`/$bunfs/`, `~BUN`, the checkout's `src/` and `scripts/`). The entity command was the one door that did
not use it: it added the engine's path where none was and left the engine's path where one was. Using the same
normalization keeps the two doors from disagreeing about what a refusal says, and stripping it until nothing changes
covers a refusal that wrapped another, without touching the errors themselves. What makes a path the engine's is the
root it starts with, so the two things that could hide a product behind an engine root are named: the folder the
command asked about (a product inside the checkout) and the line number that ends a location (a checkout folder with a
colon and a space in its path). A location whose line number is missing — an engine module's own message — ends at its
first `: ` when what follows is the reason, a phrase with spaces, and not another part of the path; and an error's name
before that separator is a bare identifier like `TypeError`, so a checkout folder named `ScratchError` keeps its colon
and space as part of the path.

## Changes to requirements

None.

## Preserved contracts

- product-wiki/serve: a refused `madarch entity` action still exits 2 and still names the field and the reason in its JSON object and on standard error; a successful action still exits 0, and an action beside a running wiki still borrows the store owner's preparation instead of starting its own. Only the engine's own location leaves the printed reason.

## Coverage

- product-wiki/serve: static, test, review

## Where it is seen

Kind: command
Place: the `madarch entity` command in a terminal, on a filled product's authored kind
1. Edit a record of an authored kind with a value of the wrong type (`madarch entity update task UID --queue_position bad`): the command exits 2 and its JSON `error` names the field and the reason, with no `/$bunfs` path and no bundle mount; without `--json` the first line on standard error is the same reason.
2. Refuse in a way that wraps another refusal, or name a product folder that holds no `workspace.yaml`: the answer
   keeps the reason and the product's own location — the folder, `workspace.yaml` and line 1 — and names no location of
   the engine. A product nested in the checkout's own `src/` or `scripts/` keeps its file and line too, in JSON and in
   plain text; so does a product whose folder path holds a colon and a space.
3. Run `madarch entity create`, `update`, `delete` and `list` beside a running wiki and again with none: each still reaches the store through the daemon or prepares it itself, as before, and a refused value still names its field.

## Blocking questions

None.

## DONE WHEN

`madarch entity` refuses a field value with exit 2, naming the field and the reason, in JSON and plain text, on a built
binary; no `/$bunfs` path, bundle mount or repeated engine location appears in either answer; a product location in the
reason is kept — including a product inside the checkout's `src/` or `scripts/` and a folder path holding a colon and a
space — while a genuine engine prefix is still stripped; and the daemon-assisted and standalone store paths and the
create, update, delete and list actions are unchanged.
