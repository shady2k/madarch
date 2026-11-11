# Product-file reader migration — madarch-64o5.13

## Boundary

The engine consumes structured graph opinions. Plugin host transport may carry repository bytes; manifest loaders under `src/product/manifest/` interpret only declarative configuration. Source Markdown, questions, corrections, tasks, template syntax and protocol files are not interpreted by the engine. SQL remains in graph storage.

## Rule evidence

The compiler-resolved AST rule checks dependencies and calls, filesystem reads, git text commands, parser libraries and the audited existing pure-parser declarations. It is not whole-program taint analysis and cannot infer an arbitrary new regex parser's semantics. Under the same final catalog, frozen inventory commit `83330391` has 259 findings and the migrated checkout has zero. The initial bootstrap contained 93 findings captured while migration was in flight; it was not the complete frozen inventory. All 93 are removed; the 20 pre-existing unrelated storage-boundary findings are unchanged.

## Surface replacements

- Questions/corrections/tasks/problem dismissals: ordinary agent-bound kinds, validated graph projections and explicit snake-case fields. The domain `reason` fields use `correction_reason` and `dismissal_reason` to avoid the storage opinion column.
- Knowledge pages/statements/index: structured body, links, statements, mentions and digest opinions; input line field is `body_line`.
- Document navigation and closure: manifest-declared kinds with `markdown`, `path`, `repository`, `anchors` and `links`. Anchor map values hold title, start, end and markdown. Commit changed-line coordinates are git transport metadata; patch bytes do not enter the engine.
- Templates: ordinary `template` kind keyed by path with `template_parts` nodes. No Liquid runtime, directive parser or compatibility path remains. The producer must expand layouts/partials and report unresolved logic as a problem node.
- Source and evidence display: ordinary source opinions carry `path`, `repository`, `source_text`, `commit`. No stored blob API is exposed by GraphReader.
- Protocol definitions/state-machine and operation data: structured graph properties replace source parsers.
- Repository snapshot and git blob transport: plugin host modules; graph storage remains the sole SQL owner.
- Kind/workflow/fill configuration loaders: precise manifest boundary. Obsolete product-wiki/registry/checking API, filesystem watches and parser-only modules were removed rather than retained as dead aliases.


## Inventory disposition (original file:line)

| Original surface | Replacement |
| --- | --- |
| `src/loop/entities.ts:219` | Validated ordinary question/correction graph projections (`src/loop/graph.ts`). |
| `src/loop/views.ts:63` | Questions/Problems consume paginated graph opinions; no unreadable-file parser path. |
| `src/problems/index.ts:75` | Graph question/correction issues replace document parsing. |
| `src/knowledge/product.ts:2382` | Graph loop/document/source/evidence projections; raw-content watch removed; graph revision subscription retained. |
| `src/loop/answer.ts:132` | Question and correction graph state supplies edits and deduplication. |
| `src/loop/plan.ts:181` | Graph page and loop opinion refresh. |
| `src/loop/propose.ts:67` | Graph question scope metadata. |
| `src/loop/tasks.ts:104` | Typed task opinions; no front matter. |
| `src/loop/problem-files.ts:62` | Typed dismissal opinions; writer path naming remains. |
| `src/loop/closure.ts:67` | Plugin transports git hunk coordinates; graph anchors are qualified by repository and exact revision. Unproved closure stays open with a note. |
| `src/knowledge/reset.ts:69` | Graph inventory plus stat identity fingerprint; no content parser. |
| `src/knowledge/markdown.ts:45` | Validated body/statement/link/mention graph properties. |
| `src/knowledge/index/index.ts:28` | Graph page index. |
| `src/knowledge/index/page.ts:62` | Structured page opinions. |
| `src/knowledge/index/grounds.ts:47` | Removed obsolete git text comparison; graph grounds retained. |
| `src/knowledge/product-files.ts:48` | Live host transport moved to `src/plugin/product-files.ts`; dead paths removed. |
| `src/knowledge/product-source.ts:74` | Live host source transport moved to `src/plugin/product-source.ts`. |
| `src/knowledge/graph-read.ts:812` | Blob APIs removed; ordinary graph source_text opinions for display. |
| `src/graph/records.ts:1221` | Batch SQL stays in sole graph storage layer, requested through plugin host; dead single/historical APIs removed. |
| `src/graph/plugin-turns.ts:56` | Host-only stored text request handler; engine import/call boundary enforced. |
| `src/fill/snapshot.ts:407` | Live pinned byte transport moved to `src/plugin/repository-snapshot.ts`; obsolete snapshot API removed. |
| `src/fill/stages/repository-facts.ts:241` | Plugin byte transport; language content heuristics removed. |
| `src/knowledge/product.ts:1306` | Graph loop/document/source/evidence projections; raw-content watch removed; graph revision subscription retained. |
| `src/knowledge/product.ts:2725` | Graph loop/document/source/evidence projections; raw-content watch removed; graph revision subscription retained. |
| `src/knowledge/product.ts:2350` | Graph loop/document/source/evidence projections; raw-content watch removed; graph revision subscription retained. |
| `src/knowledge/doc-tree.ts:144` | Manifest-selected document graph properties and authoritative anchor maps. |
| `src/knowledge/contract-document.ts:58` | Structured definition opinion; JSON/spec structures are already graph data. |
| `src/knowledge/render.ts:103` | Structured template_parts and page opinions; runtime source parsing removed. |
| `src/knowledge/liquid.ts:93` | Removed with Liquid worker/runtime. Producer must state structured template opinion. |
| `src/knowledge/blocks.ts:199` | Structured block inputs and pre-resolved graph links/statements. |
| `src/knowledge/statement.ts:122` | Structured statement array. |
| `src/knowledge/linked-from.ts:26` | Structured graph backlinks. |
| `src/product-wiki/pages.ts:590` | Removed obsolete legacy API; graph KnowledgeProduct API retained. |
| `src/product-wiki/questions.ts:57` | Removed duplicate parser and legacy API. |
| `src/product-wiki/documents.ts:263` | Removed legacy structural parser/API. |
| `src/product/completeness.ts:25` | Removed obsolete completeness loader. |
| `src/product/lifecycle.ts:114` | Delegates genuine configuration reads to manifest boundary; host folder hashing is infrastructure. |
| `src/product/fill-stages.ts:195` | readFillManifests under precise manifest boundary; configuration transformation takes loaded values. |
| `src/knowledge/kinds.ts:805` | Relocated genuine loaders under `src/product/manifest/`; no blanket knowledge exemption. |
| `src/knowledge/workflows.ts:97` | Relocated genuine workflow loader under `src/product/manifest/`. |
| `src/product/contract.ts:153` | Deleted obsolete registry contract loader; active manifest loaders remain precise. |


## Independent audit disposition

The audit lists 53 locations, of which 49 are classified engine surfaces; infrastructure and allowed boundaries are included explicitly. Original line ranges remain inventory coordinates.

| Original location | Replacement or classification |
| --- | --- |
| `src/fill/snapshot.ts:398-431` | Live pinned byte transport moved to `src/plugin/repository-snapshot.ts`; obsolete snapshot API removed. |
| `src/fill/stages/language-heuristics.ts:81-83` | Removed product-text language heuristics and bundled dead assets. |
| `src/fill/stages/repository-facts.ts:217-243,326-415` | Plugin byte transport; language content heuristics removed. |
| `src/graph/plugin-turns.ts:52-64` | Host-only stored text request handler; engine import/call boundary enforced. |
| `src/graph/records.ts:944-974,1209-1227,1255-1265,1270-1308` | Batch SQL stays in sole graph storage layer, requested through plugin host; dead single/historical APIs removed. |
| `src/knowledge/anchors.ts:202-217,248-268` | Validated graph anchor map; no heading/slug parser. |
| `src/knowledge/blocks.ts:194-200,306-337` | Structured block inputs and pre-resolved graph links/statements. |
| `src/knowledge/contract-document.ts:58-85` | Structured definition opinion; JSON/spec structures are already graph data. |
| `src/knowledge/definition.ts:118-144` | Nested validated definition JSON opinions; no source read or parse. |
| `src/knowledge/doc-sources.ts:11-24` | Dead source helper removed; suffix transport metadata inlined. |
| `src/knowledge/doc-tree.ts:149-163` | Manifest-selected document graph properties and authoritative anchor maps. |
| `src/knowledge/graph-read.ts:811-855` | Blob APIs removed; ordinary graph source_text opinions for display. |
| `src/knowledge/index/grounds.ts:31-51` | Removed obsolete git text comparison; graph grounds retained. |
| `src/knowledge/index/index.ts:29-36` | Graph page index. |
| `src/knowledge/index/page.ts:62-82` | Structured page opinions. |
| `src/knowledge/kinds.ts:803-832,852-856,874-895,923-974,1583,1729-1742` | Relocated genuine loaders under `src/product/manifest/`; no blanket knowledge exemption. |
| `src/knowledge/liquid-engine.ts:153-168` | Liquid engine and worker removed; structured template producer contract. |
| `src/knowledge/liquid.ts:86-99` | Removed with Liquid worker/runtime. Producer must state structured template opinion. |
| `src/knowledge/markdown.ts:45-66,113-126,251,337` | Validated body/statement/link/mention graph properties. |
| `src/knowledge/operation-catalogue.ts:23` | Structured directions and direction_status graph opinions. |
| `src/knowledge/overview.ts:101-140` | Graph page links/metadata; no Markdown interpretation. |
| `src/knowledge/page-files.ts:285,312` | Structured graph links/statements; authored Markdown export remains opaque. |
| `src/knowledge/product-files.ts:37-50,133-155` | Live host transport moved to `src/plugin/product-files.ts`; dead paths removed. |
| `src/knowledge/product-source.ts:41-45,61-75,86-99,110-115` | Live host source transport moved to `src/plugin/product-source.ts`. |
| `src/knowledge/product.ts:1298-1308,1692-1751,2515-2535,2701-2777,2795-2798` | Graph loop/document/source/evidence projections; raw-content watch removed; graph revision subscription retained. |
| `src/knowledge/proto-document.ts:11-40` | Structured protobuf display model; no protobuf source parser. |
| `src/knowledge/render.ts:103-107,154-156,408` | Structured template_parts and page opinions; runtime source parsing removed. |
| `src/knowledge/reset.ts:66-95,115-140` | Graph inventory plus stat identity fingerprint; no content parser. |
| `src/knowledge/resolve.ts:93-108` | Graph document anchors and locations. |
| `src/knowledge/state-machines.ts:205-246` | Source parser deleted; state_machines graph opinion rendered by views. |
| `src/knowledge/statement.ts:50-82,102-109,122` | Structured statement array. |
| `src/knowledge/syntax.ts:160-177` | Dead Markdown AST parser module removed. |
| `src/knowledge/template.ts:52-81` | Validated structured template_parts nodes, no template string parser. |
| `src/knowledge/views.ts:732-756` | Structured state-machine opinions; no source parser. |
| `src/knowledge/workflows.ts:94-99,242-250` | Relocated genuine workflow loader under `src/product/manifest/`. |
| `src/loop/answer.ts:132-139,199` | Question and correction graph state supplies edits and deduplication. |
| `src/loop/closure.ts:64-99` | Plugin transports git hunk coordinates; graph anchors are qualified by repository and exact revision. Unproved closure stays open with a note. |
| `src/loop/entities.ts:217-222,277-345,391-435` | Validated ordinary question/correction graph projections (`src/loop/graph.ts`). |
| `src/loop/problem-files.ts:56-77` | Typed dismissal opinions; writer path naming remains. |
| `src/loop/tasks.ts:102-142` | Typed task opinions; no front matter. |
| `src/product-wiki/documents.ts:118-149,263-381` | Removed legacy structural parser/API. |
| `src/product-wiki/pages.ts:267-301,485-488,554-566,588-590,661-784` | Removed obsolete legacy API; graph KnowledgeProduct API retained. |
| `src/product-wiki/questions.ts:57-126,168-202` | Removed duplicate parser and legacy API. |
| `src/product-wiki/recommendations.ts:37-77` | Legacy derived recommendations removed with legacy API. |
| `src/product-wiki/registry.ts:81-100` | Legacy product registry API removed. |
| `src/product/completeness.ts:15-34` | Removed obsolete completeness loader. |
| `src/product/contract.ts:149-153` | Deleted obsolete registry contract loader; active manifest loaders remain precise. |
| `src/product/fill-stages.ts:195,232` | readFillManifests under precise manifest boundary; configuration transformation takes loaded values. |
| `src/product/lifecycle.ts:114,327,350,568-591` | Delegates genuine configuration reads to manifest boundary; host folder hashing is infrastructure. |
| `src/product/registry-file.ts:5-29` | Obsolete registry document reader removed. |
| `src/wiki/documents.ts:95-165,371-425` | Obsolete file-backed wiki document module removed. |
| `src/writer/mentions.ts:38-40,77-78` | Parser-only mention module removed. |
| `src/writer/sentences.ts:64-67,684-715` | Parser-only sentence module removed. |

## Integration dependency and functional changes

The parallel `feature/madarch-stm0-agent` work supplies the ordinary agent filler. This branch declares typed agent bindings but does not implement a second filler. A raw Markdown fixture by itself no longer creates graph knowledge pages or templates. Consumer tests must publish structured opinions; an actual fill producing those opinions requires the parallel filler integration. This dependency must be accepted before claiming complete end-to-end behavior.

Authored Markdown is opaque in exports; engine AST link rewriting is removed. Structured resolution metadata supplies exported link lists. Legacy product-wiki routes and the Liquid worker are removed. These are deliberate breaking changes, not compatibility fallbacks.

## Verification

Verification details and external artifacts are recorded in `/work/out/report-madarch-64o5.13.md`. Final root `bun run check` passes: TypeScript, architecture, catalog and workflow checks. Product-file-reader baseline is empty. Final boundary/architecture/anchor/template/reset suite: 46 passed; graph/render/definition/closure suite: 68 passed. After the title-opinion fix, non-root search/reset/starter schema suite: 14 passed. Starter affected suite: 107 passed, 1 skipped.

Full non-root diagnostic suite at the earlier scratch snapshot: 2,013 passed, 194 skipped, 73 failed (416.57 seconds). This snapshot predates the final schema fixture, malformed-body and title fixes; it is not final-source acceptance. Remaining integration failures are not all established as pre-existing. They include file-backed loop assumptions without the parallel opinion producer, page rendering without structured templates, stale catalogue/revision assertions and other failures requiring follow-up. The full suite was not rerun after the last fixes. `MADARCH_PLUGIN_SANDBOX=off` was explicit because this machine lacks delegated cgroup controllers; it does not validate confinement. `MADARCH_SKIP_PERF=1` skipped performance cases.

Final wiki app check passed; tests: 365 passed, 7 failed. Five are tab/history cases also observed in the earlier run; two route/tab cases additionally failed in the final run. No comparison on the base revision was run, so these are not certified unrelated. No wiki frontend source was changed. Integration acceptance remains pending.

Bounded manual mutation samples killed four rule mutations, two anchor mutations, one structured-template mutation, one stream-dedup mutation and one source graph/Markdown mutation. A starter serializer inversion survived and is not counted as killed. These are samples, not exhaustive mutation coverage.

## Checkout incident

One worker accidentally edited `/work/madarch/test/loop-entities.test.ts` before correcting its cwd. The worker restored its exact pre-edit bytes. The restored file was independently compared with the saved original and is identical. All retained changes are in `~/wsweep`.
