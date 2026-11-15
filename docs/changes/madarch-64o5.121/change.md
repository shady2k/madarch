# Every agreed principle has a gate, and today's violations are debt that only shrinks

Change: madarch-64o5.121
Base: 39bf4ae12863dc42f0808cf0641d042f1e8d71b9
Tasks: madarch-64o5.121
Kind: no-behavior

## Intent
The owner read the three core audits (every entity a vertex and every pointer an edge; the principles against the core;
the tables) and asked for the opposite of a review: «Каждое нарушение принципа нужно сделать невозможным, нужен строгий
гейт.» The gates that need only the source live in `bun run check` (`scripts/check-architecture.ts`): each reads the
TypeScript syntax tree (`@swc/core`) or PostgreSQL's own parser (`libpg-query`), never a pattern over source text, and
each is held against `.architecture/violations.json` — a violation the list does not hold fails at once, an entry no rule
finds any more fails too, and a gained entry needs the owner's words in the commit (`Owner-decision:`).

The gates and today's debt entries (1 281 in all):

- `no-product-data` (307): a literal of the engine that equals a kind id, kind name or field name the starter catalogue
  alone declares, and an import of the engine from `catalog/`. The words the manifest format declares are the engine's:
  the gate reads them from the reader's own declaration in `src/product/manifest` — its vocabulary lists (`KIND_FIELDS`
  and the views, forms and languages beside it) and the properties its types declare — so `labels`, `description` and
  `definition` are not product data while a word only the catalogue holds is. Adopting that cut 315 of the gate's 622
  findings: they were the format's own words, and they left the list.
- `one-table-source` (25): a `CREATE TABLE`, read by PostgreSQL's parser, outside `src/adapters/schemas/graph-definition.ts`
  and `src/adapters/schemas/graph-contract.ts` — the graph core's installation and the generator from the manifest. A
  statement built across literals is reported as a table, never passed over.
- `catalogue-pointers` (128): a catalogue field declared `reference:` (a pointer held in a field, not an edge) or `json`
  without a closed form.
- `no-regex` (209): a `RegExp` literal, `new RegExp` or `RegExp(` in the engine; the approved list is empty.
- `extraction-boundary` (86): a file read (`node:fs`) or a process started (`node:child_process`, spawn/exec calls)
  outside the plugin host and the named infrastructure modules, each with why.
- `one-command-list` (0, takes no baseline): the command line's `COMMANDS` are exactly the closed list, so a new command
  is added to the list on purpose; a declared command the line no longer answers fails too.
- `route-aliases` (8) and `app-graph-reads` (26): a route table entry names a route of `src/knowledge/addresses.ts` and
  never spells a path, and a page imports no `read*` command — its data is the graph's, through GraphQL.
- `ui-kit-only` (105) and `i18n-text` (81): outside `components/ui` no intrinsic element and no `className` stand, and no
  JSX text or literal in a visible prop — every string is a locale key.
- `io-spans` (270): a call that reaches a file, the network, a database or a process stands inside `withSpan`.
- `one-state-machine` (0): a run's or a unit's state is written only by `src/fill/state-store.ts`.

Not built here, each for a stated reason: the PostgreSQL event trigger on `ddl_command_end` (it changes the store's schema
and belongs to the core redesign the owner filed it with); evidence required by type (the writer's types) and the
permission-typed action registry (the same); and the second half of the i18n gate — a server error body as a code with
parameters by type — which is the error contract's redesign, while the static half (JSX text and literal props) is
`i18n-text`. The UI checks live in this check's debt list rather than in `scripts/check/architecture/ui.ts`, because the UI
debt file's guard admits no gained entry at all: a gate adopted today needs the owner's decision the violations list
already carries.

## Out of scope
Fixing the debt: the list only shrinks, in later changes. The three type-level gates and the event trigger are named above.

## Rationale
A principle a reviewer has to remember is a rule nothing holds. The gates read the syntax tree, so a comment or a string
that looks like a violation is not one and a violation that hides inside a template is; the debt is written down, so a new
violation fails the first run and the old ones are paid off deliberately.

Mutation is not run on this branch: it is filed for the stage's assembled mutation run, as the stage rule has it.

## Changes to requirements
None.

## Preserved contracts
- product-wiki/app: the app still reads pages through /graphql and speaks English and Russian; the gates only refuse a page that leaves the kit or a string that leaves the locales.
- server/serves-wiki: the server still answers the routes section 8 keeps; the closed lists (commands, routes) are the same lists the running server already had.
- fill-orchestrator/plan: a run still plans and writes its state through the one state store; gate 11 only refuses a second writer.

## Coverage
- product-wiki/app: static, test, mutation, review
- server/serves-wiki: static, test, review
- fill-orchestrator/plan: static, review

## Where it is seen
Kind: command
Place: `bun run check` in a checkout, and `bun scripts/check-architecture.ts --rules` with one rule's name

1. `bun run check` passes on the tree with the debt lists as they stand, printing the count per gate.
2. A planted violation of any gate fails the same command, naming the rule, the module's full path and the line.
3. A new command, a new table, a new pattern-based parse or a new table-writing module fails without a list entry; gaining an entry needs the commit line Owner-decision with the owner's words.
