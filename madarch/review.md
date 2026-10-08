# Review: the madarch repository at commit f556d016491ce8f8abcda8afdc12ed4cb20d4329

This model was written the way `write-intended-model` prescribes: the
documents first, each claim checked in the code at f556d016491ce8f8abcda8afdc12ed4cb20d4329 (the base of the
branch this model was written on), every element, interface and relation
evidenced at that commit. The run's contract is
`docs/changes/use-cases-data-entities/change.md`: this model carries
elements, interfaces and relations only; the scenarios and data entities
of that change arrive with its later tasks and are not written here,
because the loader at this commit does not read them.

## Claims

| Claim | Document | Line | Commit | Blob | Checked in code | Verdict | In the model |
| --- | --- | --- | --- | --- | --- | --- | --- |
| The Model part (`src/model/`) reads a repository's intended model from YAML files and compiles it to one normalized JSON, both checked against TypeBox schemas, ids sorted by code point | docs/system/architecture.md | 8-14 | f556d016491ce8f8abcda8afdc12ed4cb20d4329 | 82a16d4439d31c0f4e920f84795b7666589817fd | src/model/load.ts:342, src/model/compile.ts:33, src/model/schema.ts:198, src/model/order.ts:1 | confirmed | model-format |
| The Check part (`src/check/`, `scripts/check-model.ts`) checks a repository's model against the repository itself and renders the model's views into a folder when asked | docs/system/architecture.md | 16-20 | f556d016491ce8f8abcda8afdc12ed4cb20d4329 | 82a16d4439d31c0f4e920f84795b7666589817fd | src/check/model-check.ts:621, scripts/check-model.ts:13 | confirmed | model-check |
| The History part (`src/history/`, `src/adapters/sqlite-history.ts`) keeps every version of every source's compiled model as a bitemporal fact log in SQLite; nothing is overwritten, stores are idempotent and ordered by commit time | docs/system/architecture.md | 22-27 | f556d016491ce8f8abcda8afdc12ed4cb20d4329 | 82a16d4439d31c0f4e920f84795b7666589817fd | src/adapters/sqlite-history.ts:144, src/history/types.ts:188 | confirmed | history-store |
| The Query engine (`src/query/`, `src/adapters/ladybug-engine.ts`) is derived state built from the history's assertions and rebuildable at any time; LadybugDB 0.20.4 carries it | docs/system/architecture.md | 29-34 | f556d016491ce8f8abcda8afdc12ed4cb20d4329 | 82a16d4439d31c0f4e920f84795b7666589817fd | src/adapters/ladybug-engine.ts:393, src/query/types.ts:129, package.json:23 | confirmed | query-engine |
| The Renderer (`src/render/`) turns views into the view set's Mermaid pages and LikeC4 workspace, and one view on request at any depth, which the server answers with | docs/system/architecture.md | 36-40 | f556d016491ce8f8abcda8afdc12ed4cb20d4329 | 82a16d4439d31c0f4e920f84795b7666589817fd | src/render/view-set.ts:90, src/render/mermaid.ts:82, src/render/likec4.ts:152, src/render/one-view.ts:101 | confirmed | renderer |
| The Wiki (`src/wiki/`, `scripts/wiki.ts`) is the static site generated from a repository's compiled model and its own documents, each view offered as LikeC4, Mermaid and archify | docs/system/architecture.md | 42-44 | f556d016491ce8f8abcda8afdc12ed4cb20d4329 | 82a16d4439d31c0f4e920f84795b7666589817fd | src/wiki/build.ts:274, scripts/wiki.ts:11, src/wiki/archify.ts:1 | confirmed | wiki |
| The Server (`src/server/`, `scripts/serve.ts`) keeps the models repositories send and answers requests; the send command runs the check and sends a passing model; the server never reads a repository | docs/system/architecture.md | 46-50 | f556d016491ce8f8abcda8afdc12ed4cb20d4329 | 82a16d4439d31c0f4e920f84795b7666589817fd | src/server/http.ts:129, src/send/send-model.ts:44; no git call anywhere under src/server/ | confirmed | server |
| A model is compiled, the check passes, and the compiled model is sent with the source's name, commit id and commit time; the server checks it against the compiled schema and stores it; views are answered by the engine and rendered as Mermaid or LikeC4 text | docs/system/architecture.md | 54-59 | f556d016491ce8f8abcda8afdc12ed4cb20d4329 | 82a16d4439d31c0f4e920f84795b7666589817fd | src/send/send-model.ts:44, src/server/http.ts:169-174, src/server/sources.ts:207 | confirmed | send-checks-then-posts |
| The server is started with a data folder it refuses to start without, listens on 127.0.0.1 unless told otherwise, has no authentication, and its HTTP layer is one route table | docs/system/architecture.md | 63-67 | f556d016491ce8f8abcda8afdc12ed4cb20d4329 | 82a16d4439d31c0f4e920f84795b7666589817fd | scripts/serve.ts:12, src/server/http.ts:129-141,169-174 | confirmed | server |
| The server's routes are POST /models, GET /sources and POST /views | docs/system/architecture.md | 69-73 | f556d016491ce8f8abcda8afdc12ed4cb20d4329 | 82a16d4439d31c0f4e920f84795b7666589817fd | src/server/http.ts:169-174 also routes POST /sources (the rename claim), which the page's list does not name | stale | server-rename |
| The data folder holds one SQLite history file per source with a small sidecar naming its source and head, so a restart answers the same as before | docs/system/architecture.md | 79-83 | f556d016491ce8f8abcda8afdc12ed4cb20d4329 | 82a16d4439d31c0f4e920f84795b7666589817fd | src/server/sources.ts:1-44,207 | confirmed | history-store |
| A graph is a named set of sources with one query engine each; in this milestone every graph lists exactly one source; the engine is built lazily and kept in step with each store | docs/system/architecture.md | 85-94 | f556d016491ce8f8abcda8afdc12ed4cb20d4329 | 82a16d4439d31c0f4e920f84795b7666589817fd | src/server/graphs.ts:1-24,199 | confirmed | server |
| A view of a sent source is answered from its graph's engine by the one-view renderer at the current time and the first state; a LikeC4 answer lists the relations LikeC4 cannot draw | docs/system/architecture.md | 96-98 | f556d016491ce8f8abcda8afdc12ed4cb20d4329 | 82a16d4439d31c0f4e920f84795b7666589817fd | src/server/http.ts:231-260, src/render/one-view.ts:1-9 | confirmed | server-views |
| madarch keeps a product's knowledge as a graph; the wiki, diagrams and answers to agents are views of it | docs/vision.md | 3-9 | f556d016491ce8f8abcda8afdc12ed4cb20d4329 | 2f0c1d1cb8c1e05c7e22b7f75e3b04c13d9c3aa9 | docs/system/architecture.md:1-98, src/wiki/build.ts:274, src/render/view-set.ts:90 | confirmed | madarch |
| Its audience includes AI agents that need the knowledge as data they can query | docs/vision.md | 33-34 | f556d016491ce8f8abcda8afdc12ed4cb20d4329 | 2f0c1d1cb8c1e05c7e22b7f75e3b04c13d9c3aa9 | skills/write-intended-model/SKILL.md:1-7 (the skill serves agents); no agent query surface beyond HTTP yet | confirmed | coding-agent |
| A data catalogue of every data entity with its classification and flows is part of the outcome | docs/vision.md | 138-139 | f556d016491ce8f8abcda8afdc12ed4cb20d4329 | 2f0c1d1cb8c1e05c7e22b7f75e3b04c13d9c3aa9 | the model format at this commit has categories only; data entities arrive with this change | planned | — |
| Open questions, computed and asked of people, are part of the outcome | docs/vision.md | 140-141 | f556d016491ce8f8abcda8afdc12ed4cb20d4329 | 2f0c1d1cb8c1e05c7e22b7f75e3b04c13d9c3aa9 | nothing in the code holds open questions | planned | — |
| Two modes exist: local (one repository, an embedded graph, a wiki built in place, a local MCP for agents) and a server | docs/vision.md | 145-147 | f556d016491ce8f8abcda8afdc12ed4cb20d4329 | 2f0c1d1cb8c1e05c7e22b7f75e3b04c13d9c3aa9 | local: scripts/wiki.ts and src/wiki/build.ts build a site in place; server: scripts/serve.ts; a local MCP exists nowhere in the code | planned | wiki |
| Answers are served to people and agents over HTTP and MCP; diagrams come through frontend plugins (Mermaid, LikeC4, graph databases) | docs/vision.md | 148-150 | f556d016491ce8f8abcda8afdc12ed4cb20d4329 | 2f0c1d1cb8c1e05c7e22b7f75e3b04c13d9c3aa9 | HTTP: src/server/http.ts:169-174; Mermaid and LikeC4: src/render/; MCP: none; graph databases: none | planned | server-views |
| madarch is deployed as one Docker image with no outbound calls at runtime | docs/vision.md | 176-177 | f556d016491ce8f8abcda8afdc12ed4cb20d4329 | 2f0c1d1cb8c1e05c7e22b7f75e3b04c13d9c3aa9 | no Dockerfile or image build anywhere in the repository | planned | — |
| The model check is `scripts/check-model.ts`, the local command that checks a repository's intended model against the repository | docs/glossary.md | 182-186 | f556d016491ce8f8abcda8afdc12ed4cb20d4329 | d2016e46cc8eb8ad2bb2afe26bfacd8af0281813 | scripts/check-model.ts:1-13, src/check/model-check.ts:621 | confirmed | model-check |
| The wiki is `scripts/wiki.ts`, the static site generated from a repository's compiled model and its own documents, built by Zensical or Starlight from the template in `wiki/starlight/` | docs/glossary.md | 204-209 | f556d016491ce8f8abcda8afdc12ed4cb20d4329 | d2016e46cc8eb8ad2bb2afe26bfacd8af0281813 | scripts/wiki.ts:11, src/wiki/build.ts:274, wiki/starlight/package.json:1-13 | confirmed | wiki |
| An extraction plugin is a separate process that reads a source and emits facts over the plugin protocol | docs/glossary.md | 159-160 | f556d016491ce8f8abcda8afdc12ed4cb20d4329 | d2016e46cc8eb8ad2bb2afe26bfacd8af0281813 | no plugin host or protocol anywhere in the code; decision 0004 defers plugins | planned | — |
| An output plugin is a separate process that renders the compiled model; it is not built yet and the renderer does this in process | docs/glossary.md | 167-168 | f556d016491ce8f8abcda8afdc12ed4cb20d4329 | d2016e46cc8eb8ad2bb2afe26bfacd8af0281813 | src/render/ holds the in-process renderer; no output plugin exists, as the glossary itself says | confirmed | renderer |
| The renderer is the in-process code that turns views into text a frontend reads (Mermaid pages, a LikeC4 workspace), and the server calls the same renderer for a view on request | docs/glossary.md | 162-165 | f556d016491ce8f8abcda8afdc12ed4cb20d4329 | d2016e46cc8eb8ad2bb2afe26bfacd8af0281813 | src/render/view-set.ts:90, src/render/one-view.ts:101, src/server/http.ts:231-260 | confirmed | renderer |
| A source is named by its origin remote as host and path | docs/glossary.md | 107-108 | f556d016491ce8f8abcda8afdc12ed4cb20d4329 | d2016e46cc8eb8ad2bb2afe26bfacd8af0281813 | src/send/send-model.ts:114-135 (sourceNameFromRemote) | confirmed | send-command |
| A diagram tab is one format of a wiki page's view — LikeC4, Mermaid, or archify drawn by the renderer kept in `vendor/archify/` | docs/glossary.md | 211-212 | f556d016491ce8f8abcda8afdc12ed4cb20d4329 | d2016e46cc8eb8ad2bb2afe26bfacd8af0281813 | src/wiki/build.ts:186-187,250-253, src/wiki/archify.ts:1-24 | confirmed | wiki |
| The knowledge-base milestone proves the product wiki on one repository in the local mode, with no server; the real repository is madarch itself | docs/milestones/knowledge-base.md | 6-13 | f556d016491ce8f8abcda8afdc12ed4cb20d4329 | e8ead09fe45561122825cc482bc9c8a6b43c39f4 | this model and its review are that proof's beginning; the wiki builds from a repository in place (src/wiki/build.ts:274) | confirmed | madarch |
| Outcome 1 builds the document contract into one dependency-free file with a version, part of the model check, installed by the skill set | docs/milestones/knowledge-base.md | 16-24 | f556d016491ce8f8abcda8afdc12ed4cb20d4329 | e8ead09fe45561122825cc482bc9c8a6b43c39f4 | nothing in the code builds a contract file; the skill still lives at skills/write-intended-model | planned | — |
| Outcome 2 declares data entities and use cases as scenarios in the model, traced to requirements, and the check refuses a broken scenario | docs/milestones/knowledge-base.md | 28-35 | f556d016491ce8f8abcda8afdc12ed4cb20d4329 | e8ead09fe45561122825cc482bc9c8a6b43c39f4 | the loader at this commit has no entities or scenarios (src/model/schema.ts:198-213) | planned | — |
| Outcome 3 reads the whole product in its wiki with backlinks, sequence diagrams, a data catalogue and open questions | docs/milestones/knowledge-base.md | 37-46 | f556d016491ce8f8abcda8afdc12ed4cb20d4329 | e8ead09fe45561122825cc482bc9c8a6b43c39f4 | src/wiki/pages.ts:514 holds element, interface, zone and category pages; no product section, use-case pages or backlinks | planned | — |
| Outcome 4 indexes a repository's code into files, imports and symbols as madarch's own extraction plugin | docs/milestones/knowledge-base.md | 48-55 | f556d016491ce8f8abcda8afdc12ed4cb20d4329 | e8ead09fe45561122825cc482bc9c8a6b43c39f4 | no code index anywhere in the code | planned | — |
| madarch owns the graph and its semantics; Mermaid, LikeC4 and graph databases are frontends that read the compiled model | docs/decisions/0001-graph-as-backend-with-replaceable-frontends.md | 22-26 | f556d016491ce8f8abcda8afdc12ed4cb20d4329 | 92578fed355f443d33891d7dd8e9840d7715f793 | src/model/compile.ts:33 (the compiled model), src/render/mermaid.ts:82, src/render/likec4.ts:152 | confirmed | renderer |
| The intended model is restricted YAML in git, compiled from the repository, never owned by the server; a JSON Schema from the same source as the code's types validates it | docs/decisions/0002-intended-model-as-yaml-in-git.md | 16-21 | f556d016491ce8f8abcda8afdc12ed4cb20d4329 | f8cdf3ba60545c543a533e3217c2699b205deae0 | src/model/strict-yaml.ts:1, src/model/load.ts:342, schema/intended-model.schema.json:1 | confirmed | model-format |
| One graph across repositories is joined by normalized contract ids | docs/decisions/0003-federation-by-normalized-contract-ids.md | 19-23 | f556d016491ce8f8abcda8afdc12ed4cb20d4329 | 262af509cadbdfdfe256998bf0424c9fbaec5df3 | contract ids are normalized (src/model/contracts.ts); joining several repositories is not built: one graph lists one source (src/server/graphs.ts:1-24) | planned | — |
| Extraction plugins are separate processes emitting atomic facts; the first milestone has none and an agent skill writes the intended model | docs/decisions/0004-source-agnostic-core-with-fact-plugins.md | 30-33 | f556d016491ce8f8abcda8afdc12ed4cb20d4329 | 02dcfaf0f6f6b701e339abf1e60bc84ee1277876 | no plugin host in the code; the skill is skills/write-intended-model | confirmed | authoring-skill |
| A relation binds to an environment through a variable name; secret values are never stored | docs/decisions/0006-environment-bindings-by-variable-name.md | 12-17 | f556d016491ce8f8abcda8afdc12ed4cb20d4329 | ca97ca2dc18e1da8c7708a4aeb54c8c3701a3b82 | src/model/schema.ts:130-134 (Binding), src/model/compile.ts (bindingByEnvironment) | confirmed | model-format |
| The server is the target; a send command beside the model check sends the compiled model with its commit and commit time, and storing it is the ingest | docs/decisions/0007-server-target-and-ingest.md | 40-45 | f556d016491ce8f8abcda8afdc12ed4cb20d4329 | cf90580c541b7f94c493f2eca744954685f93a5a | src/send/send-model.ts:44, scripts/send-model.ts:14, src/server/http.ts:169-174 | confirmed | send-command |
| madarch is TypeScript on Bun, with Bun-specific APIs confined to adapters | docs/decisions/0008-typescript-on-bun.md | 17-23 | f556d016491ce8f8abcda8afdc12ed4cb20d4329 | 2afba184449514c1bb0684497d199910bb4e81e1 | src/adapters/sqlite-history.ts:1 (bun:sqlite), src/server/http.ts:141 (Bun.serve); src/model and src/history hold no Bun API | confirmed | madarch |
| The fact log is SQLite behind a storage interface and LadybugDB is the rebuildable query engine | docs/decisions/0009-bitemporal-fact-log-and-query-engine.md | 28-35 | f556d016491ce8f8abcda8afdc12ed4cb20d4329 | ef6698a862516daca0b746041f1c66bccf73beb0 | src/adapters/sqlite-history.ts:144, src/adapters/ladybug-engine.ts:393, src/history/types.ts:188 | confirmed | history-store |
| One Docker image runs the server with no outbound calls at runtime | docs/decisions/0010-single-offline-docker-image.md | 11-15 | f556d016491ce8f8abcda8afdc12ed4cb20d4329 | 89e49f3b82d4e8f40a8929ba7109e101d1acf510 | no Dockerfile or image build in the repository | planned | — |
| Repositories are read through plain git with read-only credentials by the server | docs/decisions/0011-repository-access-through-plain-git.md | 13-16 | f556d016491ce8f8abcda8afdc12ed4cb20d4329 | 9a873c77cf2ad3a01b70596e018734ff78aeec59 | the server reads no repository (src/server/ has no git call); cloning waits for a later milestone; the model check does read git locally (src/check/model-check.ts:130) | planned | model-check |
| There is no user authentication in the first milestone; the server listens on localhost unless configured otherwise | docs/decisions/0012-no-authentication-in-first-milestone.md | 11-14 | f556d016491ce8f8abcda8afdc12ed4cb20d4329 | 47a18addd5fbff41047c19551706a9021a6bd1e6 | src/server/http.ts:141 (127.0.0.1 default), no authentication anywhere in src/server/ | confirmed | server |
| A graph is a named list of sources with one query engine per graph; in this milestone each repository sent is a graph listing only itself | docs/decisions/0013-one-graph-per-server.md | 26-38 | f556d016491ce8f8abcda8afdc12ed4cb20d4329 | bb58bab99fd0203a46770bcd0a05030150d7ee74 | src/server/graphs.ts:1-24,199 | confirmed | server |
| The model format keeps relations at any level, interactions as nodes, transfers with a direction each, confidentiality separate from categories, and stable ids | docs/decisions/0014-model-format-principles.md | 11-32 | f556d016491ce8f8abcda8afdc12ed4cb20d4329 | 74d7320696927242d661d601df9a978773e9386b | src/model/schema.ts:138-186, src/model/contracts.ts, src/model/validate.ts | confirmed | model-format |
| Architecture states form one chain in the model; an element or relation may exist since a state and until a state | docs/decisions/0015-architecture-states-as-a-chain-in-the-model.md | 22-25 | f556d016491ce8f8abcda8afdc12ed4cb20d4329 | a7738f2da3111cb519375deff29fc1d6235c071c | src/model/schema.ts:188-195, src/model/validate.ts (isOneStateChain in src/history/assertions.ts:48) | confirmed | model-format |
| madarch becomes the product's knowledge base; authoring moves to the owner's skill set and madarch keeps the contract, the check and the serving | docs/decisions/0016-product-knowledge-base-direction.md | 40-44 | f556d016491ce8f8abcda8afdc12ed4cb20d4329 | 1769f9f12c4e35099fec1c3fa77eb3cfca532ad5 | the direction is accepted; the move is not done: skills/write-intended-model is still here and no contract file exists | planned | authoring-skill |
| The write-intended-model skill moves to the skill set; the model check stays in madarch and becomes part of the contract file | docs/decisions/0016-product-knowledge-base-direction.md | 73-74 | f556d016491ce8f8abcda8afdc12ed4cb20d4329 | 1769f9f12c4e35099fec1c3fa77eb3cfca532ad5 | skills/write-intended-model still lives in this repository; the check is still scripts/check-model.ts | planned | model-check |
| madarch ships the authoring skill as one Agent Skills folder holding its instructions, a format reference and a worked example | docs/system/capabilities/model-authoring.md | 13-19 | f556d016491ce8f8abcda8afdc12ed4cb20d4329 | 9a68942030f0af75dc54998633380fb97fa906ff | skills/write-intended-model/SKILL.md, reference.md, example/ | confirmed | authoring-skill |
| The skill sends the checked model to a server when one is named | docs/system/capabilities/model-authoring.md | 89-97 | f556d016491ce8f8abcda8afdc12ed4cb20d4329 | 9a68942030f0af75dc54998633380fb97fa906ff | skills/write-intended-model/SKILL.md:379-398 names the send command; scripts/send-model.ts:14 | confirmed | send-command |
| One set of wiki pages is built by either of two engines, Zensical or Starlight, chosen by --engine or MADARCH_WIKI_ENGINE, Zensical by default | docs/system/capabilities/wiki.md | 65-73 | f556d016491ce8f8abcda8afdc12ed4cb20d4329 | f6ad813153e83ebf34605df71392ab9d51248619 | src/wiki/build.ts:53,257,264, src/wiki/starlight.ts:226-274, src/wiki/zensical.ts:1-11 | confirmed | wiki |
| Every source has a stable server-assigned id surviving a rename; POST /sources records a rename claim and the old name never grows a second source | docs/system/capabilities/server.md | 115-133 | f556d016491ce8f8abcda8afdc12ed4cb20d4329 | 346f252818e1b0d2f299ba040751e5d5a49aa9c8 | src/server/http.ts:169-174, src/server/sources.ts:1-44 | confirmed | server-rename |
| The product's checks are `bun run check` and `bun test`; `MADARCH_SKIP_PERF=1 bun test` skips the performance tests | AGENTS.md | 12-14 | f556d016491ce8f8abcda8afdc12ed4cb20d4329 | cf1c644d127dc8f74116c6c06fc5b83288a3d6f2 | package.json:7-13 (scripts check, test); test/model-check-performance.test.ts honours MADARCH_SKIP_PERF | confirmed | test-suite |
| A model declares data entities and use cases as scenarios whose steps follow the model's relations and name requirements; the check refuses a scenario whose relation or requirement is gone | docs/changes/use-cases-data-entities/change.md | 12-16 | f556d016491ce8f8abcda8afdc12ed4cb20d4329 | 793a04608867a54d8684470b6b11818381601fab | the loader at this commit accepts no entities or scenarios (src/model/schema.ts:198-213) | planned | — |
| madarch gets its own model in `madarch/` at the repository root, written by the write-intended-model skill, with three to five main scenarios | docs/changes/use-cases-data-entities/change.md | 151-153 | f556d016491ce8f8abcda8afdc12ed4cb20d4329 | 793a04608867a54d8684470b6b11818381601fab | this model and its review; the scenarios arrive with the next task of this change | planned | madarch |
| The reference system's model gains data entities | docs/changes/use-cases-data-entities/change.md | 151-153 | f556d016491ce8f8abcda8afdc12ed4cb20d4329 | 793a04608867a54d8684470b6b11818381601fab | examples/reference-system/madarch/*.yaml carry categories only at this commit | planned | reference-system |

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
  (`docs/glossary.md:211-212`) but no document names Node as a
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
| `madarch/` | excluded | the model and its review |
| `docs/` | product-docs | the product's own documents; read for claims |
| `examples/` | reference-system | the invented reference system, its model and its committed views |
| `schema/` | model-format | the published JSON Schemas of the intended and the compiled model |
| `scripts/` | build-tooling | the command-line entry points and the view-check tooling |
| `scripts/check-model.ts` | model-check | the model check's command |
| `scripts/send-model.ts` | send-command | the send command's command line |
| `scripts/serve.ts` | server | the server's command line |
| `scripts/wiki.ts` | wiki | the wiki build's command line |
| `scripts/render-views.ts` | reference-system | renders the reference system's committed views |
| `skills/` | authoring-skill | the write-intended-model skill; no document under docs/ describes its folder shape |
| `src/` | model-format | the product's source; grouped by the elements below |
| `src/model/` | model-format | the loader, the compiler, the schemas, validation and ordering |
| `src/history/` | history-store | the history's interface and assertion kinds |
| `src/query/` | query-engine | the query engine's interface |
| `src/check/` | model-check | the model check and its problems |
| `src/render/` | renderer | the view set, the Mermaid and LikeC4 renderers, one view on request |
| `src/send/` | send-command | the send command's logic |
| `src/server/` | server | the HTTP layer, the source stores and the graphs |
| `src/wiki/` | wiki | the wiki build, its pages, engines and the archify documents |
| `src/index.ts` | model-format | the public interface of the whole library |
| `test/` | test-suite | the suite and its fixtures |
| `vendor/` | wiki | the vendored archify renderer the wiki draws with |
| `wiki/` | wiki | the Starlight template the wiki builds from |
| `.beads/` | excluded | the tracker export; owned by the run's coordinator |
| `.githooks/` | build-tooling | the local hooks of the shady2k workflow |
| `.github/` | build-tooling | the CI workflow |
| `.shady2k/` | build-tooling | the workflow integration and its checks |
| `AGENTS.md` | build-tooling | the machine-facing instructions; read for claims |
| `CLAUDE.md` | build-tooling | a pointer for agents |
| `bun.lock` | build-tooling | the lockfile |
| `package.json` | madarch | the manifest: name, scripts and dependencies |
| `tsconfig.json` | build-tooling | the TypeScript configuration |
| `.gitattributes` | build-tooling | line-ending and diff rules |
| `.gitignore` | build-tooling | ignored paths |
| `src/adapters/sqlite-history.ts` | history-store | the SQLite history behind the HistoryStore interface |
| `src/adapters/ladybug-engine.ts` | query-engine | the LadybugDB engine behind the QueryEngine interface |

## Problems

From the model check (method and source as it reports them):

- hidden-coupling (ids: `build-tooling`, `test-suite`): elements
  "build-tooling" and "test-suite" changed together in 5 commits (at
  least 5 within 180 days; commits touching more than 30 files are
  skipped as bulk changes) but no relation joins them. Method:
  modularity violation (co-change without a structural dependency).
  Source: R. Mo, Y. Cai, R. Kazman, L. Xiao, Hotspot Patterns (WICSA
  2015).
- hidden-coupling (ids: `history-store`, `test-suite`): changed together
  in 16 commits, no relation joins them. Method and source as above.
- hidden-coupling (ids: `query-engine`, `test-suite`): changed together
  in 14 commits, no relation joins them. Method and source as above.
- hidden-coupling (ids: `reference-system`, `test-suite`): changed
  together in 10 commits, no relation joins them. Method and source as
  above.
- hidden-coupling (ids: `renderer`, `test-suite`): changed together in
  15 commits, no relation joins them. Method and source as above.
- hidden-coupling (ids: `server`, `test-suite`): changed together in 32
  commits, no relation joins them. Method and source as above.
- hidden-coupling (ids: `test-suite`, `wiki`): changed together in 41
  commits, no relation joins them. Method and source as above.

Read: every one of these pairs the test suite with the part it tests.
The model has relations from `test-suite` to `model-format` and
`model-check` only (`tests-cover-format`, `tests-cover-pipeline`); the
parts the suite tests without a relation are the co-changes the check
names. The suite is a test of each part, not a structural dependency of
it; whether the model should carry a relation from the suite to every
part it covers is a question for its reader, not a defect the check
fixes.

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
  are not rendered into the repository: when the scenarios of this
  change's later tasks land, should madarch's model become an input to
  its own wiki build in CI, and where would that build's views live?
