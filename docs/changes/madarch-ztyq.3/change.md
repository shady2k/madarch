# Documents are read by meaning: a parsed tree, three passes each recorded, a number only an alias with a stable identity beside the product, and the kinds the documents lack said

Change: madarch-ztyq.3
Base: b125f8cadb494e902788d67b2aeb7d38ccd07a53
Tasks: madarch-ztyq.3
Kind: behavior

## Intent
The owner read the wiki of 0.2.4 and found the documents read by their numbering: the owner's words on 2026-10-24 were «Документы далеко не всегда содержат номера в стандартном виде типа UC-1» and «Где US? Где функциональные и не функциональные требования?». The code agreed — `sectionsOf()`/`kindOfSection()` took a section only when it opened with an identifier, so the training product's unnumbered `## Qualities` section, with its two quality requirements, yielded nothing at all, and the wiki showed a smaller picture of the documents than the documents hold. This change reads every document with a real Markdown parser into a tree that carries the exact place of every node, classifies its sections in three passes — explicit metadata and the manifest's conventions, the document's own structure, then a typed classifier — and records which pass decided, so an unnumbered section is read as well as a numbered one. A number such as `UC-1` becomes an alias and never the identity: stable identities are kept in a mapping beside the product, so renumbering or renaming a section keeps its links. What the documents lack is said where a person reads it, and the starter manifest now expects the four document kinds a product's documents are meant to hold, so a product without user stories or quality requirements says so.

## Rationale
The change adds behaviour a person sees: sections that were not shown are now entities of the wiki, the pages their entities open keep their identity when the documents are renumbered, and the Problems page and the server's log name the kinds the documents lack. It is therefore a behavior change with deltas in a capability. No capability described how documents are read: the capability `document-meaning` is new, and its complete proposed text is in `capabilities/document-meaning.md`, taken from the code as it now stands. The baseline is `b125f8cadb494e902788d67b2aeb7d38ccd07a53`, the commit this branch is cut from, and no capability file of `docs/system/capabilities/` is changed by this record.

The block anchors this change adds also exposed a defect the closure of a task had carried silently: a task's section scope took its end from the next anchor in the document, so a section that held a bold item or a plain paragraph was cut off there and a commit that changed a later line of it closed nothing. The section's extent is now read from the headings alone (`headingLines()` in `src/knowledge/anchors.ts`), a reading kept beside `anchorLines()` with the reason the two differ, and a regression closes a task on a commit that changes the last line of a section holding both.

## Out of scope
- The stage that fills the classifier's answers from jev and the agent, and the split the agent makes of a passage it reads: this change builds the typed interface, the store beside the product and its reader; the stage belongs to another unit of decision 0032's section 1.
- The pages the writer draws from these entities, their templates and Liquid: the writer's own capability (decision 0032, sections 1 and 8).
- Validation of the graph (decision 0032, section 3) and asking a question once (section 5).
- The other defects of the coordinator's walk: extraction repairs, history and time, page content and navigation, contracts, diagrams.
- A real model run: every committed check answers the classifier with a deterministic fake, and no check of this change starts an agent.

## Changes to requirements
- document-meaning/document-tree (new): every Markdown document is read by a real parser into a tree whose nodes carry their exact lines, character offsets and byte offsets, its front matter is metadata and not a section, and the conventions a document is read by are the product's manifest data. Scenarios: `ranges-are-exact`, `bytes-not-characters`, `front-matter-is-metadata`, `headings-declared-by-the-product`.
- document-meaning/classification-passes (new): a section is decided by three passes in a fixed order — metadata, structure, classifier — and every entity records the pass that decided it, the general kind it means and the headings that enclose it; a document's own text is never rewritten. Scenarios: `pass-is-recorded`, `unnumbered-section-holds-entities`, `identifier-heads-its-whole-section`, `structure-is-checked`.
- document-meaning/semantic-classifier (new): the third pass is a typed, synchronous interface answering one reading per passage of a general kind, filled by the host from answers kept beside the product and by a deterministic fake in every check; a passage that means several things is split by it, and a reading no kind names, an unread section and an uncovered block are findings. Scenarios: `several-meanings-split`, `answers-are-stored-beside-the-product`, `unread-section-is-a-finding`, `no-classifier-invents-nothing`.
- document-meaning/stable-identities (new): a number is an alias, never the identity; stable identities are kept in a mapping beside the product, a renamed section keeps its identity through its anchor and a renumbered one through its text, a new section gets a new one, and the page id stays the document's path with its anchor after a hash. Scenarios: `renumbered-document-keeps-identities`, `renamed-heading-keeps-identity`, `new-section-gets-a-new-identity`, `identities-live-beside-the-product`.
- document-meaning/missing-kinds (new): a kind the manifest declares in `documents.expect` that no section of any document is read as is a finding naming the manifest's file, full path and line, and the starter manifest expects use cases, business rules, requirements and decisions. Scenarios: `missing-kind-is-a-finding`, `held-kind-is-not-reported`, `starter-set-expects-four-kinds`.

Complete proposed capability text: `capabilities/document-meaning.md`. It is the whole capability, not a hand-written delta, and no capability file of `docs/system/capabilities/` is changed by this record.

## Preserved contracts
None.

## Coverage
- document-meaning/document-tree: test
- document-meaning/classification-passes: test
- document-meaning/semantic-classifier: test
- document-meaning/stable-identities: test
- document-meaning/missing-kinds: test

## Where it is seen

Kind: log
Place: the log of the server serving a product, where a fill says what its documents' kinds are, and the product's Problems page, where the same lacks stand with the manifest's file and line

1. Serve a product made by `madarch new` whose documents hold none of the four kinds the starter manifest expects — a product with no `docs/` folder, say — and press a fill of it.
2. Read the log of the server that serves it while the fill runs: a line names the product's `madarch/kinds.yaml`, the line of its `documents.expect`, and the kind no section of any document is read as.
3. Open the product's Problems page: the same lacks stand there, each under the file and the line that declares it, fixed by the person who writes the documents.
4. Open the wiki of the training product, whose documents hold all four kinds: no such line and no such problem stands, and the Requirement kind lists the two quality requirements of its unnumbered `## Qualities` section.
5. Renumber one business rule in that product's `requirements.md`, read the wiki again, and open the rule's page: it is the same page, its link unchanged, while its anchor follows the words the document now writes.
