# Product-file reader inventory — madarch-64o5.13

Inventory before changes, main at 406d73474033a58587083e8a9458825b7e94b3be.

All paths below are relative to <checkout>; each identifies a full path by joining that root. No code changed before this inventory.

- `src/loop/entities.ts:219` (full path `<checkout>/src/loop/entities.ts:219`): Front matter, section and footnote question/correction parsers; 277/344 entity parsers; 396 disk reader; 427 graph-file source reader.
- `src/loop/views.ts:63` (full path `<checkout>/src/loop/views.ts:63`): Questions listing; 81 question detail; 310 corrections and 315 question errors; 305 knowledge-page parsing for Problems.
- `src/problems/index.ts:75` (full path `<checkout>/src/problems/index.ts:75`): Question document interpretations supplied to document problem rules.
- `src/knowledge/product.ts:2382` (full path `<checkout>/src/knowledge/product.ts:2382`): Loop badge correction counts; 2381 and 2807/2815 Questions listing and detail callers.
- `src/loop/answer.ts:132` (full path `<checkout>/src/loop/answer.ts:132`): Read and parse question before editing answer; 173 reads pages for statement lookup; 199 reads/parses duplicate corrections.
- `src/loop/plan.ts:181` (full path `<checkout>/src/loop/plan.ts:181`): Refresh reads knowledge pages and disk questions/corrections (183–184).
- `src/loop/propose.ts:67` (full path `<checkout>/src/loop/propose.ts:67`): Read question documents to propose task scope.
- `src/loop/tasks.ts:104` (full path `<checkout>/src/loop/tasks.ts:104`): Task YAML front matter parsing; 131 source text; 142 working-tree reads.
- `src/loop/problem-files.ts:62` (full path `<checkout>/src/loop/problem-files.ts:62`): Dismissal source text, YAML and document interpretation (74–82).
- `src/loop/closure.ts:67` (full path `<checkout>/src/loop/closure.ts:67`): Git diff interpreted to close tasks; 95 git show reads product document at commit.
- `src/knowledge/reset.ts:69` (full path `<checkout>/src/knowledge/reset.ts:69`): Reset reads product text; 75/80/93 parses front matter; 133 parses questions/corrections.
- `src/knowledge/markdown.ts:45` (full path `<checkout>/src/knowledge/markdown.ts:45`): Front matter splitter; 57–99 Markdown entity YAML interpretation; 121 source text; 250 body links/claims; 336 statements.
- `src/knowledge/index/index.ts:28` (full path `<checkout>/src/knowledge/index/index.ts:28`): Knowledge-page document materialization; 36 readIndexedPage; 59 working-tree wrapper.
- `src/knowledge/index/page.ts:62` (full path `<checkout>/src/knowledge/index/page.ts:62`): Knowledge page front matter, Markdown and statements parsed into index.
- `src/knowledge/index/grounds.ts:47` (full path `<checkout>/src/knowledge/index/grounds.ts:47`): git show file bytes for ground comparison (cat-file type at 45 is metadata).
- `src/knowledge/product-files.ts:48` (full path `<checkout>/src/knowledge/product-files.ts:48`): Generic working-tree product text adapter; 155 pinned snapshot text adapter.
- `src/knowledge/product-source.ts:74` (full path `<checkout>/src/knowledge/product-source.ts:74`): Fetch graph file contents; 121 exposes cached text.
- `src/knowledge/graph-read.ts:812` (full path `<checkout>/src/knowledge/graph-read.ts:812`): content, 825 contentsOf, 833 contentAt expose graph file/blob text.
- `src/graph/records.ts:1221` (full path `<checkout>/src/graph/records.ts:1221`): Storage SQL blob contents: bulk (1221), single (1259), historical (1282–1308).
- `src/graph/plugin-turns.ts:56` (full path `<checkout>/src/graph/plugin-turns.ts:56`): Plugin-turn blob read storage facade; host-only consumer expected, must enforce boundary.
- `src/fill/snapshot.ts:407` (full path `<checkout>/src/fill/snapshot.ts:407`): Pinned snapshot git cat-file blob reader.
- `src/fill/stages/repository-facts.ts:241` (full path `<checkout>/src/fill/stages/repository-facts.ts:241`): Batch cat-file blob acquisition; 407 stores bytes; 414 language disambiguation interprets file content.
- `src/knowledge/product.ts:1306` (full path `<checkout>/src/knowledge/product.ts:1306`): Graph verdict evidence file text; 1727 Markdown entity materialization; 1744 current source text; 1750 historical source text.
- `src/knowledge/product.ts:2725` (full path `<checkout>/src/knowledge/product.ts:2725`): Document listing title extraction; 2732 repository document titles; 2738 guide presence via content; 2763 document text/links/headings; source view below 2785.
- `src/knowledge/product.ts:2350` (full path `<checkout>/src/knowledge/product.ts:2350`): Content hashing of watched paths: file-byte access, not document parsing; trace callers before relocation.
- `src/knowledge/doc-tree.ts:144` (full path `<checkout>/src/knowledge/doc-tree.ts:144`): Generic product document front matter/YAML/Markdown AST interpretation (149–163).
- `src/knowledge/contract-document.ts:58` (full path `<checkout>/src/knowledge/contract-document.ts:58`): Read callback fetches product contracts; 77 YAML parse and path diagnostics.
- `src/knowledge/render.ts:103` (full path `<checkout>/src/knowledge/render.ts:103`): Template source text and parseTemplate; 154 rendered Markdown links; 157 entity document body.
- `src/knowledge/liquid.ts:93` (full path `<checkout>/src/knowledge/liquid.ts:93`): Liquid template source text and Liquid parser/rendering.
- `src/knowledge/blocks.ts:199` (full path `<checkout>/src/knowledge/blocks.ts:199`): Entity body document interpretation for links/claims.
- `src/knowledge/statement.ts:122` (full path `<checkout>/src/knowledge/statement.ts:122`): Entity document statement interpretation, also 161.
- `src/knowledge/linked-from.ts:26` (full path `<checkout>/src/knowledge/linked-from.ts:26`): Entity document statement interpretation for backlinks.
- `src/product-wiki/pages.ts:590` (full path `<checkout>/src/product-wiki/pages.ts:590`): Legacy product wiki direct document disk reads; 269/488 question parsing; 297/485 fileText consumers.
- `src/product-wiki/questions.ts:57` (full path `<checkout>/src/product-wiki/questions.ts:57`): Second question Markdown parser and 178 YAML metadata parser; 201 audienceOf section extraction.
- `src/product-wiki/documents.ts:263` (full path `<checkout>/src/product-wiki/documents.ts:263`): Product document structural parser; 381 read callback consumer.
- `src/product/completeness.ts:25` (full path `<checkout>/src/product/completeness.ts:25`): docs/completeness.json filesystem reader and JSON/schema parser.
- `src/product/lifecycle.ts:114` (full path `<checkout>/src/product/lifecycle.ts:114`): Manifest direct read; 327 parseManifest direct read; 350 manifest editing read; 584 product tree hashing.
- `src/product/fill-stages.ts:195` (full path `<checkout>/src/product/fill-stages.ts:195`): Plugin lock from source text; 232 manifest stage configuration text.
- `src/knowledge/kinds.ts:805` (full path `<checkout>/src/knowledge/kinds.ts:805`): Manifest-loader family: workflows, kinds (830), contracts (876), lock (1583), manifest editing (1739). Allowed by role, requires precise boundary.
- `src/knowledge/workflows.ts:97` (full path `<checkout>/src/knowledge/workflows.ts:97`): Manifest-loader family: workflow YAML; 248 source text.
- `src/product/contract.ts:153` (full path `<checkout>/src/product/contract.ts:153`): Manifest-loader family: registry/contract YAML parser.

## Not product document readers

Read sites for /proc, installed executables/wasm, trace logs, writer journals, store settings, lock/PID files, release assets, built web assets and HTTP request/response bodies are infrastructure, not product documents. history-assertions.ts and sql-history.ts deserialize graph assertions/opinions, not product file blobs. Git ref and commit metadata reads are not document parsers. src/plugin is the permitted host boundary; src/product/manifest.ts is the permitted manifest entry. Other manifest-family helpers above need a precise loader boundary, not a blanket knowledge exemption.
