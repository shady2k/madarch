# Document meaning

Capability: document-meaning

## Purpose

How the wiki reads a person's Markdown documents: each document as a tree with
the exact place of every node, every anchor, section and extent read from that
tree and never from an expression over the document's lines, the sections
classified in three passes in a fixed order with the deciding pass recorded, a
number and an anchor treated as aliases of a durable identity, and what the
documents lack said where a person reads it. This is section 4 of decision 0032,
apart from the pages the writer draws from these entities (that is the writer's
own capability) and apart from the stage that fills the classifier's answers from
jev and the agent.

## Requirement: document-tree — Every document is a tree, and every name and extent is read from it

Every Markdown document shall be read by a real Markdown parser — unified with
remark and GFM, exactly once per reading — into a tree whose nodes are headings,
paragraphs, lists and their items, code blocks, quotes, tables and HTML blocks.
Every node shall carry the first and the last line it covers, its character
offsets in the document's text, the same range as UTF-8 byte offsets counted
against the document as it is written, its source as the document writes it, and
its text with the Markdown marks removed.

The anchors a ground may name, the lines a part covers and the text a passage
holds shall be read from that tree alone: no expression over a document's text
shall decide what a heading, a block or a passage is. A Setext heading — text
over a line of `=` or `-` — is a heading to the parser, so it carries an anchor
like an ATX one. A document's front matter shall be read as metadata, not as a
section, and shall leave every line number and character offset after it as the
document has them; the text before a document's first heading shall be a section
of its own. A node the parser gives no source range to shall be a finding, and a
document the parser cannot read shall be a finding, never a document read as
smaller.

The extent a part covers shall be the node's own: a heading covers its whole
section — its blocks and its sub-sections — and a list item or a paragraph covers
itself and only what stands under it, never a sibling that follows it. A finding
about a document shall name both places it stands in: the identity a reader
navigates by — the product's path, or `repos/`, the repository's name and the
document's path — and, where the reader knows it, the absolute path of the file
on this machine.

A passage shall be every block a kind may decide, found by one recursive walk of
the tree that visits every container at any depth: a paragraph (a quote's or a
footnote's as well as the section's own), a list item — an item nested under
another, or holding a quote, a list, a table or a footnote of its own, is a passage
of its own — and a table's cells. A cell that opens with an identifier is the
passage of its row and its body holds every cell's words, in row order; a row no
cell names is one passage per cell, so no cell's words are lost beside another's.
A table's first row, when the table holds more than one, names its columns and is
no passage. Every other block shall be a leaf that holds text no kind reads (code,
HTML, a thematic line), and a block kind the product names in `documents.ignore`
shall be furniture no reader reports.

An identifier's text shall be the parser's own decoded values of the inline nodes
that carry it, never a source decoded a second time: an escaped dash and a
character reference are one character each in the node's value, and a reference no
code point holds is literal text. The span that names a passage shall be cut from
the source the parser gave it — the identifier only, where the kind names a
passage by its number, or the whole bold phrase where the kind names it by its
leading bold words — and the marks that close on the identifier go with it
(`**BR-1**`, the emphasis of `BR-*1*`). The body shall therefore be the content minus
that span and nothing else, taken as the document's own source: two wholly bold
rules keep the words inside their bold phrases, and an escape in the words after
the identifier (`Match \*paid\* literally.`) survives as written.

The conventions a document is read by shall be the product's data in its manifest
— which kinds exist, the identifier prefixes a kind takes, the documents whose
leading bold words are terms, the headings whose sections are entities of a kind,
the general kind a passage means, the sections a kind holds and the block kinds
that hold no passage — and the engine shall name no heading, prefix or word of any
document.

### Scenario: a-row-and-a-nested-item-are-passages
- Given: a section holding a table row whose first cell names `BR-1` and a list item nested under another item that names `BR-2`
- When: the section is read
- Then: each is an entity with its identifier and the words after it as its body (`Never charge twice.` in both), the row's body being the cells after its naming cell, and the outer item is a passage of its own beside the item nested under it

### Scenario: an-identifier-is-the-parsers-text
- Given: a rule whose identifier is written with an escaped dash, with a character reference, in lower case, in bold, with the emphasis on part of it, and a document holding a character reference no code point has
- When: the document is read
- Then: every spelling names the same identifier and leaves the same body behind, and the reference no code point holds is literal text, never a crash

### Scenario: ranges-are-exact
- Given: the training repository's requirements document, whose second use case is a list item over lines 8 to 10
- When: the document is read into a tree
- Then: the item's node names lines 8 and 10, its character offsets and its byte offsets, and the document's text cut at those offsets is the node's source as written

### Scenario: bytes-are-the-source-bytes
- Given: a document whose front matter holds a field written in Cyrillic, and a heading in Cyrillic after it
- When: it is read
- Then: the heading's byte range counts the bytes the source writes, not the single bytes of the masked front matter, and its character count is the source's

### Scenario: setext-sets-an-anchor
- Given: a document whose section is written as a Setext heading, its text over a line of `=`
- When: its anchors are read
- Then: the section carries the anchor of its text, its block carries the anchor of that heading and its place in it, and the section's text is the source from that heading to the next one

### Scenario: front-matter-is-metadata
- Given: a document that opens with front matter naming a section's kind, then a sentence, then a heading with a paragraph
- When: it is read
- Then: the front matter is read as fields and is no section, the sentence before the first heading is a section of its own at its own line, and the heading's section holds the paragraph at the line the document gives it

### Scenario: a-sibling-is-not-the-section
- Given: two bold items of one section, side by side, and the paragraph that follows them
- When: the extent of the first item and the extent of the section's heading are read
- Then: the item's extent is its own lines alone, so a change to the second item or to the paragraph is no change of it, and the heading's extent covers every line of the section

### Scenario: headings-declared-by-the-product
- Given: a manifest declaring the heading `Qualities` for a kind, and a document whose `## Qualities` section holds two plain list items
- When: the document is read
- Then: each item is an entity of that kind, and a product that declares another heading is read by its own declaration with no change to the engine

### Scenario: a-finding-names-both-places
- Given: a document read from a code repository's checkout, holding an identifier twice
- When: the second section is refused
- Then: the finding names the repository's path with its line and the absolute path of the file on this machine

## Requirement: classification-passes — A section is classified by three passes, block by block, and the pass is recorded

What a passage is shall be decided by three passes, each tried only when the pass
before it named nothing, each recorded on the entity it decided, and each decided
for the passage itself — one identified rule shall not hide the unnumbered rule
that stands beside it in the same section:

1. Metadata: the document's front matter (`sections:`, a heading and the kind its
   passages are) and the manifest's conventions — an identifier prefix (`UC`
   takes `UC-2`) and the documents whose leading bold words are terms.
2. Structure: a kind's declared headings, whose blocks — a list item, or a
   paragraph — are its entities; and a kind's declared structure, the sections a
   section of it holds, each a child heading or a paragraph that opens with its
   name and a colon, and a missing one a finding on the section.
3. The classifier (see `semantic-classifier`).

Every entity shall record the pass that decided it, the general kind it was read
as, the heading texts that enclose it and the ids of the identity it was given. A
heading that opens with an identifier shall be its whole section, from its
heading to the last line of the section, so an architecture decision keeps its
Status, Context, Decision and Consequences. A reading shall never rewrite a
document's own text. A passage that the first two passes leave and that no
classifier read — because none is wired, or because it answered nothing for that
passage — shall be a finding of its own, at its line, with the passage's own words:
it is never a passage that disappears, and a document read without a classifier
says what it could not decide rather than showing a smaller wiki. A second section with the same anchor shall be a finding
that names both lines.

### Scenario: pass-is-recorded
- Given: the training requirements document and the product's own manifest
- When: it is read
- Then: UC-1 to UC-4 at lines 5, 8, 12 and 14 and BR-1 to BR-5 are decided by the metadata pass, and the two items of `## Qualities` by the structure pass, each entity naming its pass and its general kind

### Scenario: unnumbered-section-holds-entities
- Given: a section whose heading the manifest declares, holding two list items that carry no number
- When: the document is read
- Then: two entities, each with its own line, its own text and its anchor from the anchor reader, and no number is required of either

### Scenario: one-identified-rule-hides-no-other
- Given: a section the manifest declares, holding an identified rule and, below it, an unnumbered rule
- When: the document is read
- Then: two entities of the kind, the first decided by the metadata pass and the second by the structure pass, and no finding

### Scenario: an-unread-passage-is-said
- Given: a document holding two passages that no pass reads, one numberless and one that opens with a number the manifest takes no kind for
- When: the document is read without a classifier
- Then: each passage is a finding of its own at its line, naming the identity, the file on this machine and the passage's own words, and saying that no page shows it

### Scenario: identifier-heads-its-whole-section
- Given: an architecture decision record whose heading opens with `ADR-0001`
- When: it is read
- Then: one entity from line 1 to the last line of the file, holding its sub-sections' text and the reasons it gives

### Scenario: structure-is-checked
- Given: a decision record that holds a Context and a Decision and no Status and no Consequences, and a manifest declaring those four sections
- When: it is read
- Then: a finding at the section's line names the two it lacks, and the entity still shows the document's own text

## Requirement: semantic-classifier — A typed classifier reads what the first two passes leave, keeps its passages whole, and its answers are data

The third pass shall be a typed interface that answers, for the passages the
first two passes left, one reading per meaning: the general kind the passage is —
`scenario`, `actor`, `rule`, `quality`, `decision`, `procedure`, `term` or
`other` — the passage's lines and its text. The interface shall be synchronous,
so that a host fills it: the production host from answers kept in the product's
store (a file beside the product, never in the repository, keyed by the document,
the enclosing headings and the section's text), which jev and the agent fill;
every committed check shall fill it with a deterministic classifier that answers
from a table and runs no model.

A passage that holds several meanings shall be split by the interface into its
readings, and every reading shall keep the span it named: the lines it covers and
the words the document writes there, validated against the source, with an anchor
of its own — the block's when it is the block's only reading, and the block's
anchor with the reading's place in it otherwise. A reading whose text is not the
document's text of its span shall be a finding. A reading of a general kind that
no kind names shall be a finding at its line, a reading of `other` shall be shown
nowhere and said nowhere, and a block that no reading covers shall be a finding
of its own. Without a classifier the third pass shall decide nothing and invent
nothing.

An answer kept in the store shall hold its lines counted from the section's first
line, never an absolute line of one read: a paragraph inserted above an unchanged
section moves the section's lines, and the reading shall be rebased onto the
lines the section has now rather than name the wrong passage.

### Scenario: several-meanings-split
- Given: one paragraph that holds two meanings and a classifier that reads both in it
- When: the document is read
- Then: two entities, each with its own anchor — the paragraph's and the paragraph's with the second reading's place — and each holding the words its reading named, and the paragraph's own text unchanged

### Scenario: answers-are-stored-beside-the-product
- Given: a product's store holding one answer for the first of a section's two passages, its lines counted from the section's first line
- When: the documents are read with the stored classifier
- Then: the answered passage is an entity of its kind, and the passage no answer covers is a finding at its line

### Scenario: an-answer-moves-with-its-section
- Given: that same store, and a paragraph inserted above the section
- When: the documents are read again
- Then: the reading names the same words at the section's new lines, and no finding says a passage is unread where it stands

### Scenario: unread-section-is-a-finding
- Given: a classifier that has read nothing of a section no manifest convention names
- When: the document is read
- Then: no entity, and a finding at the section's line saying that what it means is not shown

### Scenario: no-classifier-invents-nothing
- Given: no classifier at all
- When: a document is read
- Then: a section no manifest convention names yields no entity and no finding, and nothing is invented

## Requirement: stable-identities — A number and an anchor are aliases; a page is named by a durable identity kept beside the product

A number such as `UC-1`, and the anchor a section stands at, shall be aliases the
document writes, never the identity. Every entity shall be given a durable
identity, minted once from its document's own counter and kept in a mapping
beside the product — in the product's store, never in the repository — by
document, with the identity, the anchor the section stands at now, the kind and
the digest of the text of each section. The counter shall only move forward, so a
name it has given is never given to another section, not even after the section
that held it is removed and an unrelated passage takes its number; and the name
shall hold a colon, which no heading slug and no block anchor can spell, so a page
id and a source anchor are two kinds of reference that never collide. The
page id a link names, the address of an entity's page, the name of its localized
source and the place its interpretations are kept shall be built from that
identity, so renaming a heading or removing a `UC-`/`BR-` alias changes no link;
an anchor shall stay a display and a way to resolve a ground: a ground written as a
source anchor shall open the entity the CURRENT document gives that anchor — or
the document at that line when no entity does — and an anchor the document no
longer has shall be a broken section, never a fallback to an older identity; a
page id shall open the entity its identity names, whatever anchor it stands at now; and
an address whose fragment is a source anchor — a page or a link written before
identities were minted — shall open the passage the document gives that anchor
now, so an older page keeps opening its passage. An address that names a
repository, written with a qualifier before the path, shall be read in that repository, and
one that names none shall be looked for in the product repository first and then
in each connected one.

Identities shall be reconciled by content first and by anchor second, with
ambiguity left to the next pass: a digest held by exactly one previous section
and written by exactly one section pairs them; a digest or an anchor several
sections claim pairs none of them; and only then does the anchor a section stands
at decide. So two numbers swapped exchange nothing, a passage inserted before the
others shifts nothing, a renamed heading keeps its page, a section neither pass
matches is new, and a document a read does not see keeps the identities it had. A
new identity shall be a name no other identity of the document holds, so two
sections never share a page. A mapping that cannot be read shall be a finding
with its file and line, and its sections shall read as new.

### Scenario: renumbered-document-keeps-identities
- Given: the training requirements document, and a copy of it with the `UC-` and `BR-` numbers taken out
- When: both are read with the same mapping
- Then: the same entities with the same durable identities and the same page ids, every alias gone, the anchors following the changed words, and every text identical to the numbered document's

### Scenario: an-older-page-keeps-opening
- Given: a glossary page written before identities were minted, whose link addresses its term by the source anchor `payment-token`
- When: the page is opened
- Then: the term's page opens, and after the term's phrase is renamed the page id minted for it still opens that same term, while an address naming the anchor it no longer writes names nothing

### Scenario: a-repository-qualified-address
- Given: a product with a connected repository holding `docs/requirements.md`, and the page id that names the repository, the document's path and the passage's durable identity
- When: the id and a ground naming the same document's anchor are resolved
- Then: both open the passage's page, read in that repository, and an address naming a repository that holds no such document is a broken link with that reason

### Scenario: a-ground-and-a-page-id-are-two-kinds
- Given: a document whose passages stand at `uc-1` and `uc-2`, and a second read in which the two numbers have changed places while each passage keeps its identity
- When: a ground written as `uc-1` and a page id of the first passage are resolved against the document as it now stands
- Then: the ground opens the passage the document gives `uc-1` now, the page id opens the passage its identity names, and a ground naming an anchor the document no longer has is a broken section

### Scenario: two-numbers-swapped-exchange-nothing
- Given: a document read once, and read again after `UC-1` and `UC-2` changed places
- When: both reads are compared
- Then: each passage keeps its durable identity and its page id, and only its anchor and its alias follow the number the document writes now

### Scenario: an-insertion-shifts-nothing
- Given: a document read once, and read again with an unnamed passage written before the others in its section
- When: both reads are compared
- Then: every earlier passage keeps its identity and its page, and the new passage is given one no other identity holds

### Scenario: renamed-heading-keeps-identity
- Given: a document read once, and read again after its section heading is renamed to another heading the manifest declares
- When: both reads are compared
- Then: both entities keep their durable identities and their page ids, and their anchors follow the new heading

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
