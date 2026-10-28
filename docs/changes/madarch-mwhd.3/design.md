# Proposed design: parser-backed repository facts

Status: proposed; no implementation permission or accepted ADR.
Base: `74b11a3fa5ef7b8240011535ffc895e4278d8828`.
Task: madarch-mwhd.3.

## Frame and drivers
The owner's frame is explicit: readers need general, true facts on any supported
repository. Missing facts with gaps cost less than wrong edges. The main path is
fill a pinned repository, read an entity and navigate to its actual source.

| Driver | Origin | Concrete response and check |
| --- | --- | --- |
| Semantic correctness | Owner 15:23/15:25 | Unrelated qualified logger/metric members create zero false edges; parser-binding-counterexamples. |
| Generality | Owner 15:25 | Rename layout and identifiers, change the supported library, keep rules unchanged; parser-fixture-matrix and three one-time audits. |
| Evidence fidelity | Existing extraction/publication contract and graph-truth proposal | Every semantic fact retains actual UTF-8 spans and every origin; parser-evidence-regressions. |
| Maintainability | Owner models-as-data rule | Every registry entry is typed, identifiable and behavior-tested; no inline package/method catalogue; parser-registry-entries. |
| Failure transparency | TreeReader/Extraction gaps | Malformed syntax, unknown role and unresolved value produce located gaps; parser-format-matrix. |
| Reproducibility | Existing pinned reader and rebuild lifecycle | Same pin/interpretation gives identical ordered facts; changed model bytes force fresh graph without Markdown changes; parser-pinned-inputs and parser-digest-rebuild. |
| Deployment | Existing Bun compiled binary | Assets work without a checkout or new runtime tools; parser-package-walk. |
| Growth | Cross-file resolution | A generated fixture with 10 times the small fixture's files is processed without cross-product joins; record time and memory, assert complete coverage, not a speculative new service-level target. |
| Security | Untrusted repository bytes | No repository code, Make includes, shell, schema generator or plugin executes; parser-format-matrix. |

Accuracy wins over recall. A real parser alone does not prove a data-flow edge.
No diagram or screen design is needed: this changes extraction facts behind the
existing JSON API, not presentation or graph storage.

## Current shape, grounded in the pinned source
- `extractCode(reader: TreeReader): Promise<Extraction>` in
  `src/extract/code/index.ts:112` returns graph records only. Its `FileFacts`
  and resolved `Site` types are private. They are not an existing public
  `CodeFacts` API.
- `Program`, `Binding`, `FileCtx`, `Ty`, declarations and `memberSites` in
  `code/program.ts`, `decls.ts`, `bodies.ts` already resolve repository types,
  lexical shadows, receiver fields and interface fan-out. `Binding` currently
  represents internal packages/named/default/namespace imports, not complete
  external-library receiver roles. Extend this model; do not pretend those
  external facts already exist.
- `extractFileSyntax` and `extractFileResolution` reuse the functional
  `readSyntaxTree(path, bytes, walk)` boundary at
  `src/fill/stages/syntax-extract.ts:253`. Its callback is synchronous and live
  nodes die when it returns (`tree.delete`, `parser.delete`). Queries run inside
  that lifetime. Only copied values/spans/binding IDs leave it. No cached Node,
  Tree, callback promise or Query capture with live nodes may escape.
- `extractOperations(tree, code?: Extraction)` currently builds `TreeText`.
  Operations functions read raw `text` and `lines`; metrics/loggers/symbol-sites
  perform regex scans. Contracts have AST walks but still mix source regex,
  name-only framework lists and hand-built constant evaluation. Data access,
  Go calls, SQL and Prisma have independent text readers.
- `TreeExtractor` in `driver/index.ts:75` currently accepts `(tree, code?)`.
  The driver at line 385 passes the preceding code `Extraction` to consumers.
  `TREE_READERS`/`EXTRACTOR_VERSIONS` identify readers by name and numeric version.
  Reuse that orchestration point; do not attach an undocumented property to an
  `Extraction`, add a global cache, or build a second resolver in operations.
- Existing libraries include `yaml@2.9.1`, JSON.parse,
  `web-tree-sitter@0.25.10`, `tree-sitter-wasms@^0.1.13`, `unified`,
  `remark-parse` and `remark-gfm`. SQL, Prisma, TOML, Dockerfile and Makefile
  parser packages are not declared at this pin. Existing
  `fill/stages/manifest-format.ts` readers are deliberately small subsets and
  include regex; importing them does not satisfy the owner's real-parser rule.
- Syntax grammars and runtime already use Bun `with { type: 'file' }` imports
  (`syntax-extract.ts:39–43`). `scripts/build-binary.ts` compiles the CLI.
  Additional query/model/grammar/parser assets need the same source/binary
  parity test, not assumptions about filesystem paths at runtime.

## Options and trade-offs

| Option and named pattern | Steady state and growth | Failure/security/operation | Decision |
| --- | --- | --- | --- |
| A. Shared Semantic Model, parser Adapters, models-as-data | One code identity/resolution model; consumers reuse immutable facts. Models add library knowledge without branches in each consumer. | A bad model can affect several producers, so typed loading and per-entry negative checks are essential. Parser adapters isolate dialect/asset failure. | Recommend. Best fit for exact binding and shared evidence. More up-front interface work than local fixes. |
| B. Pipes and Filters with a parser Adapter owned by each producer | Fewer shared interfaces initially, but repeats import/binding/receiver work and scales with producer count. | Drift makes the same call acquire different callers, spans and meaning. More parse assets and fallback paths to maintain. | Reject as the main shape. Format-specific adapters remain useful, but code consumers do not own independent parsers/resolvers. |
| C. Compiler-backed Language Services behind Adapters | Challenges the assumption that tree-sitter plus bounded resolution is sufficient. TypeScript/Go compiler semantics can improve recall. | Needs project toolchains/configuration and dependency resolution; potentially executes plugins or reaches network. Harder portable compiled CLI and bounded failure. | Not selected for this owner-directed migration. Consider later only for a measured unsupported case; no hidden fallback. |

Regex patches and inline method lists are not alternatives: the owner has
explicitly rejected them. Query captures do not replace semantic resolution.

## Proposed code-facts boundary
`CodeFacts` is a new public read-only value view **from the existing code pass**,
not an assertion about today's API. Keep `extractCode(reader)` compatible for
existing callers. Refactor its internals so the same pass can also return its
`Extraction` and `CodeFacts` to the driver; choose the smallest explicit typed
result seam at implementation after checking all callers. Update the driver's
consumer context explicitly. Do not use a second code extraction to populate it.
A compatibility wrapper may discard the view, but must not recompute the pass.

The view needs copied, sorted records for:
- File language, parse status, manifest/package scope and input identity.
- Canonical symbols and callable boundaries, including anonymous callbacks.
- Imports with actual specifier, exported name, local binding and manifest
  package identity; external packages remain external, not invented symbols.
- Lexical binding IDs, scopes, alias/value relationships and explicit unknowns.
- Member accesses with full receiver identity; calls with callee, argument
  captures, receiver binding/role, enclosing callable and exact site span.
- Static scalar/object/array literal structure and source-backed constant
  propagation needed by supported library selectors, never evaluated JS/Go.
- Resolution outcome and precise gaps. A member chain cannot match merely
  because its last two tokens equal a logger or counter name.

Reuse existing `SyntaxSpan`, `SourceSpan`, `FileSymbol` identities, resolution
roles and code-point order. Keep API design grounded in those actual types;
the list above is required information, not an invented implementation API.
No public graph schema or store API change is proposed.

### Structural query files
Language-specific `.scm` files capture declarations, call/member/selector
expressions, imports, lexical bindings, parameters, literal values and callback
boundaries. Exact AST node kinds and fields select structure. Query IDs and
capture names are checked against a closed schema. Do not use `#match?`, regex
predicates, arbitrary custom text predicates or pattern strings that rescan a
capture. Exact package/member/role selection happens against resolved fact data.
The query runtime creates/cleans queries within the existing parser lifecycle;
its exact `web-tree-sitter@0.25.10` API and asset loading are a bounded packaging
check before implementation. Never claim an untested Query API signature here.

### Registry and closed evaluator
Prefer repository-held JSON data: it has a built-in parser and deterministic
canonicalization. Each entry has a stable ID, ecosystem/package identity and
supported version scope where needed; exact exported/member selectors; receiver
or return-role transitions; argument positions/paths; effect kind; source
reference; and named positive/negative check IDs. Package paths and public API
names are library knowledge, not training-product rules.

The evaluator implements a small closed vocabulary: import/export identity,
argument selection, receiver role, return role, member access, literal/object
selection and effect emission. It is not CodeQL or a general expression engine.
Unknown selectors, duplicates and conflicting rules are errors. No JS snippets,
regex, eval, source matching, arbitrary plugins or method-name-only selectors.
Role propagation follows resolved aliases and bounded assignments/calls. When a
factory-return/parameter path cannot be proved, report a gap instead of broadening
it to every matching method. Platform builtins such as environment access also
require lexical/global identity, so a local `process`, `env` or `os` cannot borrow
builtin meaning. Go standard-library catalogues and test-framework knowledge
move out of inline code lists into versioned data with per-entry checks.

## Per-extractor inventory and intended migration
The inventory covers all 55 TypeScript files under `src/extract` at the pin.
Rows group related files without excluding helpers from the guard. Exact file
lists and content hashes are in `inventory.md`.

| Files / current behavior | Intended boundary | Cohort and concrete check |
| --- | --- | --- |
| operations/metrics.ts, observability.ts | CodeFacts constructor/options, receiver role, update/call sites, literal output parsed by its documented format; metric/logger/library effects in registry. No FromContext/WithLogger name inference. | First: unrelated qualified members, adjacent constructors, registry membership, actual updater callback. |
| operations/symbol-sites.ts | Delete text masks/delimiter/name parsers; use canonical callable spans, import binding and member/call facts. Migrate every caller, not a helper re-export of old scans. | First foundation: nested closures, destructuring, predeclaration shadows, implicit/explicit constructors. |
| operations/messaging.ts | YAML/AsyncAPI parser nodes plus declared broker technology data and real address parser; exact protocol/host/port evidence, no host-only collapse. Code publisher/consumer uses CodeFacts/registry. | First: same host/different ports, ambiguous aliases, unsupported channel membership, constructed but unsent message. |
| operations/env.ts | AST-resolved environment builtins and value/default/guard facts; YAML definitions stay parsed; dotenv gets a proper parser boundary. Do not infer requiredness from variable/function names or error prose. | First: process/os shadows, alias reads, dynamic key gap, real default and requiredness proof. |
| contracts/ts-code.ts, go-code.ts | Replace parallel name-based effects with shared calls/import roles. Route/mount/listener, HTTP/gRPC/Kafka and SQL-flow selectors are registry data. Scalar evaluation uses structural facts. | Next: grounded Express/net/http receiver, mounted router, parameter alias, callbacks versus calls, source-to-builder-to-unsafe-sink chain. |
| contracts/index.ts, symbol-links.ts | Join CodeFacts and parsed contracts with positive service/authority/listener/handler identity. Remove residual source regex and guessed main paths. | Next: external authority, unbound local route, callback handler, listener-port negatives. |
| contracts/openapi.ts, asyncapi.ts, proto.ts | Keep YAML AST including ranges; JSON equivalent uses located parse nodes. Replace regex protobuf reader with a real protobuf grammar/parser. No comment stripping substitute. | Next: multiline proto/rpc/options/comments; YAML anchors/multidoc, unsupported versions and server membership. |
| contracts/walk.ts, spans.ts, schema.ts | Structural helpers and identity/schema remain; literal decoding uses parser/token semantics and one UTF-8 span conversion. | Next: escaped literals and non-ASCII prefixes. |
| data-model/access.ts, go-calls.ts | Read resolved calls, callable holders and package/field paths from CodeFacts; remove lexical fallback and independent Go call index. SQL/Prisma API effects are registry data. | Next: anonymous callback ownership, helper/interface roll-up, unrelated database method, dynamic SQL gap. |
| data-model/sql.ts, prisma.ts, text-scan.ts | Real SQL dialect and Prisma parsers behind typed adapters, map parsed DDL/model nodes to existing records with exact locations. Delete scanners once no consumer remains. | Next: quoted/schema-qualified identifiers, composite keys, ALTER/FK/index, map/relation attributes, multiline/comment decoys. |
| data-model/extract.ts, keys.ts | Use parsed migration/config/schema and shared code data; no services-layout discovery or driver/env-name inference; parse SQL INSERT too. Preserve keys and complete evidence. | Next: manifest-root layout, no storage proof, literal query offset map, all evidence origins. |
| operations/compose.ts, deploy.ts | YAML AST plus real Dockerfile grammar; commands use supported shell/argv parser, started code from CodeFacts. No regex over instruction argument or source constants. | Remaining: exec/shell forms, multiline/escape/directives, probes/listener authority, unknown shell gap. |
| operations/build.ts | Real Makefile parser; YAML workflow AST; parsed package commands. Structural command/token boundary, no executing recipes/includes. | Remaining: continued recipes, multiple targets, variables/includes as explicit unsupported/resolved states, exact job spans. |
| operations/dependencies.ts, stack.ts | Parsed manifests + resolved imports; role/library catalogue in data. Shared go.mod/TOML readers must be real parsers, not imported regex subsets. | Remaining: aliased imports, indirect/version entries, non-services roots, unrelated dotted strings. |
| operations/newcomer.ts | Existing remark Markdown AST for headings/lists/code/links. Recognize declared document structure without training wording; command parser handles code nodes. Do not extract a guessed port/symptom from prose. | Remaining: alternate headings/layout, fenced decoys, explicit command target, unsupported prose gap. |
| operations/source.ts, index.ts, accumulate.ts | Pinned byte/parsed-file cache and explicit consumer fact context, manifest-root service ownership; accumulation/order/evidence stay. Paths use segment/extension operations, not regex shortcuts. | Foundation/remaining: arbitrary module roots, strict UTF-8 failures, same identity/order. |
| code/index.ts, decls.ts, bodies.ts, program.ts, resolve.ts, symbols.ts | Existing structural/resolution engine produces CodeFacts; remove residual regex over type/comment/manifest source. Extend external-package/alias/role provenance conservatively. | Foundation: all existing code truth cases, receiver-binding negatives. |
| code/source.ts, keys.ts, packages.ts, tests.ts, graph.ts | General path classification without regex; registry platform/test knowledge; comment structure parsed, not re-scanned. Existing graph algorithms remain. | Remaining: runtime builtin identity, test shadows, comments and false runners. |
| driver/files.ts | Existing remark parser for real Markdown headings, fenced code and comments; preserve heading spans/keys. No Markdown text regex. | Remaining: setext/ATX, fences, HTML, non-ASCII exact bytes. |
| endpoint-target.ts | Structured argv/shell-command parser and URL parser, exact command library model for HTTP flags. No joining argv then regex or inferring a URL from arbitrary prose. | Remaining: curl method flags, remote authority, unknown command gap. |
| history/{commits,index,git,time,files}.ts, driver/git.ts | Git fixed-format output tokenization only; repository bytes are not tool output. Validate pins/time/path fields without regex where practical. Any kept tokenizer is individually named and format-tested. | Remaining: NUL/record framing, unusual paths, malformed output, malicious repository byte payload next to tool tokenizer. |
| driver/{index,extractors,links,relationships}.ts, records.ts | Wire one facts context, preserve publication/normalization and origins; query/registry/parser digest enters existing freshness identity. These files are still guard-scanned. | Foundation/final: same digest no-op, changed known data bytes rebuild, all origin spans, no schema change. |

## Format adapter decisions and bounded research gates
Reuse installed YAML and remark ASTs; do not add parsers for formats already
covered. JSON.parse is a real parser but lacks member ranges: a source-located
JSON AST adapter is required where facts point inside a document; whole-file
ranges are not a replacement for required exact sites.

SQL, Prisma, TOML, Dockerfile, Makefile, protobuf, dotenv and embedded shell have
an explicit package/grammar choice gate. Research compares primary APIs,
license/maintenance, syntax/version/dialect support, error reporting, exact
ranges and Bun compile requirements. A parser that exposes only normalized
values must gain trustworthy token/range mapping or be rejected. Do not recover
locations with regex, indexOf on repeated names or heuristic line searching.

For SQL string literals, preserve the AST-decoded value and an offset map from
decoded SQL bytes to the source literal's actual bytes. Interpolation remains
structural segments/unknowns; no invented executable SQL. Prisma WASM/DMMF may
carry heavy assets or omit needed ranges; neither its brand nor a schema
formatter proves a usable located parser. Dockerfile parsing does not parse
shell RUN automatically, and Make parsing does not justify evaluating recipes.
These are separate gates with explicit unsupported gaps.

Each dependency gate is bounded to one worker session of primary reading and a
small packaging/location probe **after approval**, before dependent work starts.
If no candidate passes, stop with the unsupported syntax, candidate evidence and
options; do not silently reduce promised format coverage or approve speculation.
Exact candidates and verified primary citations are recorded in `sources.md`
when the parallel research result arrives. No dependency is installed by this
proposal.

## Full-scope CI guard
Recommended enforcement is conservative: forbid regex literal/RegExp capability
in extraction source and data/query assets, except narrowly reviewed fixed-tool
output tokenizers. Parse the engine's TypeScript to identify constructs, aliases,
imports and helper calls; inspect query syntax and registry schema structurally.
A renamed source reader, imported helper or model predicate does not evade the
rule. Scan source-reader dependencies outside this directory too when they are
used as parser adapters, so relocating old manifest scans cannot pass.

Use filename + line + construct/flow diagnostic. Guard fixtures exercise literal,
constructor, alias/helper/import relocation, query predicate and registry-code
bypasses, alongside exact AST captures that pass. No directory/glob legacy
allowlist. Path/classification/comment cleanup uses simple structural operations
or parser output; parsed source scalars are not a regex exception. Fixed Git
output exceptions name one callable, its immutable format contract and tests
that repository file bytes cannot enter it. Arbitrary dynamic evaluation is
forbidden rather than trusted as undetectable runtime magic.

During migration the inventory can report remaining violations; the final guard
has no suppressed legacy findings and blocks CI on all extraction source. Do not
call a partially scanned first cohort a clean full guard. The final integration
must enable the blocking global check before READY.

## Freshness, evidence and deployment
Canonicalize query IDs/file bytes and registry content in code-point order and
hash them with parser/adapter version identity. Include that digest in the
existing extractor-set interpretation identity (name plus version alone is not
enough). Do not widen the graph-store API. Existing changed-set handling rebuilds
the derived index; it must retain the previous working graph on failed staged
replacement and never alter people-written Markdown. Known-byte registry/query
changes at unchanged repository HEAD prove invalidation. Compiled binaries embed
the identical assets; missing/invalid assets fail instead of falling back.

Keep every origin, span and original discriminator through existing canonical
normalization. Preserve callback-reference semantics, shadowing, constructor/class
navigation, field read/write roles, interface fan-out, listener scope and
publication idempotence. Brokers use full protocol/host/port, never host-only
identity. Preserve all existing SQL-flow evidence until its owner changes it.

## Approval and limits
No architecture Codex review is requested: the owner's final-PR-only rule is
binding. The proposal is self-checked against the listed counterexamples, with
runtime and parser-compatibility claims explicitly unproved. Approve the shared
facts/registry/parser direction and stages; dependency choices still pass their
bounded verification gates. The final review, exact-head CI and one-time audits
are acceptance evidence, not evidence this draft claims to hold.


## Primary-source candidate conclusions (read-only research)
The companion `sources.md` records primary URLs, documented APIs, versions seen
in owner source and their limits. These are candidates, not installed pins or
compatibility results. This proposal's author also opened the decision-critical
primary API/source references before citing them; any remaining source claims
are explicitly the parallel research worker's attributed findings.

- `node-sql-parser`: documented Parser.parse/astify, explicit dialect and
  `includeLocations`; `trimQuery: false` is required to avoid implicit trim
  shifts. PostgreSQL/DDL completeness and Bun binary packaging remain unproved.
- Prisma: do **not** adopt `@mrleebo/prisma-ast` unconditionally. Its default
  parser calls getConfig at module import, whose lilconfig search can load JS
  repository configuration. Passing options to getSchema does not remove that
  import-time behavior. Safe isolation or a different parser is a blocking gate.
  Official Prisma schema WASM is an internal unstable API; generic located CST
  adequacy and binary assets are not established. Neither candidate is approved.
- `dockerfile-ast`: documented typed instructions/source ranges; shell RUN
  semantics remain separate. Native GNU Make is not executed.
- Make: maintained `tree-sitter-grammars/tree-sitter-make` v1.1.1 publishes a WASM
  asset. Use an ABI-checked pinned WASM, not its native Node addon. Its stated
  missing `.RECIPEPREFIX`/load support remains an explicit coverage boundary.
- Pinned Bun 1.4.2 provides TOML.parse values, not source spans; pair an accepted
  located syntax parser where exact entity evidence is needed. JSON.parse has
  the same location limitation. No guessed source search supplies missing ranges.
- CodeQL models-as-data is a reference for schema/role separation, not an engine
  dependency or a precision guarantee. Its Fuzzy/taint approximations are not
  receiver identity proof. Our bounded resolver must prove origins or emit gaps.
