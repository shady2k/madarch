# madarch-mwhd.3 — bounded primary-source research

Research completed 2026-10-25, 15:37 UTC. Decision support only; **no implementation or dependency choice is accepted by this note**. Read-only inspection of the requested worktree's `package.json`; official-owner HTTP documentation/source requests only. No local project imports, package installation, runtime probes, tests, builds, paid service, tracker mutation, or repository writes. No compiled-binary or cross-platform compatibility has been tested.

## Recommendation in one view

Use **syntax facts → explicit binding/origin resolution → declarative library models → evidence-backed graph facts**. Do not substitute another source-text pattern system for regex. Tree-sitter supplies syntax, not automatic project-wide name binding. CodeQL is a design reference for models-as-data, not a recommendation to run/adopt its security analysis engine. Its own JS customization API is explicitly beta. [C1, C2, T1–T4]

Minimum candidate set, subject to later acceptance:

| Format | Candidate/API | Why this is a real parser; limits |
|---|---|---|
| Source code | Existing `web-tree-sitter` 0.25.10, existing grammar WASMs; `new Query(language, source).matches(node)` / `.captures(node)` | Grammar CST and query captures, not source-line matching. Binding/origin resolver is separate work. Existing WASM collection is not evidence that every required grammar exists or is compatible. [T1–T6] |
| SQL, explicit multiple dialects | `node-sql-parser`; `new Parser().parse(sql, { database, trimQuery: false, parseOptions: { includeLocations: true } })`, or `astify` for AST alone | Multi-statement AST, dialect selector, location option. `parse` also returns table/column lists. Do **not** let its default MySQL dialect determine unknown input. Full dialect/DDL/procedural-language coverage is unverified; unsupported syntax must stay visible, not silently regex-fallback. `trimQuery: false` matters for offsets because source defaults to trimming the query. [S1–S3] |
| Prisma schema | **Provisional** `@mrleebo/prisma-ast` / `getSchema(source, options?)`; do not commit unconditional adoption yet | Chevrotain grammar and AST for schema blocks/fields/attributes, optional locations. Explicitly does not validate schema correctness. Import-time configuration search and location-option mismatch require resolution before use on untrusted repositories; see below. Official `@prisma/prisma-schema-wasm` is a bounded alternative evaluation, not a proven interchangeable AST API. [P1–P7] |
| YAML | Existing `yaml` 2.9.1, `parseDocument` / `parseAllDocuments`, node traversal and diagnostics | Document API retains structure/ranges and exposes errors/warnings; choose explicit schema/version/alias policy. Do not only call `parse()` and discard evidence/errors. [Y1, Y2] |
| JSON | Native `JSON.parse(source)` | Real standard parser without executing/importing the file. Standard API returns values, not source-node ranges. Emit file/document-level evidence unless a separate grammar supplies actual spans. JSONC is not automatically JSON. [J1] |
| TOML | Native `Bun.TOML.parse(source)` | Confirmed in **pinned Bun 1.4.2** source declarations/docs, not just rolling documentation. Returns values; no public CST/span API established. Integers outside JS safe range throw; date/time types are Temporal objects. If precise source spans are required, validate a TOML syntax grammar as a separate evidence adapter. [B1, B2] |
| Dockerfile | `dockerfile-ast`, `DockerfileParser.parse(content)` | Typed instructions/comments, source ranges and variable APIs. Parser supports escape directives/continuations and ARG/ENV lookup; bare CR is unsupported. Parsing instructions is not evaluating shell commands, downloading images, or proving runtime effects. [D1–D3] |
| Makefile | **`tree-sitter-grammars/tree-sitter-make`** v1.1.1 release's `tree-sitter-make.wasm` via existing web binding | Real GNU-Make-oriented syntax grammar; rule/targets/prerequisites/recipes/assignments nodes. README explicitly says syntax-highlighting purpose, custom `.RECIPEPREFIX` and load directive missing; other Make dialects may differ. Static syntax is not Make expansion/evaluation or shell execution. Use pinned WASM artifact, not package native addon main. [M1–M4] |

### Bun/binary compatibility: documented basis, not measured success

Pinned Bun 1.4.2 documents `--compile`, bundled imports/packages/runtime, and binary-file embedding with `import wasmPath from "./processor.wasm" with { type: "file" }`, `Bun.file(wasmPath).arrayBuffer()` and `WebAssembly.instantiate`. Tree-sitter 0.25.10 documents `Parser.init`, `Language.load`, parser/language setup; its actual `Language.load` accepts `string | Uint8Array`. `Parser.setLanguage` checks ABI compatibility and throws outside its supported range. These are a plausible integration path, **not proof that Madarch's builds/loaders work**. Both engine WASM and each grammar asset must be bundled and loaded offline from the final binary. Do not assume old prebuilt collection or current-main grammar ABI works without checking the pinned assets. [B3, T3–T6]

The JS candidate metadata shows JS entrypoints/dependencies rather than application-level native addon APIs for SQL/Dockerfile/Prisma AST. This is compatibility rationale only. Prisma AST currently declares Node >=22; Bun's actual execution/build behavior, transitive dependency code generation, configuration behavior and target-platform behavior remain unverified. Make's Node package explicitly has `node-addon-api`, `node-gyp-build`, `install: node-gyp-build`; use its official WASM release instead of bringing that native entry into Bun. [S2, P2, D2, M3]

## 1. CodeQL models-as-data: borrow the separation, not an approximation claim

**Established official schema.** JS extensions add tuples to named extensible predicates via `addsTo: {pack: "codeql/javascript-all", extensible: ...}` and `data`. Official JS docs support JSON/YAML, currently prefer JSON, and list `sourceModel(type,path,kind)`, `sinkModel(type,path,kind)`, `typeModel(type1,type2,path)`, `summaryModel(type,path,input,output,kind)`, plus barrier models. This is **JS-specific**; do not transplant the different Java/Kotlin column layout. [C1]

**Binding/origin is not taint.** An NPM package type starts at imports of that package. Qualified `package.Type` identifies instances using type annotations or `typeModel` definitions; it is not the same thing as the exported constructor/member itself. `typeModel` can define receiver instances from factory returns or callback parameters. Access paths include `Member`, `Argument`, receiver `Argument[this]`, `Parameter`, `ReturnValue`, `Awaited`, `ArrayElement`; call filters include arity and constant string argument conditions. CodeQL's API graph source explicitly starts at library imports, follows operations and maps them to dataflow nodes. It warns against overly specific code-pattern models. [C1, C3]

**Alias/receiver evidence needs an engine.** The schema does not magically resolve a locally renamed import, reassigned alias, shadowed identifier, wrapper return, or cross-module re-export. CodeQL provides semantic/dataflow machinery underneath the schema. Official type-tracking docs show why matching just a method name yields unrelated calls, why even local-flow call chains miss wrappers, and limits where stronger dataflow is needed. Madarch must state and implement its own bounded resolution contract, or emit unresolved/ambiguous rather than pretending syntax is binding. This is the design inference from the documented separation, not a claim to replicate CodeQL precision. [C2, C3]

**Taint is not identity.** In `summaryModel`, `kind: value` preserves a value/copy; `kind: taint` means derived but not necessarily equal. A security SQL-injection sink means an input is security-sensitive, **not** proof of a particular database/table/resource relationship. `Fuzzy` deliberately approximates package-derived objects; official docs say simpler but approximate. Do not use Fuzzy/bare member names as provenance proof. No need to implement a general taint engine just to resolve a bounded library receiver. [C1, C2]

**Proposed Madarch registry fields (recommendation, not CodeQL's exact schema):**

- Stable model ID/schema version, package identity (ecosystem/name/subpath and version scope if needed), import role (namespace/default/named/require), exported member/type identity, model-source URL and provenance.
- Required resolved receiver origin (import binding/factory return/constructor/callback parameter) and supported value-preserving propagation steps; do not infer origin just from text spelling.
- Typed call/member selectors; receiver/argument/callback-parameter/return selectors; explicit arity/constant constraints only when documented library API needs them.
- Separate origin propagation from optional value/taint summary semantics. Unknown computed members/dynamic calls are explicit unsupported or ambiguous cases.
- Emitted evidence contract: fact/relationship kind, source span/node, matched model ID/version, import/declaration/origin chain, argument extraction/parser and its span mapping, certainty/diagnostic reason.
- Entry-linked tests. No executable model callbacks, per-library inline method lists in code, or fixture-specific filenames, symbols, topics, tables, ports or paths. Library API identities/selectors belong in registry data; project facts come from parsed input.

**Per-entry testing:** official CodeQL `DataExtensions` tests put example source, extension tuples, checking query, and exact `.expected` results together. The connection example tests both annotated instances and a factory-defined type. This proves a testing pattern, **not** that upstream mandates every entry's coverage or that its fixture suite meets Madarch's acceptance. Official CLI query tests compare expected vs actual exactly. [C4, C5] Proposed Madarch gate: each registry entry has direct/aliased import positives, factory/constructor/callback origin where applicable, a renamed local binding, wrapper/cross-file case if supported, and negatives for shadowed local, unrelated receiver with the same member, wrong package, wrong argument/arity, dynamic unsupported form, and malformed embedded payload. Assert evidence spans and explicit omissions/diagnostics, not only edge counts. Parameterize this over registry entries so adding an untested row fails.

## 2. Tree-sitter boundary and source evidence

A Tree-sitter query is an S-expression pattern matching syntax node kinds/children/fields. Captures name matched nodes. `ERROR` and zero-width `MISSING` nodes require separate checks. Tree-sitter's own syntax-highlighting locals query uses `@local.scope`, `@local.definition`, `@local.reference` to track names for coloring; that feature does **not** establish module exports, package type identities, interprocedural alias resolution or runtime receiver types. [T1, T2, T4]

For the pinned web binding, use the actual `Query` API rather than assuming historical `Language.query` examples: source marks `Language.query` deprecated and exposes `new Query(language, source)`. `matches` retains pattern-grouped captures; `captures` returns captures. Query limits/progress controls exist. Parser and query failures, language/ABI mismatch, parse recovery and truncation must produce diagnostics; do not silently return a smaller graph. [T3, T4, T6]

**Proposed bound:** collect declarations/imports/exports/scopes/assignments/constructor/factory/call/member/argument facts from CST; resolve lexically scoped bindings and only documented value-preserving propagation; resolve cross-file module edges through explicit module rules. Persist unresolved candidates separately. Model predicates run against resolved fact IDs, not source strings. Embedded SQL is selected by a resolved API model, not by scanning all strings for SQL-like words. Preserve literal decoding/concatenation source maps; do not claim an exact SQL source span if decoding or dynamic substitution prevents it.

## 3. Candidate maintenance, licensing, and risks

These are **observed owner source/API snapshots**, not an audit or a guarantee of future maintenance. Default-branch package versions are not proof of published artifact identity. Pin eventual package/asset versions and hashes and retain license notices before adoption.

| Candidate | Observed owner metadata/source | Material constraint |
|---|---|---|
| `node-sql-parser` | package 5.4.0; Apache-2.0; newest default-branch commit observed 2026-07-19. [S2, S4] | Declared multiple dialects including PostgreSQL/MySQL/SQLite/TransactSQL/BigQuery etc.; Snowflake explicitly alpha. AST parsing is not DB validation, schema name resolution, all vendor extensions, stored-procedure analysis, or runtime query evaluation. [S1] |
| `@mrleebo/prisma-ast` | package 0.16.0; MIT; newest default-branch commit observed 2026-05-08; Chevrotain/lilconfig dependencies. [P2, P8] | README says AST shape is not fully documented and can change; no schema validation. Important safety issue below. [P1] |
| `dockerfile-ast` | package 0.7.1; MIT; newest default-branch commit observed 2026-04-21. [D2, D4] | Source ranges and typed instructions are established; complete newest Docker frontend/buildkit feature coverage and shell sublanguage analysis are not. [D1, D3] |
| `tree-sitter-make` maintained grammar organization | package/release v1.1.1; MIT; published WASM asset. Newest main commit observed 2026-02-26 regenerates with 0.26.6, so main and v1.1.1 are not interchangeable pins. [M1–M5] | Coverage limits stated above; runtime must check pinned grammar ABI. Do not claim latest grammar works with 0.25.10 without a probe. |
| Bun native TOML | Pinned bun-v1.4.2 declarations/docs establish API; no new package. Bun itself MIT, with bundled components separately licensed. [B1, B2, B4] | Values, not CST; safe-integer limit; no precise token evidence API established. |
| `smol-toml` (optional only) | Owner package 1.9.1, BSD-3-Clause, ESM/CJS exports; newest default-branch commit observed 2026-10-10. `parse(source,{integersAsBigInt:true})` documented. [O1–O3] | Not needed for minimum Bun stack; may be useful if BigInt/portable JS needed. No source-node-span API established. Defaults have datetime/Unicode/type-preservation caveats documented by owner. [O1] |
| Existing `yaml` | Exact 2.9.1 owner manifest: ISC, JS/browser exports. [Y2] | Explicitly inspect parser diagnostics; schema/version/merge/alias policy is a project choice. [Y1] |

### Prisma: do not hide the blocker

`getSchema` tokenizes, calls the grammar parser, checks parser errors and visits the CST. Types include models/views/types/datasources/generators/enums/fields/attributes and optional locations. The README suggests configuration key `parser.nodeTrackingLocation`; actual source type/default is **`nodeLocationTracking`**. Verify using actual source/API, not copying the README spelling. [P1, P3, P4]

More importantly, importing parser source creates `defaultParser = new PrismaParser(getConfig().parser)`. `getConfig` calls `lilconfigSync('prisma-ast').search()`; the README lists JS config among supported files. A read-only analyzer must not execute target-repository configuration. Merely passing options to `getSchema` does not establish that import-time search is gone. No safe packaging/isolation configuration was proven here. This is a **candidate adoption gate**, not permission to add an ad hoc regex fallback or silently skip Prisma. [P1, P4, P5]

Official alternative `@prisma/prisma-schema-wasm` packages the Prisma engine as Node/WASM and is Apache-2.0. Rust exports include `get_datamodel`, `get_dmmf`, `validate`, `lint`, references/hover etc. But its official README explicitly says the npm package is internal and API may break without warning. No stable generic CST/source-span API, packaged artifact pin, source mapping adequacy, environment isolation, Bun integration, binary embedding, or performance was established in this bounded read. Prefer a short dedicated acceptance probe/decision over a false promise. [P6, P7, P9]

## 4. Suggested later acceptance (not performed)

1. Inventory which claims are syntactic, origin-resolved, parser-derived, modeled, or unresolved. Eliminate source-text regex and per-library code conditionals in the chosen slice; unknowns remain reported.
2. Run a one-time walk on Madarch's own repository and a **second independent fixture/repository**, with expected facts and false-positive controls agreed before tuning. Show evidence links from real page/fact back to source/parser/model. Do not tune registry data to either fixture's private names.
3. Commit only portable fixtures created/held by this project. No committed test depends on an outside checkout or environment variable naming another repository; keep outside acceptance identity/revision only in acceptance evidence.
4. Exercise each selected dialect/format with multiline/comment/quoted-name/nested/invalid cases; test module alias/shadow/wrapper boundaries per registry entry. Treat any unsupported scope reduction as an explicit decision, not success.
5. On actual supported binary targets, prove all JS dependencies and engine/grammar WASM assets load offline from a compiled binary in a clean directory with no checkout/node_modules/system parser/compiler. Include malformed input diagnostics, ABI failures, safe no-execution config behavior, resource bounds, precise span or honestly file-level evidence. **No such command has been run here.**

## Exact primary sources opened

All following URLs were HTTP 200 when opened in this research. Content from mutable default branches is cited as a snapshot, not a package lock.

### CodeQL
- [C1] https://codeql.github.com/docs/codeql-language-guides/customizing-library-models-for-javascript/
- [C2] https://codeql.github.com/docs/codeql-language-guides/using-type-tracking-for-api-modeling/
- [C3] https://raw.githubusercontent.com/github/codeql/main/javascript/ql/lib/semmle/javascript/ApiGraphs.qll
- [C4] https://github.com/github/codeql/tree/main/javascript/ql/test/library-tests/DataExtensions ; concrete opened files: https://raw.githubusercontent.com/github/codeql/main/javascript/ql/test/library-tests/DataExtensions/connection.ext.yml ; https://raw.githubusercontent.com/github/codeql/main/javascript/ql/test/library-tests/DataExtensions/connection.example.ts ; https://raw.githubusercontent.com/github/codeql/main/javascript/ql/test/library-tests/DataExtensions/connection.ql ; https://raw.githubusercontent.com/github/codeql/main/javascript/ql/test/library-tests/DataExtensions/connection.expected
- [C5] https://docs.github.com/en/code-security/codeql-cli/using-the-advanced-functionality-of-the-codeql-cli/testing-custom-queries

### Tree-sitter
- [T1] https://tree-sitter.github.io/tree-sitter/using-parsers/queries/1-syntax.html
- [T2] https://tree-sitter.github.io/tree-sitter/using-parsers/queries/2-operators.html
- [T3] https://raw.githubusercontent.com/tree-sitter/tree-sitter/v0.25.10/lib/binding_web/README.md
- [T4] https://tree-sitter.github.io/tree-sitter/3-syntax-highlighting.html ; https://raw.githubusercontent.com/tree-sitter/tree-sitter/v0.25.10/lib/binding_web/src/query.ts
- [T5] https://raw.githubusercontent.com/Gregoor/tree-sitter-wasms/master/package.json
- [T6] https://raw.githubusercontent.com/tree-sitter/tree-sitter/v0.25.10/lib/binding_web/src/language.ts ; https://raw.githubusercontent.com/tree-sitter/tree-sitter/v0.25.10/lib/binding_web/src/parser.ts

### SQL
- [S1] https://raw.githubusercontent.com/taozhi8833998/node-sql-parser/master/README.md
- [S2] https://raw.githubusercontent.com/taozhi8833998/node-sql-parser/master/package.json
- [S3] https://raw.githubusercontent.com/taozhi8833998/node-sql-parser/master/src/parser.js ; https://raw.githubusercontent.com/taozhi8833998/node-sql-parser/master/types.d.ts
- [S4] https://api.github.com/repos/taozhi8833998/node-sql-parser/commits?per_page=1 ; https://raw.githubusercontent.com/taozhi8833998/node-sql-parser/master/LICENSE

### Prisma
- [P1] https://raw.githubusercontent.com/MrLeebo/prisma-ast/main/README.md
- [P2] https://raw.githubusercontent.com/MrLeebo/prisma-ast/main/package.json
- [P3] https://raw.githubusercontent.com/MrLeebo/prisma-ast/main/src/getSchema.ts
- [P4] https://raw.githubusercontent.com/MrLeebo/prisma-ast/main/src/parser.ts
- [P5] https://raw.githubusercontent.com/MrLeebo/prisma-ast/main/src/getConfig.ts
- [P6] https://raw.githubusercontent.com/prisma/prisma-engines/main/prisma-schema-wasm/README.md
- [P7] https://raw.githubusercontent.com/prisma/prisma-engines/main/prisma-schema-wasm/src/lib.rs
- [P8] https://api.github.com/repos/MrLeebo/prisma-ast/commits?per_page=1 ; https://raw.githubusercontent.com/MrLeebo/prisma-ast/main/LICENSE
- [P9] https://raw.githubusercontent.com/prisma/prisma-engines/main/prisma-schema-wasm/package.json ; https://raw.githubusercontent.com/prisma/prisma-engines/main/LICENSE

### Dockerfile / Makefile
- [D1] https://raw.githubusercontent.com/rcjsuen/dockerfile-ast/master/README.md
- [D2] https://raw.githubusercontent.com/rcjsuen/dockerfile-ast/master/package.json
- [D3] https://raw.githubusercontent.com/rcjsuen/dockerfile-ast/master/src/main.ts
- [D4] https://api.github.com/repos/rcjsuen/dockerfile-ast/commits?per_page=1 ; https://raw.githubusercontent.com/rcjsuen/dockerfile-ast/master/License.txt
- [M1] https://raw.githubusercontent.com/tree-sitter-grammars/tree-sitter-make/v1.1.1/README.md
- [M2] https://github.com/tree-sitter-grammars/tree-sitter-make/releases/tag/v1.1.1 ; opened release API listing its WASM asset: https://api.github.com/repos/tree-sitter-grammars/tree-sitter-make/releases/latest ; asset URL from API: https://github.com/tree-sitter-grammars/tree-sitter-make/releases/download/v1.1.1/tree-sitter-make.wasm (asset was **not executed/download-tested**)
- [M3] https://raw.githubusercontent.com/tree-sitter-grammars/tree-sitter-make/v1.1.1/package.json
- [M4] https://raw.githubusercontent.com/tree-sitter-grammars/tree-sitter-make/v1.1.1/src/node-types.json ; https://raw.githubusercontent.com/tree-sitter-grammars/tree-sitter-make/v1.1.1/LICENSE
- [M5] https://api.github.com/repos/tree-sitter-grammars/tree-sitter-make/commits?per_page=1

### Builtins / YAML / optional TOML
- [B1] https://raw.githubusercontent.com/oven-sh/bun/bun-v1.4.2/packages/bun-types/bun.d.ts
- [B2] https://raw.githubusercontent.com/oven-sh/bun/bun-v1.4.2/docs/runtime/toml.mdx
- [B3] https://raw.githubusercontent.com/oven-sh/bun/bun-v1.4.2/docs/bundler/executables.mdx
- [B4] https://raw.githubusercontent.com/oven-sh/bun/bun-v1.4.2/LICENSE.md
- [Y1] https://eemeli.org/yaml/
- [Y2] https://raw.githubusercontent.com/eemeli/yaml/v2.9.1/package.json
- [J1] https://tc39.es/ecma262/multipage/structured-data.html#sec-json.parse
- [O1] https://raw.githubusercontent.com/squirrelchat/smol-toml/mistress/README.md
- [O2] https://raw.githubusercontent.com/squirrelchat/smol-toml/mistress/package.json
- [O3] https://api.github.com/repos/squirrelchat/smol-toml/commits?per_page=1

Unavailable guessed documentation routes (404) were **not evidence**: old CodeQL testing guide paths, `using-api-graphs-in-javascript` guide, guessed `ModelsAsData` test directory; corrected to the official paths above. A guessed `smol-toml/main` path was corrected using owner repository metadata (`mistress`). No claim relies on those unavailable sources.
