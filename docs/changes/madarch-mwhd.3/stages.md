# Proposed implementation stages and check ownership

Status: proposed. Task: madarch-mwhd.3. No tracker children created.
Each row below is one bounded worker-session work package, not permission to
implement or a new task ID. After approval, the coordinator must create real
stage/leaf records or split the current leaf without losing its claim/history.
Independent work may run in parallel only when files and required results do not
conflict. The current proposal session spawns no workers.

## Stage A — shared structural facts and safe asset/model foundation

Done when the existing code pass exposes one immutable resolved fact view and
query/model assets load deterministically; existing code truth checks still pass.

| Package | Owned area / result | Needs | Checks |
| --- | --- | --- | --- |
| A1 | CodeFacts value contract from current FileFacts/Site/Program, explicit driver consumer context and compatibility extractCode wrapper; no duplicate parse/resolver | approved proposal | parser-code-facts, parser-pinned-inputs |
| A2 | Structural query files and managed query capture runtime; exact fields, copied spans, explicit parse errors/limits | A1 contract | parser-code-facts, parser-evidence-regressions |
| A3 | Closed typed JSON registry, validator, evaluator contract and entry test catalogue | A1 contract | parser-registry-invalid, parser-registry-entries |
| A4 | Full source/query/registry guard and bypass fixture design; inventory every violation, no legacy exception | approved proposal; coordinate shared files | parser-source-guard, parser-guard-counterexamples |

A1/A2 share code files and run serially unless the coordinator defines disjoint
ownership. A3 and A4 can proceed in parallel after their contracts are fixed.
The guard may report migration debt during development; final CI is blocking on
the whole scope, not an allowlisted legacy subset.

## Stage B — first cohort required by PR #168

Done when metrics, loggers, symbol-sites, messaging and env use shared parsed facts
and typed models. All existing truth cases and the two final-review failures
pass. This stage is necessary but **not completion of madarch-mwhd.3** and does
not by itself remove the owner's full no-regex acceptance condition for #168.

| Package | Owned area / result | Needs | Checks |
| --- | --- | --- | --- |
| B1 | Replace symbol-sites text parsing; migrate function holders, import/binding/shadow/listener readers to CodeFacts, retaining exact canonical callback identities | A1/A2 | parser-binding-counterexamples, parser-evidence-regressions |
| B2 | Metric constructors/options/update/exposure and logger declaration/use models and consumers | A3, B1 | parser-registry-entries, parser-binding-counterexamples |
| B3 | Env read/default/requiredness structural facts and parsed definitions; no identifier/prose heuristics | A1/A3; dotenv gate | parser-format-matrix, parser-fixture-matrix |
| B4 | Parsed broker/address/server membership with full protocol/host/port; actual publisher/consumer invocation effects | A3; existing YAML; shared code roles | parser-fixture-matrix, parser-evidence-regressions |

B2 may be split into metrics and loggers if one worker session would be exceeded.
B3 and B4 can run in parallel on distinct files; shared registry entries are
assigned by explicit file ownership. B1 must move callers before deleting helpers.

## Stage C — contracts and data access

Done when route/client/message/SQL-flow facts use the common binding graph;
SQL/Prisma schema and query facts use accepted real parsers with exact evidence.

| Package | Owned area / result | Needs | Checks |
| --- | --- | --- | --- |
| C0 | Bounded primary-source and packaging/location probes for SQL, Prisma, protobuf and located JSON; select/pin only verified candidates | approved proposal; one session per unresolved parser | parser-package-walk, parser-format-matrix |
| C1 | TypeScript route/mount/listener/client/message facts and inline effects moved to query/registry + common resolver | A/B | parser-binding-counterexamples, parser-evidence-regressions |
| C2 | Go route/listener/client/message facts, package/receiver binding and models | A/B | parser-binding-counterexamples, parser-evidence-regressions |
| C3 | Contracts join layer, OpenAPI/AsyncAPI/JSON/protobuf parser adapter and exact operation/handler/source links | C0, C1/C2 fact contracts | parser-format-matrix, parser-fixture-matrix |
| C4 | SQL DDL/query adapter, explicit dialect choice and decoded-literal offset mapping | C0 | parser-format-matrix, parser-evidence-regressions |
| C5 | Prisma schema adapter with no import-time repository config execution; exact model/field/relation ranges | C0 | parser-format-matrix, parser-package-walk |
| C6 | Replace access.ts/go-calls.ts duplicate text/index logic with common facts; migrate data-model joins/discovery and preserve SQL source-to-builder-to-unsafe-sink evidence | C4/C5, A, C1/C2 | parser-evidence-regressions, parser-fixture-matrix |

C1 and C2 are independent after the shared contracts settle. C4 and C5 are
independent once their parser gates pass. C3 and C6 own different join layers;
coordinate registry/data files explicitly. If a parser gate fails, report it to
the owner with evidence rather than silently excluding the format.

## Stage D — remaining source readers and globally clean guard

Done when every inventory path and every source-reader dependency has its proper
parser/structural boundary; the guard runs as blocking CI over all `src/extract`
with no source exception. This is not a broad grandfathered allowlist stage.

| Package | Owned area / result | Needs | Checks |
| --- | --- | --- | --- |
| D0 | Bounded probes for Dockerfile, Makefile WASM, located TOML, dotenv, Go manifest and shell/argv parsing; pin grammar ABI/assets and no-execution policy | approved proposal | parser-package-walk, parser-format-matrix |
| D1 | Compose/deploy/build/workflow/endpoint command readers on accepted format ASTs and CodeFacts | D0, B/C listener contracts | parser-format-matrix, parser-evidence-regressions |
| D2 | Dependencies/stack/manifests/path/service discovery on real manifest parse and import facts; remove inline framework/platform catalogues | D0, A3 | parser-registry-entries, parser-fixture-matrix |
| D3 | Markdown file headings/newcomer structure through existing remark AST; commands through accepted parser, unsupported prose not guessed | D0 command boundary | parser-format-matrix, parser-fixture-matrix |
| D4 | Residual code tests/declarations/path/comment readers; history/Git fixed-format tokenizers reviewed individually | A/C; D2 catalogue contract | parser-source-guard, parser-evidence-regressions |
| D5 | End-to-end guard reconciliation, CI wiring, zero residual source-pattern violations including imported helpers/data/query assets | all migrations | parser-source-guard, parser-guard-counterexamples |

D1 is deliberately separable into deploy and build if its inventory exceeds one
worker session. D2/D3/D4 have independent files but share parser contracts.

## Stage E — freshness, packaging, cross-repository acceptance and hand-in

Done when implementation has passed its complete acceptance contract, not only
when examples look connected.

| Package | Owned area / result | Needs | Checks |
| --- | --- | --- | --- |
| E1 | Interpretation digest from actual query/registry bytes and parser identities, existing changed-set rebuild and offline binary assets | A assets; selected parsers | parser-digest-rebuild, parser-package-walk |
| E2 | Portable generated second fixture, renamed-layout variant, registry entry coverage matrix and exact negative answer key agreed before tuning | approved model contracts | parser-fixture-matrix, parser-registry-entries |
| E3 | One-time baseline/candidate audits on training, own pinned repository and different fixture; classify every removed fact, report all evidence/edge/gap changes and sampled false edges | all migration + E2 | parser-acceptance-audits |
| E4 | Exact-head CI, final-only PR review, requirement reconciliation with #168, principle/architecture updates at implementation, and acceptance report | D5/E1/E3 | static, test, review; named checks above |

E2 can start while parser consumers migrate; facts/negative controls are fixed
before tuning. E1 can begin after assets/identity contracts settle. E3 waits for
the integrated extraction. Mutation and exhaustive content walk remain at the
milestone-close point chosen by the coordinator, not repeated per PR. Required
one-time extraction audits for this task remain explicit. No screenshot gate.

## Concrete acceptance matrix
- Code: aliased/default/named/namespace imports, re-exports where supported,
  same-name wrong package, destructured/nested parameter shadows, TDZ/local
  declarations, member-qualified suffix counterexamples, static versus dynamic
  access and callback references versus real invocation.
- Logger/metrics: actual package and receiver identity, factory-return roles,
  adjacent/multiline options, top-level versus nested decoys, updates by actual
  callback holder, registry/default membership and listener-bound exposure.
- Messaging/env: unsent constructed message, exact send/receive call, full broker
  address including port, ambiguous aliases, AsyncAPI membership, local builtin
  shadows, dynamic env key, true default and proved requiredness.
- Data/contracts: exact route receiver/mount/handler/listener authority, arbitrary
  cache get negative, external OpenAPI target negative, no invented database,
  helper/interface SQL roll-up, quoted DDL, composite/FK/index/ALTER, Prisma maps,
  decoded literal maps and unsupported dynamic SQL; retain injection flow.
- Formats/assets: multiline/comments/literal decoys, invalid syntax/dialect,
  non-ASCII/CRLF, YAML aliases/documents, protobuf multiline/options, Make recipe
  continuation, Docker escape/exec/shell forms, no config execution, offline final
  binary/grammar ABI and explicit missing-asset failure.
- Evidence/freshness: every exact origin/span, no silent first-wins loss,
  code-point ordering, dirty working-tree independence, same digest no-op and
  known-byte model/query change rebuild at same pin without Markdown changes.
- Guard: all 55 inventory files plus assets and imported source-reader helpers;
  literal/constructor/alias/import/custom-query/model-code bypasses fail. Only
  individually format-tested tool-output tokenizers may be exceptions.

## Audit protocol and stop conditions
Use the same hashed audit runner on pinned baseline and candidate. Retain fixture
hashes, source/model/parser identities, per-kind totals, no-edge/no-evidence counts,
exact removed/added keys, all gaps and semantic negative controls. Have the
coordinator review evidence-backed false-edge samples (Jev where agreed); counts
alone cannot excuse a missing promised fact. No outside checkout path, revision or
environment-variable dependency goes into committed tests.

Stop for unsafe parser configuration execution, absent exact evidence, unresolved
ABI/asset packaging, scope/digest changes or a required unsupported format. Report
file/line/full path in diagnostics and never a silently smaller success. Stages
are estimates by bounded work package, not a promise that uncertain parser
selection is already solved. Do not label the current standalone task implemented;
its eventual submitted/accepted/closed records follow the project protocol.
