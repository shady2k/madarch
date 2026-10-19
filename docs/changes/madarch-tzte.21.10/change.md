# A member of an object literal is named by the value the literal stands in

Change: madarch-tzte.21.10
Base: b5a232b9eba0ea0f92cf55015fdd9dde00ece3ef
Tasks: madarch-tzte.21.10
Kind: no-behavior

## Intent

The syntax stage names a declaration by what holds it (`OrderService.create`,
`Worker.run`), and it holds the list of containers that qualify a declaration
(`TS_CONTAINERS`, `src/fill/stages/syntax-extract.ts`). An object literal was not
on that list, and `holderName` named only arrow, class and function expressions:
so `const handlers = { save() {} }` published the symbol `save` at the *file's
own scope*, which is the one scope every bare mention of the file reaches.

Stage 4 resolves a mention by the declarations of the file it stands in, and a
declaration at the file's own scope shadows anything a bare name of that file
binds (`nearestDeclaration`, `src/fill/stages/resolution-facts.ts`). A bare
`save()` anywhere in that file therefore resolved to the object literal's method
— an edge between two symbols with nothing to do with each other, written at
precision `syntactic` as if this reader had tied the name down.

This change names an object literal's members by the value the literal stands in:

- **`src/fill/stages/syntax-extract.ts`** — an `object` is a container, and
  `holderName` names one by the value holding it (a variable declarator, a pair's
  key, a class field) exactly as it names an anonymous function or class
  expression. `const handlers = { save() {} }` publishes `handlers.save`;
  `const handlers = { nested: { reset() {} } }` publishes `handlers.nested.reset`;
  `class Store { handlers = { close() {} } }` publishes `Store.handlers.close`.
- **`src/fill/stages/syntax.ts`** — the stage's version moves to 3: what it writes
  changed, and a symbol's id is the digest of what the symbol is, its qualified
  name among it. The version enters a publication's identity
  (`publicationDigest`, `orchestrator.ts`); it does not sweep a store, so an
  existing product keeps the names and the one wrong edge this change removes
  until the units that wrote them are computed again — a file whose blob moves,
  which is how the landed design replaces what a store holds.
- **`test/fill-syntax.test.ts`** — a test of the extraction: the qualified names
  and kinds of an object literal's members, nested and in a class field.
- **`test/fill-resolution.test.ts`** — the test the task asks for: an object
  literal's method and a bare mention of the same name elsewhere in the file. The
  symbol rows it resolves against are stage 3's own (`syntaxFacts`), so the two
  modules' answers meet in one assertion: the qualification holds, the bare
  mention resolves to nothing, and it is out of this reader's claim — no edge to
  a guess and no coverage gap either, since nothing in the file binds that name.

What is not changed: what a symbol is (the same declarations, the same kinds, the
same spans, the same `defines` edges and definition occurrences) and what the
resolution resolves them to — only the container a member of an object literal
is named by. No fact kind, id rule or schema version moves.

## Out of scope

- The syntax stage's plan (madarch-tzte.21.9), the other finding of stage 4's
  review: what a plan re-reads. This change moves what one reading of a file
  answers and nothing of when a file is read again.
- The rest of the walk: what counts as an entry point, a test, an import or a
  comment is unchanged.
- The agent stages 8 to 13 of decision 0026, and the pages: nothing here renders
  what the graph holds.

## Preserved contracts

- product-wiki/pages: unchanged — a page stays the product's Markdown in git (0017); the syntax stage writes graph facts, no page reads them yet.
- release-binary/installers: unchanged — no dependency is added and nothing new is bundled; the walk is this repository's own reading of the same four grammars the compiled binary already carries.

## Coverage

- product-wiki/pages: test
- release-binary/installers: test

## Rationale

The kind is `no-behavior` because no requirement of this repository changes: the
fill's stages are not described by a current capability (`fill-stages` fixes the
stage contract, and the stage modules are madarch-tzte.21.1 to 21.7's), and what
this change fixes is one answer of one stage against decision 0026 already
accepted — a stage publishes what a file declares with the scope each declaration
stands in, and a resolver may only reach a member through the value that holds
it. That is also why no approval is owed: nothing here decides something a
person has not already decided.

The task offered two ways out — qualify the member, or state the ambiguity in
stage 4's recorded limits. Qualifying is the smaller answer and the honest one:
the graph holds the declaration under the name a reader would look for it by, so
nothing is lost and nothing false is claimed. What remains of the ambiguity is
stated below, because a limit that is not written down is a silence.

## Design and decisions

- **An object literal is a container, and its name is the value holding it.** The
  two rules that already existed for a named class or function expression
  (`HELD_EXPRESSIONS`, `holderName`) now cover `object`: a variable declarator
  names it (`const handlers = …` → `handlers`), a pair's key names it
  (`nested: { … }` → `handlers.nested`), a class field's name names it
  (`handlers = { … }` → `Store.handlers`). `TS_CONTAINERS` gains `object`, which
  is what the walk asks before it qualifies anything inside.
- **Why this removes the wrong edge, exactly.** Stage 4 binds a bare mention to
  the nearest declaration of that name whose container is a *lexical* scope
  (`isLexicalScope`: a function, a method, a module, a namespace, or the file's
  own scope). A constant, a variable and a field are none of them, so
  `handlers.save` shadows no bare name: a `save()` elsewhere in the file is out
  of this reader's claim rather than an edge to the member, which is the true
  answer — nothing in that file binds `save`.
- **A wrapper does not hide the holder.** A value an assertion, a `satisfies`, a
  non-null assertion or a parenthesis wraps is the same value, so
  `const handlers = { save() {} } as const` and
  `const handlers = { save() {} } satisfies Handlers` are the holder's too: the
  walk steps through the five wrapper kinds (`VALUE_WRAPPERS`, the list an
  anonymous default export already used) before it reads the holder. Without
  that, `satisfies` — common on an object literal with methods — would leave the
  members at the file's own scope and the wrong edge this change removes would
  stand.
- **The limit that stays, stated.** A value no name holds has no name to qualify
  its members by, and the members keep the scope around them: a member of an
  object literal that is a call's argument (`register({ save() {} })`), an
  array's element, an assignment's value (`o = { save() {} }`, the CommonJS
  `module.exports = { save() {} }` among them), a `return`'s value, or an
  `export default { save() {} }` stands at the file's own scope, and — inside a
  function body — at that function's scope. A bare mention of the name in that
  scope therefore still resolves to such a member. Reading the value it stands in
  out of the expression that holds it (a call's callee, an index, an assignment's
  target) is a guess this stage does not make, and dropping the member would lose
  a declaration the graph can name; the limit is the price of the smaller answer
  and is named here rather than left silent. `holderName` names a declarator, a
  pair's key and a class field, whatever wrappers stand between it and them, and
  nothing else.
- **The site count of a stage-4 edge is not affected.** A mention and a member
  are two different places, and the edge this change removes was one the file did
  not bind: no legitimate `call`, `reference` or `inherits` edge of a file whose
  members are whole changes.

## Acceptance evidence

The evidence is recorded on task madarch-tzte.21.10: `bun run check`, the focused
suites on the SkyPilot pod (`--avx2`, the tree-sitter grammars need it), the
feature document gate, green CI on the exact SHA, and one independent read-only
review round by a fresh `deepseek-v4.1-flash-auto` session.

The tests that hold it:

- `test/fill-syntax.test.ts`: an object literal's method, a nested object's
  method, a class field's object method and the same literal written inside an
  assertion and a `satisfies` are named `handlers.save`, `handlers.nested.reset`,
  `Store.handlers.close`, `wrapped.reset` and `checked.clear`, and no member of
  the file stands at the file's own scope.
- `test/fill-resolution.test.ts`: `const handlers = { save(): void {} }` with a
  bare `save()` in an exported function of the same file — the symbol rows come
  from stage 3's own `syntaxFacts`, the mention resolves to no symbol, no `call`
  or `reference` edge is written, and the file's coverage names no such gap.

Mutation is not run as a Stryker job: the owner's rule runs it once per assembled
stage, and acceptance escalates per `mutationFallback`.

## DONE WHEN

A member of an object literal is named by the value the literal stands in
(`handlers.save`), and a test with an object literal's method and a bare mention
of the same name elsewhere in the file holds that the mention resolves to no
symbol of the file.
