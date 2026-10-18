# The document index stage: the pinned Markdown documents, their sections, their links and the task keys they name

Change: madarch-tzte-21-4
Base: 16f7567b55ba11e9cb01722b7de96695ceead18f
Tasks: madarch-tzte.21.4
Kind: no-behavior

## Intent

Decision 0026 makes the fill a set of deterministic stages that read a product's
repositories into the product graph; stage 6 is the document index. The graph's
vocabulary for it exists (`src/fill/facts.ts`: the `document`, `section`,
`document-link` and `task-key` kinds), the stage contract and registry exist
(decisions 0027, madarch-tzte.19.3), the snapshot reader and its two stages have
landed (madarch-tzte.21.1), and nothing reads a document into the graph yet: a
reader of the wiki cannot follow a document to the code it describes, nor to the
document beside it, nor to the task it belongs to.

After this change the fill holds a registered stage `document-index`. Its units
are the Markdown documents of the pinned repositories, named `document:` and
then the repository and the path, and a unit writes what its own document holds:

- one `document` node (the media type its name names, the title its first
  first-depth heading carries, the bytes it spans, the lines it stands at and the
  blob its bytes stand under, which is what the next run compares against);
- one `section` node per heading a reader sees (the anchor a reader's link names,
  the heading's words, their depth, the lines the section covers and the bytes it
  spans) — the heading tree, as the facts' document, depth and order say it;
- one `document-link` edge per end a section of the document names: the node of another
  Markdown document, the node of a code path the pinned commit holds, an address
  outside the repositories, a section of the document itself where the link is a
  fragment, and — for a path the pinned commit does not hold, a folder, an
  absolute target or a scheme-relative one — the target exactly as the document
  wrote it, with the place the link stands at. An unresolved link is written, and
  never dropped;
- one `task-key` edge per task key the document names, by the tracker's own rule;
- one `coverage` node saying what the read answered and what it could not read
  (a heading whose words name no anchor a link could name).

A second run after a one-document commit plans that document's unit alone: the
plan reads what the graph already holds for the repository and compares each
document's blob with the blob the pinned commit has, so a document that did not
move is no unit at all, and a document the commit no longer holds is a unit that
writes nothing, which is how a rename or a deletion is retracted. The bytes of a
document come through `SnapshotReader`; nothing here runs git, reads a working
tree or knows a machine path.

The stage reads a document the way the wiki already reads a product's page: a
line inside a fence or an HTML comment is an example and holds no section, no
link and no key; an inline code span's content is no link either; a relative
target is resolved by the wiki's own resolver (`.`, `..`, climbing out refused,
an address with a scheme outside the repositories); and a heading's anchor is the
one a reader of the rendered page follows (`Requirement: strict YAML` →
`requirement-strict-yaml`, a repeat `-1`). The marking of examples and the
resolution of a target are the wiki's own, so the graph and a rendered page agree
about what a link names and where a section begins. Two places the sharing is
this stage's own, and the record names them: a code span is masked however many
backticks open it, where the wiki's reader masks a single-backtick span, and the
fill's own address form, `/p/` and then a path, is read by the wiki's resolver as
the path its page stands at.

## Out of scope

- The snapshot reader and the snapshot and inventory stages (madarch-tzte.21.1):
  the stage reads their `SnapshotSource` and names their `file` nodes, and writes
  no tree fact of its own.
- The other deterministic stages of 0026 (build and configuration, syntax,
  semantic resolution, modules, history): they register beside this one.
- The fact storage, the bounded reads and the checked write path
  (madarch-tzte.20.2 to 20.4): the stage's plan read is written in the fill's own
  vocabulary and proved against a fake graph, and its draft is judged by
  `checkFact` plus its own validate; where a real storage answers the read is
  madarch-tzte.21.8's wiring.
- The orchestrator (madarch-tzte.19.5): the stage is proved through `plan`,
  `execute` and `validate` with a fake context.
- The agent stages that read documents (10, 12, 13) and the pages rendered from
  the graph (madarch-tzte.23): the facts are what they will read.
- The old fill pipeline under `src/product/fill*.ts`, its `taskKeys` reading and
  its claim extraction, which nothing of this change calls.
- Document forms other than Markdown: a `.txt`, a `.rst`, an `.adoc` or a
  `LICENSE` is stage 1's file with the `document` role, and this stage reads no
  headings from it. A symbolic link whose name ends in `.md` is stage 1's
  `symbolic-link` file: its bytes are the path it points at.

## Changes to requirements

None: no capability text of this product changes. The requirement these stages
serve is proposed by `fill-pipeline-monday`, which is not current, and the
rebuild's own requirement text lands with the stage that closes decision 0026
(madarch-tzte.21.8).

## Preserved contracts

- product-repository/manifest: unchanged — nothing here reads a manifest; the run's pins and its repositories reach the stage through the wiring (`SnapshotSource`), as madarch-tzte.21.1 left them.
- product-wiki/pages: unchanged — a page is still the product's Markdown in git read by `src/product-wiki/documents.ts`; this change reuses its link resolver and changes nothing of it, and no page reads a fact yet.
- release-binary/installers: unchanged — no dependency is added (`unified`/`remark` are not used by this stage) and nothing new is bundled; the stage runs no program.

## Coverage

- product-repository/manifest: test
- product-wiki/pages: test
- release-binary/installers: test

## Blocking questions

None.

## DONE WHEN

`br show madarch-tzte.21.4`: a registered stage `document-index` writes the
`document` and `section` facts of the Markdown documents of the code
repositories and the product repository (titles, heading tree, byte and line
spans), the `document-link` edges between them and to code paths, and the
`task-key` edges of the keys the documents name; a link to a path the pinned
commit does not hold is written unresolved with its place; a fixture of two
documents linking each other yields two documents, their sections and two
resolved links; a document is re-planned exactly when its blob moves; every byte
is read through `SnapshotReader`.

## Rationale

Kind `no-behavior`: the change adds a stage module and the schema fields its
facts need, and no command constructs the stage registry, so nothing a person
runs behaves differently — the same shape madarch-tzte.21.1 landed for the first
two stages. The one change to landed modules is the two kinds' value shapes
(below), which no producer wrote before this change.

## Design and decisions

- **A unit is one document, and the plan names it from the graph.** The unit id
  is `document:<repository>:<path>` and its scope `<repository>:<path>`, the
  inventory's own shape (madarch-tzte.21.1). The plan makes one tracked read per
  repository — `{"read": "stage-6-published-documents", "repository": "…"}`,
  answered with a row per `document` fact the graph holds (`kind`, `repository`,
  `path` and the `blob` it stood under) — and plans a document whose blob moved
  or that is new, plus a published path the pinned commit no longer holds as a
  Markdown document (whose unit writes nothing: the retraction request). Rows are
  read strictly: a row that is not an object, names another repository or another
  kind, holds a path that is no repository path, a blob that is no blob id, a
  path twice, or a key the read does not name (a run id among them) refuses the
  plan, naming the read, the row and the field. A graph that answers nothing
  plans every document, which is what a first run is, and a repository that holds
  no Markdown anywhere answers `nothing-found` rather than an empty plan of a
  kind that reads as "no producer".
- **The `document` and `section` kinds gain the spans the DONE WHEN names, and
  they move alone.** `DocumentValue` gains `blob` (the git blob the document's
  bytes stand under) and `bytes` (its size: the byte span is `[0, bytes)`); its
  line span is the fact's own place, which the kind already requires.
  `SectionValue` gains `startByte` and `endByte` (the section's byte span); its
  line span is its place, as for a document. Both fields are optional and neither
  is part of an identity, so a document read again is the same document with the
  same id — the blob is what tells one reading of it from the next, exactly as
  `FileValue.blob` does (madarch-tzte.21.1). The two kinds' versions move to 2,
  as `facts.ts` says a kind whose value changes moves, and
  `test/fill-facts.test.ts`'s moved-kind table names them.
- **A document is a file the tree holds, by its name.** `.md`, `.markdown` and
  `.mdx` are the Markdown names (the media type is `text/markdown`, and `text/mdx`
  for `.mdx`); a submodule's commit holds no bytes of this repository and a
  symbolic link's bytes are the path it points at, so neither is a document. This
  is the DONE WHEN's "the Markdown documents"; the other document forms stage 1
  already names with the `document` role are left to it, deliberately (above).
- **The bytes are read once, and the spans are counted on them.** `SnapshotReader`
  answers the document's bytes; the stage splits them on the newline (a carriage
  return before a newline is not part of a line's text, so a CRLF document reads
  as the same lines a reader sees, which is what the wiki's own reader folds) and
  decodes each line as `readText` decodes a file: UTF-8, the byte order mark kept.
  Every section's byte span is the offsets of its lines in those bytes, and its
  line span is its own place, whose columns are the line's UTF-16 length; the
  document's line span is `wholeFileRange`'s answer over the lines as a reader
  sees them — the function the inventory exports, so a whole file's range is
  counted once in the fill, with one difference the record states: a CRLF file's
  carriage returns are not characters of this stage's lines (the wiki's own reader
  folds them), while stage 1's `file` fact counts a file's raw lines, so the two
  differ by one column on the last line of such a file. The document's *byte*
  span is the commit's bytes exactly, carriage returns included. A section runs
  from its heading's line to the line before the next heading at any depth, its
  trailing blank lines out.
- **A heading is one a reader's renderer sees.** One to six `#` within three
  spaces of the margin (four make a code block), followed by a space unless the
  heading is empty, a closing sequence of `#` removed; a line inside a fence or
  an HTML comment opens nothing; `#tag` is a word. The marking of examples is the
  wiki reader's own rule, and the stage names what it does not mark: an indented
  code block holds no heading (a `#` there stands further in than three spaces),
  and the wiki reads a link written in one as a link too. A link reaches the
  stage with the line's code spans masked, so a link inside one is no link, and a
  label that wraps over a line's end reaches no reader here — a bound the wiki's
  reader shares. A target written with a title (`[a](b.md "T")`) or in angle
  brackets is read as the wiki reads it: the whole target, which resolves to
  nothing, so the link is written unresolved with its place rather than dropped.
- **The anchor is the one a link follows.** The heading's words as a reader sees
  them (an inline link's label, a code span's content), lower cased, every
  character that is not a letter, a digit, a space, `-` or `_` dropped, each run
  of whitespace one `-`; a repeat within the document takes `-1`, `-2`, …. A
  heading whose words name no anchor opens no section and its place is a
  `coverage` gap (`unsupported`), so a shorter heading tree is never silent.
- **A link is resolved inside the repository the document stands in.** The pins
  of a run are the product's repositories, code repositories and the product
  repository alike, and each document's links are paths of its own repository: a
  product document's link written through the `repos/<name>/…` mount into a
  connected repository stays unresolved, because which mount names which
  repository is the wiring's business (madarch-tzte.21.8) and not a path this
  stage may read. The plan and the unit treat every pinned repository the same
  way, so the product's own documents are indexed like any other repository's.
- **A link's end is a node of the graph, an address, or the target as written.**
  A fragment names a section of the linking document, compared as the document
  writes it — an `id` a browser looks up is exact, so `#B` reaches no section
  written as `b`, and the link keeps its place as an unresolved one — (a `section`
  node the same
  unit writes); a target with a scheme is an address outside the repositories; a
  target the wiki's resolver ties to a path the pinned commit holds names that
  path's node — the `document` node where the path is a Markdown document named
  by this stage, the `file` node the inventory published for it otherwise. Both
  ids digest the repository and the path alone, so this stage names a node
  another stage or another unit publishes without writing it. Everything else —
  a path the commit does not hold, a folder, an absolute target, a
  scheme-relative one — is a literal holding the target as the document wrote it:
  the schema's three term forms leave a node end that names nothing impossible, so
  an unresolved link is written with its place and never dropped. A link's
  identity is the node it stands in and the end it names (the schema's own
  `from` and `to`), so the same end named twice under one section is one edge, at
  the first place the document names it, and the same end named under two
  sections is two edges, each at its own place. A task key is folded the same
  way: one key under one section is one edge.
- **A link stands in the section that holds it.** The edge's `from` is the
  `section` node whose lines hold the link's line, and the `document` node where
  none does (a link before the first heading); the edge's place is the line and
  the columns the link covers. A `task-key` edge is written the same way, and the
  key's place is the key's own columns.
- **A task key is read by the tracker's own marker, and by the shape of a
  tracker's id.** The marker is `Task:` or `Tasks:` (case-insensitive — a commit
  message writes the first, a change record's header writes the second) anywhere
  on a structural line; after it the keys are the run of tokens the tracker's own
  reader splits on (commas and whitespace), each read whole and with the
  punctuation that surrounds it in a sentence taken off (a full stop, a comma, a
  bracket), and a token is a key when what remains is shaped as a tracker's id —
  a letter first, then one or more `-`- or `.`-separated parts of letters and
  digits (`madarch-tzte.21.4`, `madarch-1xq`) and nothing else. The run ends at
  the first token that is no key and at a token that opens a bracket, so the
  sentence a marker stands in and the file names further along its line are no
  keys: a date (`2026-10-17`) and a time (`15:14`) begin with a digit, a word of
  prose carries no separator, and a key the sentence wraps (`Task:
  madarch-tzte.21.4),` or `Task: madarch-p45j.4.`) is read. The rule's bound is
  the shape: a hyphenated word *inside* the run reads as a key, since nothing
  tells `release-notes` from `madarch-1xq` (an open point below). Stage 7's own
  `taskKeys` splits a commit message's `Task:` line and takes every token, which
  a document's line cannot do; stage 7 writes the same kind, so
  `FACT_KINDS['task-key'].stages` names both stages and
  `EDGE_END_KINDS['task-key'].from` names the kinds both write it from
  (`commit`, `document`, `section`), which the facts test's stage-order check
  reads. A key written inside a code span or a fence is an example, no key.
- **The stage consumes what it names, and its own kind.** `snapshot` and `file`
  are required: a link to a code path names the node stage 1 published, so the
  derived graph runs the inventory first — the stage graph orders itself, nothing
  declares an order. `document` is required and is the stage's own kind, which is
  how its plan reads what its earlier run published (0027: a stage that consumes
  what it produces reads its own earlier publication, and is not starved for want
  of another producer). Its produced kinds are all owned at the `file` scope,
  since every fact of a unit stands at the unit's own document.
- **A cancelled unit raises, and a unit that writes nothing asks for a
  retraction.** The signal is checked before the reader opens and after it: a
  cancelled unit raises rather than returning an empty draft, because an empty
  draft is how this stage asks for a retraction and a cancellation must never
  retract in silence. That a publication replaces a unit's facts with none is
  madarch-tzte.20.2's semantics, which nothing landed defines yet — the same open
  point madarch-tzte.21.1 recorded.
- **Every error names what it is about.** A plan's refusal names the read, the
  row's place and the field; a unit's refusal names the scope it was given and
  what is not a repository name or a repository path; a draft's refusal names the
  write's place in the draft, what the write cites and the fact's own path and
  place.

## Acceptance evidence

Open points for the integrator, in the order they matter:

- The plan's read (`publishedDocumentsRead`) is the contract this change hands
  madarch-tzte.21.8: the wiring of a run must answer it from the graph's
  `document` facts, each with the blob its bytes stood under. Its row shape is
  strict, and a graph that answers nothing plans every document, which is what a
  first run is.
- The retraction this stage asks for (a unit that publishes nothing) needs
  madarch-tzte.20.2's publication to replace the unit's facts with none; nothing
  landed defines that (madarch-tzte.21.1 recorded the same point). Until it does,
  a deleted document's facts stay in the graph, and the test's claim is what this
  change can prove: the vanished path is planned, the unit writes nothing, and no
  write of the run names it.
- `document` and `section` move to version 2 with the byte spans this change's
  DONE WHEN names. No other stage produces or reads those kinds today; the first
  consumer (stage 10) reads the fields, and a fact written at version 1 by
  nothing is not a fact of any run.
- A link from a product document into a connected code repository — written
  through the product's `repos/<name>/…` mount — is written unresolved with its
  place: which mount names which repository is the run's wiring (madarch-tzte.21.8,
  as madarch-tzte.21.1 recorded), and this stage resolves a target within the
  repository the document itself stands in. The plan reads and writes every
  pinned repository the same way, the product repository among them, so the
  product's own documents are indexed like any other repository's.
- The two kinds' spans are optional in the schema, as `FileValue.bytes` and
  `FileValue.blob` are: this stage always writes them, and the schema does not
  refuse a fact that leaves one out. A reader that needs a span asks the fact for
  it.
- A document's links are read per line, as the wiki's reader reads them: a label
  whose target reaches over a line's end, a reference-style link (`[a][b]` with
  `[b]: docs/c.md`) and a link written with a title or in angle brackets reach no
  reader here and are written unresolved (a reference-style link is not read at
  all, so it is not a fact either). The wiki shares the first bound; the change
  record names the others so a later task can widen them deliberately.
- Stage 7's `taskKeys` (madarch-tzte.21.2, a commit message) and this stage's
  `taskKeysOf` (a document line) read the tracker's one marker from two shapes of
  text: a commit message's `Task:` line holds keys and nothing else, so stage 7
  splits the line on commas and whitespace and takes every token; a document's
  line holds prose after the keys, so this stage reads the marker anywhere on the
  line, both spellings, and takes the tokens whose text, once the punctuation
  around them is off, is shaped as a tracker's id. On a line that is a key list
  the two agree; on a line that is a sentence they cannot, and this stage's rule
  is the one a document needs (stage 7's would read the sentence's words as
  keys). A later task may give the rule one home, with stage 7's tests read again
  against it.
- The task-key rule is a marker, a run and a shape, and nothing else: a
  hyphenated word inside the run after a `Task:` marker (`Task: release-notes`)
  is read as a key, because no shape tells it from `madarch-1xq`. A document
  that opens its key list with prose therefore names keys the fill reads.
  Narrowing this needs something the fill does not have today — the project's own
  key prefix, or the run's task list as input — and is a later task's, not this
  one's.
- Mutation is not run (the owner's rule runs Stryker once per assembled stage);
  acceptance escalates per `mutationFallback`.

Owner approval pending (coordinator).

The independent review and the checks are recorded on task madarch-tzte.21.4:
`bun run check`, the focused suites on the SkyPilot pod, the feature document
gate, green CI on the exact SHA and one independent review round. Mutation is
not run: the owner's rule runs Stryker once per assembled stage.
