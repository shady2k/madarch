# Document meaning

Capability: document-meaning

## Purpose

How the wiki reads a person's Markdown documents: each document as a tree with
the exact place of every node, its sections classified in three passes in a
fixed order, the pass recorded, a number treated as an alias and never as the
identity, and what the documents lack said where a person reads it. This is
section 4 of decision 0032, apart from the pages the writer draws from these
entities (that is the writer's own capability) and apart from the stage that
fills the classifier's answers from jev and the agent.

## Requirement: document-tree — Every document is a tree with the exact place of every node

Every Markdown document shall be read by a real Markdown parser — unified with
remark and GFM — and never by expressions over its lines, into a tree whose nodes
are headings, paragraphs, lists and their items, code blocks, quotes, tables and
HTML blocks. Every node shall carry the first and the last line it covers, its
character offsets in the document's text, the same range as UTF-8 byte offsets,
its source as the document writes it, and its text with the Markdown marks
removed.

A document's front matter shall be read as metadata, not as a section, and shall
leave every line number and every offset after it as the document has them; the
text before a document's first heading shall be a section of its own. A section
shall be a heading, the blocks it holds itself, and the heading texts that
enclose it, with the document's own text (the line that names it aside). A node
the parser gives no source range to shall be a finding naming the file and the
line, and a document the parser cannot read shall be a finding, never a document
read as smaller.

The conventions a document is read by shall be the product's data in its manifest
— which kinds exist, the identifier prefixes a kind takes, the documents whose
leading bold words are terms, the headings whose sections are entities of a kind,
the general kind a passage means and the sections a kind holds — and the engine
shall name no heading, prefix or word of any document.

### Scenario: ranges-are-exact
- Given: the training repository's requirements document, whose second use case is a list item over lines 8 to 10
- When: the document is read into a tree
- Then: the item's node names lines 8 and 10, its character offsets and its byte offsets, and the document's text cut at those offsets is the node's source as written

### Scenario: bytes-not-characters
- Given: a document whose heading is written in Cyrillic
- When: it is read
- Then: the heading's range is 10 characters and 18 bytes, and its text is the heading without the mark

### Scenario: front-matter-is-metadata
- Given: a document that opens with front matter naming a section's kind, then a sentence, then a heading with a paragraph
- When: it is read
- Then: the front matter is read as fields and is no section, the sentence before the first heading is a section of its own at its own line, and the heading's section holds the paragraph at the line the document gives it

### Scenario: headings-declared-by-the-product
- Given: a manifest declaring the heading `Qualities` for a kind, and a document whose `## Qualities` section holds two plain list items
- When: the document is read
- Then: each item is an entity of that kind, and a product that declares another heading is read by its own declaration with no change to the engine

## Requirement: classification-passes — A section is classified by three passes, in this order, and the pass is recorded

What a section is shall be decided by three passes, each tried only when the pass
before it named nothing, and each recorded on the entity it decided:

1. Metadata: the document's front matter (`sections:`, a heading and the kind its
   passages are) and the manifest's conventions — an identifier prefix (`UC`
   takes `UC-2`) and the documents whose leading bold words are terms.
2. Structure: a kind's declared headings, whose list items — or paragraphs, when
   the section holds no list — are its entities; and a kind's declared structure,
   the sections a section of it holds, each a child heading or a paragraph that
   opens with its name and a colon, and a missing one a finding on the section.
3. The classifier (see `semantic-classifier`).

Every entity shall record the pass that decided it, the general kind it was read
as, and the heading texts that enclose it. A heading that opens with an
identifier shall be its whole section, from its heading to the last line before
the next heading of the same or a higher level, so an architecture decision keeps
its Status, Context, Decision and Consequences. A reading shall never rewrite a
document's own text, and a second section with the same anchor shall be a finding
that names both lines.

### Scenario: pass-is-recorded
- Given: the training requirements document and the product's own manifest
- When: it is read
- Then: UC-1 to UC-4 at lines 5, 8, 12 and 14 and BR-1 to BR-5 are decided by the metadata pass, and the two items of `## Qualities` by the structure pass, each entity naming its pass and its general kind

### Scenario: unnumbered-section-holds-entities
- Given: a section whose heading the manifest declares, holding two list items that carry no number
- When: the document is read
- Then: two entities, each with its own line, its own text and its anchor from the anchor reader, and no number is required of either

### Scenario: identifier-heads-its-whole-section
- Given: an architecture decision record whose heading opens with `ADR-0001`
- When: it is read
- Then: one entity from line 1 to the last line of the file, holding its sub-sections' text and the reasons it gives

### Scenario: structure-is-checked
- Given: a decision record that holds a Context and a Decision and no Status and no Consequences, and a manifest declaring those four sections
- When: it is read
- Then: a finding at the section's line names the two it lacks, and the entity still shows the document's own text

## Requirement: semantic-classifier — A typed classifier reads what the first two passes leave, and its answers are data

The third pass shall be a typed interface that answers, for one section, one
reading per passage: the general kind the passage is — `scenario`, `actor`,
`rule`, `quality`, `decision`, `procedure`, `term` or `other` — the passage's
lines and its text. The interface shall be synchronous, so that a host fills it:
the production host from answers kept in the product's store (a file beside the
product, never in the repository, keyed by the document, the enclosing headings
and the section's text), which jev and the agent fill; every committed check
shall fill it with a deterministic classifier that answers from a table of
headings and runs no model.

A section that holds several meanings shall be split by the interface into its
passages, and a reading shall be shown as the kind whose `semantics` names it. A
reading of a general kind that no kind names, a section no classifier has read
and a block no reading covers shall each be a finding at their file and line,
never a passage dropped. Without a classifier the third pass shall decide nothing
and invent nothing.

### Scenario: several-meanings-split
- Given: a section of two paragraphs and a classifier that answers `rule` for the first passage and `quality` for the second
- When: the document is read
- Then: two entities of the two kinds, each with its own line and the document's own words, and the section's own text unchanged

### Scenario: answers-are-stored-beside-the-product
- Given: a product's store holding one answer for the first of a section's two passages
- When: the documents are read with the stored classifier
- Then: the answered passage is an entity of its kind, and the passage no answer covers is a finding at its line

### Scenario: unread-section-is-a-finding
- Given: a classifier that has read nothing of a section no manifest convention names
- When: the document is read
- Then: no entity, and a finding at the section's line saying that what it means is not shown

### Scenario: no-classifier-invents-nothing
- Given: no classifier at all
- When: a document is read
- Then: a section no manifest convention names yields no entity and no finding, and nothing is invented

## Requirement: stable-identities — A number is an alias; a section's identity is kept beside the product

A number such as `UC-1` or `BR-3` shall be an alias the document writes, never the
identity. Every entity shall carry a stable identity, kept in a mapping beside the
product — in the product's store, never in the repository — by document, with the
identity, the anchor, the kind and the digest of the text of each section.

A section that keeps its anchor shall keep its identity; a section whose text is
unchanged shall keep it through a renumbering; a section that neither the anchor
nor the text knows shall be new and get a new identity from a counter that only
moves forward; a document a read does not see shall keep the identities it had; a
mapping that cannot be read shall be a finding with its file and line, and its
sections shall read as new. The wiki's page id shall stay the document's path and
its anchor after a hash, as the wiki names a document section today, and each
anchor shall be one the one anchor reader names: a heading's slug, a
bold phrase's slug, an identifier, or, for a block that no name covers, the
enclosing heading's anchor and the block's place among the unnamed blocks of that
section (`qualities.1`).

### Scenario: renumbered-document-keeps-identities
- Given: the training requirements document, and a copy of it with the `UC-` and `BR-` numbers taken out
- When: both are read with the same mapping
- Then: the same entities with the same stable identities, every alias gone, the anchors following the changed words, and every text identical to the numbered document's

### Scenario: renamed-heading-keeps-identity
- Given: a document read once, and read again after its section heading is renamed to another heading the manifest declares
- When: both reads are compared
- Then: both entities keep their stable identities and their anchors follow the new heading

### Scenario: new-section-gets-a-new-identity
- Given: a document read once, and read again with one section added to the section that stood last
- When: both reads are compared
- Then: three entities, the first two keeping their identities, the third one new

### Scenario: identities-live-beside-the-product
- Given: a product's store folder
- When: a mapping is written and read back
- Then: it is the file `doc-identities.json` there, it reads back as it was written, and no file of the product repository holds an identity

## Requirement: missing-kinds — The wiki says what the documents lack

A manifest may declare in `documents.expect` the kinds its documents must hold. A
kind so declared that no section of any document is read as shall be a finding
naming the manifest's file and full path, the line the expectation stands on, the
kind and the general kind it means. A kind the documents do hold shall not be
reported. An expectation that names a kind the manifest does not declare, or a
kind whose entities do not come from documents, shall be a finding of the
manifest at its own line. The starter manifest `madarch new` writes shall declare
the four document kinds a product's documents are expected to hold: use cases,
business rules, requirements and decisions.

### Scenario: missing-kind-is-a-finding
- Given: a manifest declaring and expecting a user-story kind, and a requirements document that holds no user story
- When: it is read
- Then: exactly one finding, naming the manifest's full path, the line of the expectation and the kind with the general kind it means

### Scenario: held-kind-is-not-reported
- Given: a manifest that expects a use-case kind and a document that holds use cases
- When: it is read
- Then: no finding is made for that kind

### Scenario: starter-set-expects-four-kinds
- Given: a product made by `madarch new` whose documents hold none of the four kinds the starter manifest expects
- When: its wiki reads the documents
- Then: four findings, one per kind, at the line that declares `documents.expect`; and given the training product, whose documents hold all four, then no finding at all

## Coverage limits

- The classifier's answers are not produced by this change: the interface, the
  store beside the product and its reader are, and the stage that fills them from
  jev and the agent belongs to another unit of decision 0032's section 1. No model
  runs in any check of this capability.
- The cost of the three passes and the classifier's thresholds are not tuned here.
- A reset of a product's knowledge keeps the identity mapping, which is not among
  the store's entries a reset removes, so identities survive a rebuild.
