# Review: the madarch repository at commit 52991b993eaeb8e4661a6e1ac7ab117edb23a172

This review refreshes the model and its report against the rebased `.4.5`
revision at commit `52991b993eaeb8e4661a6e1ac7ab117edb23a172`. Claims and model
evidence are pinned to that committed tree; the model and report are the working
update. The accepted authoring decision is reflected: `write-intended-model` is
external to this checkout, and no local skill module or tracked skill path is
modelled. The capability spec that still says madarch ships the skill is recorded
as contradicted by the later accepted decision, not silently treated as current.

## Update d96746b..52991b9

- Refresh the architecture, vision, glossary, milestone, and decision claims for
  the updated mainline and SQL runtime removal.
- Re-pin current evidence, revise PGlite history and asynchronous SQL query
  claims, and cover the product-repository and served-wiki parts.
- Remove the nonexistent `skills/` assignment; keep `authoring-skill` external
  and cite decision 0016 plus the glossary, not the contradictory capability.
  The capability's conflicting requirement is recorded for review, not changed.
- Rebuild the Problems section from the current model-check output.

## Claims


| Claim | Document | Line | Commit | Blob | Checked in code | Verdict | In the model |
| --- | --- | --- | --- | --- | --- | --- | --- |
| The Model reads YAML intended-model files, validates intended and compiled models against schemas, and compiles a normalized model with code-point ordering | docs/system/architecture.md | 8-14 | 52991b993eaeb8e4661a6e1ac7ab117edb23a172 | e157846c9498d0ddfa62a756cca9c57b4dbb0949 | src/model/load.ts:404-412; src/model/compile.ts:43; src/model/order.ts:1 | confirmed | model-format |
| The Check validates a repository model and assignments/evidence, reports recognized problems, and optionally renders views | docs/system/architecture.md | 16-20 | 52991b993eaeb8e4661a6e1ac7ab117edb23a172 | e157846c9498d0ddfa62a756cca9c57b4dbb0949 | src/check/model-check.ts:756; scripts/check-model.ts:1-13 | confirmed | model-check |
| History stores source model assertions bitemporally in PGlite; it is idempotent and orders commits by commit time, not arrival | docs/system/architecture.md | 22-27 | 52991b993eaeb8e4661a6e1ac7ab117edb23a172 | e157846c9498d0ddfa62a756cca9c57b4dbb0949 | src/adapters/pglite-history.ts:82-105,182; src/history/types.ts:14-23 | confirmed | history-store |
| The asynchronous SQL query projection is rebuildable from history assertions; local compositions use PGlite and server compositions inject PostgreSQL | docs/system/architecture.md | 29-36 | 52991b993eaeb8e4661a6e1ac7ab117edb23a172 | e157846c9498d0ddfa62a756cca9c57b4dbb0949 | src/adapters/sql-query-database.ts:26-74; src/adapters/pglite-query-database.ts:55-64; src/adapters/postgres-query-database.ts:55-60; scripts/serve.ts:80-83 | confirmed | query-engine |
| The Renderer builds Mermaid and LikeC4 views for the check/wiki and renders one requested view for the server | docs/system/architecture.md | 38-42 | 52991b993eaeb8e4661a6e1ac7ab117edb23a172 | e157846c9498d0ddfa62a756cca9c57b4dbb0949 | src/render/view-set.ts:90; src/render/one-view.ts:101; src/server/http.ts:231-260 | confirmed | renderer |
| The static Wiki builds from a repository model and documents, offering LikeC4, Mermaid and archify | docs/system/architecture.md | 44-46 | 52991b993eaeb8e4661a6e1ac7ab117edb23a172 | e157846c9498d0ddfa62a756cca9c57b4dbb0949 | src/wiki/build.ts:274; scripts/wiki.ts:11; src/wiki/archify.ts:1 | confirmed | wiki |
| The Server stores submitted compiled models and answers requests; with a product folder it also reads pages read-only and serves that product wiki | docs/system/architecture.md | 48-55 | 52991b993eaeb8e4661a6e1ac7ab117edb23a172 | e157846c9498d0ddfa62a756cca9c57b4dbb0949 | src/server/http.ts:169-179,205-224; src/product-wiki/pages.ts:196-212 | confirmed | server |
| Product knowledge lives in a separate product repository whose lifecycle commands are madarch code; identity is read from workspace.yaml | docs/system/architecture.md | 57-67 | 52991b993eaeb8e4661a6e1ac7ab117edb23a172 | e157846c9498d0ddfa62a756cca9c57b4dbb0949 | src/product/draft.ts:1-15; src/product/lifecycle.ts:1-22,90-109; src/product/manifest.ts:464 | confirmed | product-repository; product-lifecycle |
| The Served wiki reads product Markdown from the working tree and uses madarch's React/Vite app; the server supports wiki-only, model-only and combined modes | docs/system/architecture.md | 69-79 | 52991b993eaeb8e4661a6e1ac7ab117edb23a172 | e157846c9498d0ddfa62a756cca9c57b4dbb0949 | src/product-wiki/pages.ts:196-212; src/server/http.ts:169-195; src/server/wiki-app.ts:174-182 | confirmed | product-wiki; server |
| A product document reaches readers without send/build; saved pages refresh in the served wiki | docs/system/architecture.md | 81-88 | 52991b993eaeb8e4661a6e1ac7ab117edb23a172 | e157846c9498d0ddfa62a756cca9c57b4dbb0949 | src/product-wiki/pages.ts:196-212; src/server/wiki-app.ts:174-182; wiki/app/ | confirmed | product-wiki |
| A checked compiled model is sent with source, commit and time; server SQL facades answer rendered views | docs/system/architecture.md | 90-97 | 52991b993eaeb8e4661a6e1ac7ab117edb23a172 | e157846c9498d0ddfa62a756cca9c57b4dbb0949 | src/send/send-model.ts:44-60,80-84; src/server/http.ts:169-174; src/server/graphs.ts:25-53; src/render/one-view.ts:1-9 | confirmed | send-command; server-views |
| The model server listens locally by default, without authentication; its routes store models, list sources and answer views | docs/system/architecture.md | 101-117 | 52991b993eaeb8e4661a6e1ac7ab117edb23a172 | e157846c9498d0ddfa62a756cca9c57b4dbb0949 | scripts/serve.ts:12; src/server/http.ts:129-141,169-174; no authentication in src/server/ | confirmed | server |
| Local histories are file-backed PGlite databases per source; the local query projection is shared PGlite, while server query composition uses PostgreSQL; old SQLite history is refused | docs/system/architecture.md | 119-129 | 52991b993eaeb8e4661a6e1ac7ab117edb23a172 | e157846c9498d0ddfa62a756cca9c57b4dbb0949 | src/server/sources.ts:1-9,51; scripts/serve.ts:80-83; src/server/http.ts:64-68; src/adapters/pglite-history.ts | confirmed | history-store; query-engine |
| Graphs borrow source-scoped SQL facades; the current milestone has one source per graph, with multi-source graphs supported by the graph layer | docs/system/architecture.md | 131-140 | 52991b993eaeb8e4661a6e1ac7ab117edb23a172 | e157846c9498d0ddfa62a756cca9c57b4dbb0949 | src/server/graphs.ts:1-7,30-53,99-; test/server-graphs.test.ts | confirmed | server; query-engine |
| A sent-source view is rendered from its graph SQL facade at current valid time and first architecture state | docs/system/architecture.md | 142-144 | 52991b993eaeb8e4661a6e1ac7ab117edb23a172 | e157846c9498d0ddfa62a756cca9c57b4dbb0949 | src/render/one-view.ts:1-9; src/server/http.ts:231-260 | confirmed | server-views |
| Madarch keeps product knowledge as a graph and wiki spanning intent and code evidence | docs/vision.md | 3-20 | 52991b993eaeb8e4661a6e1ac7ab117edb23a172 | 044216166874fd951a2727b00c52e7c6ba409970 | src/product/; src/product-wiki/; docs/system/architecture.md:57-79 | confirmed | madarch |
| The audience includes AI agents needing product knowledge as queryable data | docs/vision.md | 44-45 | 52991b993eaeb8e4661a6e1ac7ab117edb23a172 | 044216166874fd951a2727b00c52e7c6ba409970 | src/server/http.ts:169-174 exposes view routes; no MCP or agent-specific query interface is tracked | unconfirmed | coding-agent |
| A data catalogue, role-specific open questions and perspectives are outcomes | docs/vision.md | 184-190 | 52991b993eaeb8e4661a6e1ac7ab117edb23a172 | 044216166874fd951a2727b00c52e7c6ba409970 | src/model/schema.ts:316-334; src/wiki/pages.ts:514; src/product-wiki/questions.ts | planned | — |
| Local and central modes are intended; the central server federates product graphs and the same wiki serves people and agents | docs/vision.md | 219-228 | 52991b993eaeb8e4661a6e1ac7ab117edb23a172 | 044216166874fd951a2727b00c52e7c6ba409970 | scripts/serve.ts:80-83; src/server/graphs.ts:48-53; no MCP/federation; current query implementation is SQL | planned | server; query-engine |
| The deployment constraint is one offline Docker image with no runtime outbound calls | docs/vision.md | 260-263 | 52991b993eaeb8e4661a6e1ac7ab117edb23a172 | 044216166874fd951a2727b00c52e7c6ba409970 | no Dockerfile or image build in tracked HEAD | planned | — |
| The glossary defines Source and the origin-based name used for submitted models | docs/glossary.md | 122-125 | 52991b993eaeb8e4661a6e1ac7ab117edb23a172 | 46c72b452aca3a9a1b9a24ab023a93c523aa4e39 | src/send/send-model.ts:114-135 | confirmed | send-command |
| Extraction and output plugins are separate processes, neither currently built | docs/glossary.md | 177-187 | 52991b993eaeb8e4661a6e1ac7ab117edb23a172 | 46c72b452aca3a9a1b9a24ab023a93c523aa4e39 | no plugin host/protocol or output plugin in tracked code; renderer is in-process | planned | — |
| The query database is an asynchronous SQL projection, local on PGlite and server-injected PostgreSQL | docs/glossary.md | 192-195 | 52991b993eaeb8e4661a6e1ac7ab117edb23a172 | 46c72b452aca3a9a1b9a24ab023a93c523aa4e39 | src/adapters/sql-query-database.ts:26-74; src/adapters/pglite-query-database.ts:55-64; src/adapters/postgres-query-database.ts:55-60 | confirmed | query-engine |
| The glossary defines model check, review report, assignment table and model-writing skill as an external skill-set component, not a repository-local module | docs/glossary.md | 201-219 | 52991b993eaeb8e4661a6e1ac7ab117edb23a172 | 46c72b452aca3a9a1b9a24ab023a93c523aa4e39 | scripts/check-model.ts:1-13; no tracked skills/ path at HEAD; docs/decisions/0016-product-knowledge-base-direction.md:73-75 | confirmed | model-check; authoring-skill |
| The glossary distinguishes the static repository wiki from the served product wiki | docs/glossary.md | 225-232 | 52991b993eaeb8e4661a6e1ac7ab117edb23a172 | 46c72b452aca3a9a1b9a24ab023a93c523aa4e39 | src/wiki/build.ts:274; src/product-wiki/pages.ts:196-212; src/server/wiki-app.ts:174-182 | confirmed | wiki; product-wiki |
| The knowledge-base charter's outcome 1 proposed a versioned product contract and skill-set installation; it was later closed as moot | docs/milestones/knowledge-base.md | 16-33 | 52991b993eaeb8e4661a6e1ac7ab117edb23a172 | c68108477e44f96c9e4f23a15b2d69e3a6087405 | no generated versioned contract in tracked HEAD; decision 0017 supersedes outcome 1 | stale | — |
| Knowledge-base outcome 2 requires scenarios over model relations and classified data entities | docs/milestones/knowledge-base.md | 34-42 | 52991b993eaeb8e4661a6e1ac7ab117edb23a172 | c68108477e44f96c9e4f23a15b2d69e3a6087405 | src/model/schema.ts:316-334; src/model/validate.ts:581-622; madarch/scenarios.yaml; examples/reference-system/madarch/ | confirmed | madarch; reference-system |
| The knowledge-base charter planned a full linked product wiki and code index | docs/milestones/knowledge-base.md | 43-63 | 52991b993eaeb8e4661a6e1ac7ab117edb23a172 | c68108477e44f96c9e4f23a15b2d69e3a6087405 | src/product-wiki/ and src/wiki/ show partial wiki; no code index/plugin in tracked code | planned | — |
| Decision 0009 selected SQLite fact history and LadybugDB query runtime, but current implementation has PGlite history and asynchronous SQL queries | docs/decisions/0009-bitemporal-fact-log-and-query-engine.md | 25-35 | 52991b993eaeb8e4661a6e1ac7ab117edb23a172 | d3a0f7f110f1378389c29a24f184312af94f858c | src/adapters/pglite-history.ts:82-105; src/adapters/sql-query-database.ts:26-74; current architecture docs:22-36 | contradicted | history-store; query-engine |
| Decision 0016 puts authoring in the skill set and madarch's deterministic check/compilation/history/wiki/server in the engine | docs/decisions/0016-product-knowledge-base-direction.md | 40-54 | 52991b993eaeb8e4661a6e1ac7ab117edb23a172 | 65aff9c7d1ef665a63b503c884ee8c7e89244483 | no tracked skills/ path; scripts/check-model.ts; src/model/; src/server/; no MCP implementation | confirmed | authoring-skill; model-check; model-format; server |
| Decision 0016 states that the model-writing skill moves to the skill set and the engine ships none | docs/decisions/0016-product-knowledge-base-direction.md | 73-75 | 52991b993eaeb8e4661a6e1ac7ab117edb23a172 | 65aff9c7d1ef665a63b503c884ee8c7e89244483 | no tracked skills/ path at HEAD; the skill is external to this checkout; scripts/check-model.ts remains in madarch | confirmed | authoring-skill; model-check |
| The model-authoring capability says madarch ships an Agent Skills folder and check command | docs/system/capabilities/model-authoring.md | 5-17 | 52991b993eaeb8e4661a6e1ac7ab117edb23a172 | 9a68942030f0af75dc54998633380fb97fa906ff | no tracked skills/ path at HEAD; accepted decision 0016:73-75 says the engine ships none and authoring moves | contradicted | authoring-skill |
| The model-authoring capability says the skill sends a checked model to a named server | docs/system/capabilities/model-authoring.md | 89-97 | 52991b993eaeb8e4661a6e1ac7ab117edb23a172 | 9a68942030f0af75dc54998633380fb97fa906ff | scripts/send-model.ts:14; authoring skill implementation is external to this checkout | unconfirmed | send-command |
| AGENTS documents the madarch CLI for creating, serving and listing product repositories, plus repository checks | AGENTS.md | 12-22 | 52991b993eaeb8e4661a6e1ac7ab117edb23a172 | 2233e29f68dcf3d1fb4a47d8a22feacb95cbc9e5 | scripts/madarch.ts:1-10; src/product/draft.ts; src/product/lifecycle.ts; package.json:7-14 | confirmed | product-lifecycle; product-wiki; test-suite |
| madarch owns the graph and its semantics; Mermaid, LikeC4 and graph databases are frontends that read the compiled model | docs/decisions/0001-graph-as-backend-with-replaceable-frontends.md | 22-26 | f556d016491ce8f8abcda8afdc12ed4cb20d4329 | 92578fed355f443d33891d7dd8e9840d7715f793 | src/model/compile.ts:43 (the compiled model), src/render/mermaid.ts:82, src/render/likec4.ts:152 | confirmed | renderer |
| The intended model is restricted YAML in git, compiled from the repository, never owned by the server; a JSON Schema from the same source as the code's types validates it | docs/decisions/0002-intended-model-as-yaml-in-git.md | 16-21 | f556d016491ce8f8abcda8afdc12ed4cb20d4329 | f8cdf3ba60545c543a533e3217c2699b205deae0 | src/model/strict-yaml.ts:1, src/model/load.ts:412, schema/intended-model.schema.json:1 | confirmed | model-format |
| One graph across repositories is joined by normalized contract ids | docs/decisions/0003-federation-by-normalized-contract-ids.md | 19-23 | f556d016491ce8f8abcda8afdc12ed4cb20d4329 | 262af509cadbdfdfe256998bf0424c9fbaec5df3 | contract ids are normalized (src/model/contracts.ts); joining several repositories is not built: one graph lists one source (src/server/graphs.ts:1-24) | planned | — |
| Extraction plugins are separate processes emitting atomic facts; the first milestone has none and an agent skill writes the intended model | docs/decisions/0004-source-agnostic-core-with-fact-plugins.md | 30-33 | f556d016491ce8f8abcda8afdc12ed4cb20d4329 | 02dcfaf0f6f6b701e339abf1e60bc84ee1277876 | no plugin host in tracked code; decision 0016:73-75 moves the model-writing skill outside madarch; no skills/ path is tracked at HEAD | confirmed | authoring-skill |
| A relation binds to an environment through a variable name; secret values are never stored | docs/decisions/0006-environment-bindings-by-variable-name.md | 12-17 | f556d016491ce8f8abcda8afdc12ed4cb20d4329 | ca97ca2dc18e1da8c7708a4aeb54c8c3701a3b82 | src/model/schema.ts:172 (Binding), src/model/compile.ts (bindingByEnvironment) | confirmed | model-format |
| The server is the target; a send command beside the model check sends the compiled model with its commit and commit time, and storing it is the ingest | docs/decisions/0007-server-target-and-ingest.md | 40-45 | f556d016491ce8f8abcda8afdc12ed4cb20d4329 | cf90580c541b7f94c493f2eca744954685f93a5a | src/send/send-model.ts:44, scripts/send-model.ts:14, src/server/http.ts:169-174 | confirmed | send-command |
| madarch is TypeScript on Bun, with Bun-specific APIs confined to adapters | docs/decisions/0008-typescript-on-bun.md | 17-23 | f556d016491ce8f8abcda8afdc12ed4cb20d4329 | 2afba184449514c1bb0684497d199910bb4e81e1 | src/adapters/pglite-history.ts uses Bun-specific APIs in an adapter; src/server/http.ts:141 calls Bun.serve outside adapters; src/model and src/history hold no Bun API | contradicted | madarch |
| One Docker image runs the server with no outbound calls at runtime | docs/decisions/0010-single-offline-docker-image.md | 11-15 | f556d016491ce8f8abcda8afdc12ed4cb20d4329 | 89e49f3b82d4e8f40a8929ba7109e101d1acf510 | no Dockerfile or image build in the repository | planned | — |
| Repositories are read through plain git with read-only credentials by the server | docs/decisions/0011-repository-access-through-plain-git.md | 13-16 | f556d016491ce8f8abcda8afdc12ed4cb20d4329 | 9a873c77cf2ad3a01b70596e018734ff78aeec59 | the server reads no repository (src/server/ has no git call); cloning waits for a later milestone; the model check does read git locally (src/check/model-check.ts:130) | planned | model-check |
| There is no user authentication in the first milestone; the server listens on localhost unless configured otherwise | docs/decisions/0012-no-authentication-in-first-milestone.md | 11-14 | f556d016491ce8f8abcda8afdc12ed4cb20d4329 | 47a18addd5fbff41047c19551706a9021a6bd1e6 | src/server/http.ts:141 (127.0.0.1 default), no authentication anywhere in src/server/ | confirmed | server |
| A graph is a named list of sources with one query engine per graph; in this milestone each repository sent is a graph listing only itself | docs/decisions/0013-one-graph-per-server.md | 26-38 | f556d016491ce8f8abcda8afdc12ed4cb20d4329 | bb58bab99fd0203a46770bcd0a05030150d7ee74 | src/server/graphs.ts:1-24,199 | confirmed | server |
| The model format keeps relations at any level, interactions as nodes, transfers with a direction each, confidentiality separate from categories, and stable ids | docs/decisions/0014-model-format-principles.md | 11-32 | f556d016491ce8f8abcda8afdc12ed4cb20d4329 | 74d7320696927242d661d601df9a978773e9386b | src/model/schema.ts:138-186, src/model/contracts.ts, src/model/validate.ts | confirmed | model-format |
| Architecture states form one chain in the model; an element or relation may exist since a state and until a state | docs/decisions/0015-architecture-states-as-a-chain-in-the-model.md | 22-25 | f556d016491ce8f8abcda8afdc12ed4cb20d4329 | a7738f2da3111cb519375deff29fc1d6235c071c | src/model/schema.ts:306, src/model/validate.ts (isOneStateChain in src/history/assertions.ts:48) | confirmed | model-format |
| One set of wiki pages is built by either of two engines, Zensical or Starlight, chosen by --engine or MADARCH_WIKI_ENGINE, Zensical by default | docs/system/capabilities/wiki.md | 65-73 | f556d016491ce8f8abcda8afdc12ed4cb20d4329 | f6ad813153e83ebf34605df71392ab9d51248619 | src/wiki/build.ts:53,257,264, src/wiki/starlight.ts:226-274, src/wiki/zensical.ts:1-11 | confirmed | wiki |
| Every source has a stable server-assigned id surviving a rename; POST /sources records a rename claim and the old name never grows a second source | docs/system/capabilities/server.md | 115-133 | 52991b993eaeb8e4661a6e1ac7ab117edb23a172 | 343e6261397ba96b388c19d5005ef16c4beaf584 | src/server/http.ts:169-174, src/server/sources.ts:1-44 | confirmed | server-rename |
| A model declares data entities and use cases as scenarios whose steps follow the model's relations and name requirements; the check refuses a scenario whose relation or requirement is gone | docs/changes/use-cases-data-entities/change.md | 12-16 | 6fe034b2170733b322a93ab4c3f79f7a4acf751f | 6252e42c500f317d9dc82abc6249bf849aff3f28 | the loader at 14f9156 reads them (src/model/schema.ts:316-324 (ModelFile holds data entities and scenarios), src/model/validate.ts:581-622 (the loader checks a scenario's steps and alternatives), src/check/model-check.ts:268 (requirementFindings)) | confirmed | the five scenarios of this model |
| madarch gets its own model in `madarch/` at the repository root, written by the write-intended-model skill, with three to five main scenarios | docs/changes/use-cases-data-entities/change.md | 163-165 | 6fe034b2170733b322a93ab4c3f79f7a4acf751f | 6252e42c500f317d9dc82abc6249bf849aff3f28 | madarch/scenarios.yaml holds the five scenarios; `bun scripts/check-model.ts .` passes on this checkout | confirmed | madarch |
| The reference system's model gains data entities | docs/changes/use-cases-data-entities/change.md | 165 | 6fe034b2170733b322a93ab4c3f79f7a4acf751f | 6252e42c500f317d9dc82abc6249bf849aff3f28 | examples/reference-system/madarch/*.yaml carry nine data entities (madarch-hnq.2.1); test/reference-system.test.ts exercises them | confirmed | reference-system |

## Undocumented

- **uv and uvx**: the wiki's Zensical build runs `uvx zensical==0.0.66
  build` and probes `uv --version` first
  (`src/wiki/build.ts:311-314`, `src/wiki/build.ts:256-258`). No document
  under `docs/` names uv or uvx; the wiki capability names Zensical and
  its pinned version only. Modelled as the external `uv-uvx`.
- **Node.js as the wiki's archify runtime**: the wiki runs the vendored
  archify renderer with `node`
  (`src/wiki/build.ts:250-253`, probed at `src/wiki/build.ts:328-330`).
  The glossary's diagram tab names the vendored renderer
  (`docs/glossary.md:228-230`) but no document names Node as a
  requirement of the wiki build (the vendored `vendor/archify/README.md`
  does, and it is upstream's own text). Modelled as the external `node`.
- **The shady2k workflow tooling** (`.shady2k/`, `.githooks/`,
  `.github/workflows/ci.yml`, `.beads/`): the tracker integration, its
  checks, the git hooks and CI are a working system in this repository
  that no document under `docs/` claims; `AGENTS.md` and
  `.shady2k/integration.md` (its own document) describe them. Modelled as
  `build-tooling` under the `toolchain` layer.

## Assignment

| Path | Element | Reason |
| --- | --- | --- |
| `Formula/` | build-tooling | Homebrew formula packaging the release |
| `.beads/` | excluded | the tracker export; owned by the run's coordinator |
| `.gitattributes` | build-tooling | line-ending and diff rules |
| `.githooks/` | build-tooling | the local hooks of the shady2k workflow |
| `.github/` | build-tooling | the CI workflow |
| `.gitignore` | build-tooling | ignored paths |
| `.shady2k/` | build-tooling | the workflow integration and its checks |
| `AGENTS.md` | build-tooling | the machine-facing instructions; read for claims |
| `CLAUDE.md` | build-tooling | a pointer for agents |
| `README.md` | product-docs | the repository's front page; read for claims |
| `bun.lock` | build-tooling | the lockfile |
| `docs/` | product-docs | the product's own documents; read for claims |
| `examples/` | reference-system | the invented reference system, its model and its committed views |
| `madarch/` | excluded | the model and its review |
| `package.json` | madarch | the manifest: name, scripts and dependencies |
| `schema/` | model-format | the published JSON Schemas of the intended and the compiled model |
| `scripts/` | build-tooling | the command-line entry points and the view-check tooling |
| `scripts/check-model.ts` | model-check | the model check's command |
| `scripts/render-views.ts` | reference-system | renders the reference system's committed views |
| `scripts/send-model.ts` | send-command | the send command's command line |
| `scripts/serve.ts` | server | the server's command line |
| `scripts/wiki.ts` | wiki | the wiki build's command line |
| `src/` | model-format | the product's source; grouped by the elements below |
| `src/check/` | model-check | the model check and its problems |
| `src/history/` | history-store | the history's interface and assertion kinds |
| `src/index.ts` | model-format | the public interface of the whole library |
| `src/model/` | model-format | the loader, the compiler, the schemas, validation and ordering |
| `src/query/` | query-engine | the query engine's interface |
| `src/render/` | renderer | the view set, the Mermaid and LikeC4 renderers, one view on request |
| `src/send/` | send-command | the send command's logic |
| `src/server/` | server | the HTTP layer, the source stores and the graphs |
| `src/wiki/` | wiki | the wiki build, its pages, engines and the archify documents |
| `test/` | test-suite | the suite and its fixtures |
| `tsconfig.json` | build-tooling | the TypeScript configuration |
| `vendor/` | wiki | the vendored archify renderer the wiki draws with |
| `wiki/` | wiki | the Starlight template the wiki builds from |
| `src/adapters/pglite-history.ts` | history-store | PGlite history adapter |
| `src/adapters/sql-query-database.ts` | query-engine | Shared asynchronous SQL projection |
| `src/adapters/pglite-query-database.ts` | query-engine | Embedded local query database adapter |
| `src/adapters/postgres-query-database.ts` | query-engine | PostgreSQL server query database adapter |
| `src/adapters/sql-vector-index.ts` | query-engine | Shared SQL adapter for the caller-supplied vector index |
| `src/vector/` | query-engine | Caller-supplied vector record and search types |
| `src/product/` | product-lifecycle | Product repository manifest, git operations and lifecycle |
| `src/product-wiki/` | product-wiki | Product wiki pages read from the working tree |
| `wiki/app/` | product-wiki | Madarch product wiki app |

## Problems

From the model check at `52991b993eaeb8e4661a6e1ac7ab117edb23a172` (method, source, ids and finding text as reported):

- **unstable-dependency** (ids: `authoring-skill`, `madarch`, `skill-runs-check`): element "authoring-skill" depends on "madarch", which is less stable: I("authoring-skill") = 0.50, I("madarch") = 0.73 Method: Stable Dependencies Principle; Arcan Unstable Dependency. Source: R. C. Martin, Design Principles and Design Patterns (2000); F. Arcelli Fontana et al., Arcan (ICSA 2017).
- **hidden-coupling** (ids: `build-tooling`, `product-lifecycle`): elements "build-tooling" and "product-lifecycle" changed together in 9 commits (at least 5 within 180 days; commits touching more than 30 files are skipped as bulk changes) but no relation joins them; the newest commits: 8f700d5d819412b5c5167f96dcc31aeed0d04eed, afe7ef946e2bfe22fbda4e1d741b5b66644af1e0, 3488e8ef4357d9c2cdf7b5e7376221a16e12118b Method: modularity violation (co-change without a structural dependency). Source: R. Mo, Y. Cai, R. Kazman, L. Xiao, Hotspot Patterns (WICSA 2015).
- **hidden-coupling** (ids: `build-tooling`, `product-wiki`): elements "build-tooling" and "product-wiki" changed together in 14 commits (at least 5 within 180 days; commits touching more than 30 files are skipped as bulk changes) but no relation joins them; the newest commits: 8f700d5d819412b5c5167f96dcc31aeed0d04eed, 6f667cf0ef81b263ea73fa5316225102a841c8ce, d0af6cab054b9ec4eea690df81e7178231704517 Method: modularity violation (co-change without a structural dependency). Source: R. Mo, Y. Cai, R. Kazman, L. Xiao, Hotspot Patterns (WICSA 2015).
- **hidden-coupling** (ids: `build-tooling`, `reference-system`): elements "build-tooling" and "reference-system" changed together in 5 commits (at least 5 within 180 days; commits touching more than 30 files are skipped as bulk changes) but no relation joins them; the newest commits: afe7ef946e2bfe22fbda4e1d741b5b66644af1e0, 3488e8ef4357d9c2cdf7b5e7376221a16e12118b, ce35596e44e59f69e4eb0abea60ce69501e812ca Method: modularity violation (co-change without a structural dependency). Source: R. Mo, Y. Cai, R. Kazman, L. Xiao, Hotspot Patterns (WICSA 2015).
- **hidden-coupling** (ids: `build-tooling`, `server`): elements "build-tooling" and "server" changed together in 7 commits (at least 5 within 180 days; commits touching more than 30 files are skipped as bulk changes) but no relation joins them; the newest commits: a7c44744713b6b1c561e122f5f71a0b43f200e50, 48e8f09360ad44f992883b3856b234e362d2e39c, 0bb6c475d7410b0a7fc7a5b5ac50935d0619d3cf Method: modularity violation (co-change without a structural dependency). Source: R. Mo, Y. Cai, R. Kazman, L. Xiao, Hotspot Patterns (WICSA 2015).
- **hidden-coupling** (ids: `build-tooling`, `test-suite`): elements "build-tooling" and "test-suite" changed together in 25 commits (at least 5 within 180 days; commits touching more than 30 files are skipped as bulk changes) but no relation joins them; the newest commits: 8f700d5d819412b5c5167f96dcc31aeed0d04eed, f16eaf235282f91aa41e3a9bc1f6d7beef9d4154, 232c36a012a8989cac2177c8b2e5dea155e394b3 Method: modularity violation (co-change without a structural dependency). Source: R. Mo, Y. Cai, R. Kazman, L. Xiao, Hotspot Patterns (WICSA 2015).
- **hidden-coupling** (ids: `history-store`, `test-suite`): elements "history-store" and "test-suite" changed together in 15 commits (at least 5 within 180 days; commits touching more than 30 files are skipped as bulk changes) but no relation joins them; the newest commits: 5b901c8e8a513c817f28356456cb0119af18e55b, f2d05a3305f97eba4ef7fcd894708059ed926e02, 713c4d2084a93f872ba8d1e04ef77d86ae632a2d Method: modularity violation (co-change without a structural dependency). Source: R. Mo, Y. Cai, R. Kazman, L. Xiao, Hotspot Patterns (WICSA 2015).
- **hidden-coupling** (ids: `model-format`, `product-lifecycle`): elements "model-format" and "product-lifecycle" changed together in 10 commits (at least 5 within 180 days; commits touching more than 30 files are skipped as bulk changes) but no relation joins them; the newest commits: 41acc87245cca7e00af6a38443be3769cef386a0, 9da3abe7a53b4229848e87d35db410a31a8ceb41, afe7ef946e2bfe22fbda4e1d741b5b66644af1e0 Method: modularity violation (co-change without a structural dependency). Source: R. Mo, Y. Cai, R. Kazman, L. Xiao, Hotspot Patterns (WICSA 2015).
- **hidden-coupling** (ids: `model-format`, `product-wiki`): elements "model-format" and "product-wiki" changed together in 6 commits (at least 5 within 180 days; commits touching more than 30 files are skipped as bulk changes) but no relation joins them; the newest commits: 41acc87245cca7e00af6a38443be3769cef386a0, a9a518871f9407db983ec58750f9e21e69c83444, 05d08225e2d4bd3ec0162c80627e1906c1148143 Method: modularity violation (co-change without a structural dependency). Source: R. Mo, Y. Cai, R. Kazman, L. Xiao, Hotspot Patterns (WICSA 2015).
- **hidden-coupling** (ids: `model-format`, `query-engine`): elements "model-format" and "query-engine" changed together in 7 commits (at least 5 within 180 days; commits touching more than 30 files are skipped as bulk changes) but no relation joins them; the newest commits: f16eaf235282f91aa41e3a9bc1f6d7beef9d4154, 232c36a012a8989cac2177c8b2e5dea155e394b3, 2ea7ee200c13e28e4e56eb71fb75d9647472acd0 Method: modularity violation (co-change without a structural dependency). Source: R. Mo, Y. Cai, R. Kazman, L. Xiao, Hotspot Patterns (WICSA 2015).
- **hidden-coupling** (ids: `model-format`, `server`): elements "model-format" and "server" changed together in 14 commits (at least 5 within 180 days; commits touching more than 30 files are skipped as bulk changes) but no relation joins them; the newest commits: 605c1ac2fd0297d82e5c49523d028585c886f192, 501e2dedbe560b26c519c25139aedf02d273b999, 41acc87245cca7e00af6a38443be3769cef386a0 Method: modularity violation (co-change without a structural dependency). Source: R. Mo, Y. Cai, R. Kazman, L. Xiao, Hotspot Patterns (WICSA 2015).
- **hidden-coupling** (ids: `product-lifecycle`, `product-wiki`): elements "product-lifecycle" and "product-wiki" changed together in 10 commits (at least 5 within 180 days; commits touching more than 30 files are skipped as bulk changes) but no relation joins them; the newest commits: 8f700d5d819412b5c5167f96dcc31aeed0d04eed, f46a7f27e591a9e1e38deb4556512c6e1d1238d5, 41acc87245cca7e00af6a38443be3769cef386a0 Method: modularity violation (co-change without a structural dependency). Source: R. Mo, Y. Cai, R. Kazman, L. Xiao, Hotspot Patterns (WICSA 2015).
- **hidden-coupling** (ids: `product-lifecycle`, `reference-system`): elements "product-lifecycle" and "reference-system" changed together in 10 commits (at least 5 within 180 days; commits touching more than 30 files are skipped as bulk changes) but no relation joins them; the newest commits: 41acc87245cca7e00af6a38443be3769cef386a0, 9da3abe7a53b4229848e87d35db410a31a8ceb41, afe7ef946e2bfe22fbda4e1d741b5b66644af1e0 Method: modularity violation (co-change without a structural dependency). Source: R. Mo, Y. Cai, R. Kazman, L. Xiao, Hotspot Patterns (WICSA 2015).
- **hidden-coupling** (ids: `product-lifecycle`, `test-suite`): elements "product-lifecycle" and "test-suite" changed together in 30 commits (at least 5 within 180 days; commits touching more than 30 files are skipped as bulk changes) but no relation joins them; the newest commits: 8f700d5d819412b5c5167f96dcc31aeed0d04eed, f46a7f27e591a9e1e38deb4556512c6e1d1238d5, 41acc87245cca7e00af6a38443be3769cef386a0 Method: modularity violation (co-change without a structural dependency). Source: R. Mo, Y. Cai, R. Kazman, L. Xiao, Hotspot Patterns (WICSA 2015).
- **hidden-coupling** (ids: `product-lifecycle`, `wiki`): elements "product-lifecycle" and "wiki" changed together in 6 commits (at least 5 within 180 days; commits touching more than 30 files are skipped as bulk changes) but no relation joins them; the newest commits: 41acc87245cca7e00af6a38443be3769cef386a0, a9a518871f9407db983ec58750f9e21e69c83444, 05d08225e2d4bd3ec0162c80627e1906c1148143 Method: modularity violation (co-change without a structural dependency). Source: R. Mo, Y. Cai, R. Kazman, L. Xiao, Hotspot Patterns (WICSA 2015).
- **hidden-coupling** (ids: `product-wiki`, `test-suite`): elements "product-wiki" and "test-suite" changed together in 44 commits (at least 5 within 180 days; commits touching more than 30 files are skipped as bulk changes) but no relation joins them; the newest commits: 8f700d5d819412b5c5167f96dcc31aeed0d04eed, 9b5e97baede3124dcfbc23c793f5c29d0d770294, 839b0ae90708664c086935f9beb422c2b059af11 Method: modularity violation (co-change without a structural dependency). Source: R. Mo, Y. Cai, R. Kazman, L. Xiao, Hotspot Patterns (WICSA 2015).
- **hidden-coupling** (ids: `product-wiki`, `wiki`): elements "product-wiki" and "wiki" changed together in 14 commits (at least 5 within 180 days; commits touching more than 30 files are skipped as bulk changes) but no relation joins them; the newest commits: 41acc87245cca7e00af6a38443be3769cef386a0, a9a518871f9407db983ec58750f9e21e69c83444, 05d08225e2d4bd3ec0162c80627e1906c1148143 Method: modularity violation (co-change without a structural dependency). Source: R. Mo, Y. Cai, R. Kazman, L. Xiao, Hotspot Patterns (WICSA 2015).
- **hidden-coupling** (ids: `query-engine`, `test-suite`): elements "query-engine" and "test-suite" changed together in 7 commits (at least 5 within 180 days; commits touching more than 30 files are skipped as bulk changes) but no relation joins them; the newest commits: f16eaf235282f91aa41e3a9bc1f6d7beef9d4154, 232c36a012a8989cac2177c8b2e5dea155e394b3, 2ea7ee200c13e28e4e56eb71fb75d9647472acd0 Method: modularity violation (co-change without a structural dependency). Source: R. Mo, Y. Cai, R. Kazman, L. Xiao, Hotspot Patterns (WICSA 2015).
- **hidden-coupling** (ids: `reference-system`, `test-suite`): elements "reference-system" and "test-suite" changed together in 21 commits (at least 5 within 180 days; commits touching more than 30 files are skipped as bulk changes) but no relation joins them; the newest commits: 41acc87245cca7e00af6a38443be3769cef386a0, 9da3abe7a53b4229848e87d35db410a31a8ceb41, afe7ef946e2bfe22fbda4e1d741b5b66644af1e0 Method: modularity violation (co-change without a structural dependency). Source: R. Mo, Y. Cai, R. Kazman, L. Xiao, Hotspot Patterns (WICSA 2015).
- **hidden-coupling** (ids: `renderer`, `test-suite`): elements "renderer" and "test-suite" changed together in 16 commits (at least 5 within 180 days; commits touching more than 30 files are skipped as bulk changes) but no relation joins them; the newest commits: 605c1ac2fd0297d82e5c49523d028585c886f192, 83e9cd7e89b39cf0117750e6a069be60bd4456b2, 5cbd001d92f46b45522d3b01485f0d5c816acd93 Method: modularity violation (co-change without a structural dependency). Source: R. Mo, Y. Cai, R. Kazman, L. Xiao, Hotspot Patterns (WICSA 2015).
- **hidden-coupling** (ids: `server`, `test-suite`): elements "server" and "test-suite" changed together in 56 commits (at least 5 within 180 days; commits touching more than 30 files are skipped as bulk changes) but no relation joins them; the newest commits: d96746b0b1b0f6a9f068e40727610174b2c21473, 605c1ac2fd0297d82e5c49523d028585c886f192, 9852e9cb3512747ce909dfdcd205b3559230543c Method: modularity violation (co-change without a structural dependency). Source: R. Mo, Y. Cai, R. Kazman, L. Xiao, Hotspot Patterns (WICSA 2015).
- **hidden-coupling** (ids: `server`, `wiki`): elements "server" and "wiki" changed together in 7 commits (at least 5 within 180 days; commits touching more than 30 files are skipped as bulk changes) but no relation joins them; the newest commits: 41acc87245cca7e00af6a38443be3769cef386a0, 6d27fbd95bae184756544fa984beba0cbd4bfdf4, a7c44744713b6b1c561e122f5f71a0b43f200e50 Method: modularity violation (co-change without a structural dependency). Source: R. Mo, Y. Cai, R. Kazman, L. Xiao, Hotspot Patterns (WICSA 2015).
- **hidden-coupling** (ids: `test-suite`, `wiki`): elements "test-suite" and "wiki" changed together in 58 commits (at least 5 within 180 days; commits touching more than 30 files are skipped as bulk changes) but no relation joins them; the newest commits: 41acc87245cca7e00af6a38443be3769cef386a0, a9a518871f9407db983ec58750f9e21e69c83444, 05d08225e2d4bd3ec0162c80627e1906c1148143 Method: modularity violation (co-change without a structural dependency). Source: R. Mo, Y. Cai, R. Kazman, L. Xiao, Hotspot Patterns (WICSA 2015).

Questions a reader of the pages raises:

- The server holds every model ever sent to it, in one folder, with no
  authentication (`src/server/http.ts:141` listens on 127.0.0.1 by
  default, decision 0012): is a model's content — element names,
  contract ids, technology strings — sensitive enough in your setting
  that the bind address should be forced rather than defaulted?
- The model check reads a repository's git history back 180 days for the
  hidden-coupling problem (`src/check/model-check.ts:130` and the
  window in `src/check/model-problems.ts:43`): should a repository with
  a very large history cap that walk, or is the check's one-minute
  budget its accepted bound?
- The wiki executes the Starlight template's install and the vendored
  archify renderer from a per-user cache folder (`src/wiki/cache.ts:1-11`)
  on every build: is the cache's ownership check enough for the machines
  the wiki is built on, given the build runs `bun install` and `node`
  inside it?
- This model's own folder is excluded from the assignment and its pages
  are not rendered into the repository: the scenarios of
  `madarch/scenarios.yaml` now describe madarch's own use cases — should
  madarch's model become an input to its own wiki build in CI, and where
  would that build's views live?
- The model-authoring capability at `docs/system/capabilities/model-authoring.md:13-17` says madarch ships an Agent Skills folder, while accepted decision 0016:73-75 says the engine ships none and the skill moves to the skill set; should that capability specification be revised in separately approved work?
