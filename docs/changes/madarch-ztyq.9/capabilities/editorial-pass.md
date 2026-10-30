# Editorial pass

Capability: editorial-pass

## Purpose
A fill reads the reader pages it has just written as a newcomer would: does one fact say the same thing on every
page, is a glossary term called by its own name, and does a reader's sentence carry a graph key, a path or a code
name? Everything that can be found from the pages' own grounds, the glossary passages and the graph is found by
deterministic checks first. An assigned editing role is then asked, through a judge seam, for at most a stated
number of revisions per page. The pass itself writes nothing: findings and requests are journal entries, and the
page's own writer unit reworks only the passages that were named.

## Requirement: after-the-batches — The pass reads the reader pages after the page batch and again after the overview

After the product and domain pages of a fill have been written, and before the guide pages run, the writer reads
the product and domain pages that stand and runs the editorial pass over them. After the overview page has been
written, it runs once more over the complete set, now including the overview. A pass reads the files as they stand
at that point and returns findings and requests; it writes no page. A writer run that is given no editorial option
keeps the behaviour it had before this capability.

### Scenario: the-batch-precedes-the-overview
- Given: a fill of the training product that writes the product page and the domain pages, and an editorial pass with a judge
- When: the page batch has been written and the overview has not
- Then: the report records one pass at point `batch`, whose pages include the product page and a domain page and do not include the overview

### Scenario: the-complete-set-is-read-last
- Given: the same fill, after its overview page has been written
- When: the final editorial pass runs
- Then: the report records a pass at point `overview`, whose pages contain every page of the batch and the overview, and the judge is asked twice in all

## Requirement: deterministic-findings — Conflicting facts, glossary aliases and internal identifiers are found without a model

Before any judge is asked, the pass reads every page as Markdown statements with their grounds, and reads the
glossary terms from their parsed term bodies. It reports three kinds of finding, each naming the page, the
passage, the line and a message in words:

- two statements on different pages that stand on the same ground, have the same word shape and state different
  complete numbers are a conflicting fact; numbers are compared by value, so `9` and `09` agree as `1,000` and
  `1000` do;
- a glossary term's synonym from its own term body used in a reader's sentence where the term's title is absent is
  a glossary alias; a label inside a fenced code block is code, not a synonym;
- a graph-held key, file path or code name that stands in a reader's sentence is an internal identifier; the graph's
  own keys and properties are the source, the longest name wins, and no word list decides what counts.

### Scenario: one-fact-two-values
- Given: two pages whose statements stand on the same ground and say that a refund takes nine and fourteen days
- When: the pass reads the pages
- Then: it reports a conflicting fact naming both pages, both passages and both values, and asks for one revision of one of them

### Scenario: a-glossary-synonym-and-a-code-label
- Given: a glossary term whose body names the synonym «аккаунт», a page that calls the term «аккаунт», and another page whose fenced code block contains that label
- When: the pass reads the pages
- Then: the reader's sentence is a glossary alias naming the term and the synonym, and the label in the code block is not a finding

### Scenario: an-identifier-in-prose
- Given: a page whose reader-facing sentence names a key, path or code name the graph holds
- When: the pass reads the page against the graph
- Then: it reports an internal identifier naming the value and its kind, and asks that the sentence use the reader's words instead

## Requirement: bounded-requests — A judge may name only a page and passage it was shown, within the per-page and whole-pass bounds

The pass hands a judge only the pages' titles and their statements, each with its id, line and text, together with
the deterministic findings and the per-page bound. A request must name a page and a passage the pack showed, and
must carry a non-empty change and reason of at most 2000 characters each; anything else is refused in words and
not acted on. Deterministic requests come first, then the judge's, and no page receives more than the bound and no
pass returns more than twelve requests. The per-page bound is a persisted product setting, an integer from 0 to 12
whose default is 2; 0 runs the deterministic checks and skips the model reading, and an absent or nonsensical bound
falls back to the default rather than becoming unbounded. The setting reaches a fill through the fill start, and a
change to the product's model roles does not delete it.

### Scenario: a-request-outside-the-pack-is-refused
- Given: a judge that names a page or a passage the pack did not show, or gives no change or reason
- When: its answer is read
- Then: the request is refused in words, nothing is revised for it, and the rest of the answer is still bounded and considered

### Scenario: the-per-page-bound-holds
- Given: a product whose editorial bound is 1, and two findings on two passages of one page and one on another
- When: the pass returns its requests
- Then: the first page receives one request, the other page receives its one, and every finding and accepted request is journaled

### Scenario: zero-still-checks
- Given: a product whose editorial bound is 0, and a page pair with a conflicting fact
- When: a fill runs with an editing role assigned
- Then: no model is asked, the deterministic conflicting-fact finding is reported and journaled, no revision is requested, and the pages remain as written

## Requirement: scoped-revisions — Only the passages the pass named may change, and a refused revision leaves the page as it stood

The pass returns requests; it never edits a page. The writer reworks a requested page through the unit that owns
it — the product unit, a domain unit or the overview unit — with the page as it stands and the named passage ids
as a revision scope, fresh bounds and no unit events. The writing tools compare the page before and after as
parsed Markdown blocks and grounded statement segments. A revision may rewrite a named passage and its grounds;
it may not change an unnamed passage, add, remove or move prose outside it, change a heading or code block, or
change a footnote or reference definition no named passage stands on. Front matter is not compared. A successful
revision replaces only the named prose. A refused revision restores the page's bytes, reports the full path and
line, and leaves the outcome and page the unit wrote in place; it is not a new attempt of that unit.

### Scenario: a-change-beside-the-passage-is-refused
- Given: a page whose first and second sentences are separate grounded statements, and a request naming only the first
- When: the revision also changes the second sentence, or inserts a new paragraph
- Then: the write is refused with `revision-scope`, the refusal names the file, the line and the full path, and the page on disk is byte-identical to the page before the revision

### Scenario: the-named-passage-may-change
- Given: the same page and a request naming only its second sentence
- When: the revision changes the value in that sentence and keeps its ground
- Then: the write is accepted, that sentence changes, and every other passage remains as it was

### Scenario: a-refusal-keeps-the-written-outcome
- Given: a written domain page, and a revision whose agent refuses the write
- When: the editorial point finishes
- Then: the page is the one the domain unit wrote, the domain still reports `written` once, and the report names the failed revision as an editorial problem

## Requirement: editing-role — An explicitly assigned editing pair reads the pages; a fallback writing pair is not asked

When the fill start carries resolved model roles, the editing role is read from them. Only a pair the reader
assigned to `editing` starts the ACP judge; an unassigned editing role does not silently use the writing pair to
edit the pages it just wrote, and the skip reason says so. A host judge of first resort (jev), when given, reads
the whole pack before the editing role; only the pages the jev names as unread are then handed to the editing
role. A jev that read every page means no editing model is asked. A judge that fails is a warning: its pages stand,
the deterministic findings remain, and the run reports the failure.

### Scenario: the-jev-reads-first
- Given: a host jev that reads every page, and an explicitly assigned editing pair
- When: the pass runs
- Then: the jev sees the whole pack, the editing role is asked about no page, and the pass returns the jev's requests

### Scenario: no-fallback-editor
- Given: a product whose writing role is assigned and whose editing role is not
- When: its fill starts
- Then: no editing judge is started for the writing pair, the deterministic checks still run, and the skip reason says the editing role is not assigned

### Scenario: a-failed-judge-does-not-withdraw-a-page
- Given: an editing judge that throws while reading the pages
- When: its answer would have been read
- Then: an `editorial-warning` is journaled, the deterministic findings and requests stand, and the pages the writer wrote are unchanged

## Requirement: journal — Every finding, request, skip and warning is recorded at the point where it happened

Each pass records its findings, accepted requests, skip reason and judge warnings in the fill journal as entries of
kind `editorial-finding`, `revision-request`, `editorial-skip` and `editorial-warning`, under the editorial pass's
unit and with the pass point (`batch` or `overview`) in the entry's arguments. The writer's report carries the same
findings, requests, problems and the pages of each pass. No revision is hidden: a request that is not journaled is
not a request the pass made.

### Scenario: a-request-is-a-journal-entry
- Given: a pass that finds a glossary alias and accepts a request for it
- When: the pass returns
- Then: the journal holds one `editorial-finding` and one `revision-request` for the same page and passage, and the request's arguments name the pass point

### Scenario: a-skip-is-never-silent
- Given: a fill with no editing judge that can be asked
- When: the deterministic checks finish
- Then: an `editorial-skip` entry carries the reason, the findings and deterministic requests are still present, and no page is reworked

## Quality requirements
- Performance: the deterministic checks read each page once and walk the graph in pages of at most 200 nodes, up to ten pages; an ordinary reader page set is checked without a model call.
- Reliability and recovery: the pass writes no file; a refused or failed revision restores the page's bytes, and a failed judge leaves every written page standing.
- Security and data protection: a judge sees only the titles, statements, ids and lines of the pages it was handed, together with findings and the bound; no file path outside the shown pack is accepted in a request.
- Data: findings and requests are journal entries; the per-page bound is a product setting saved in `writer.json`; the pass keeps no other state.
- Usability: every finding and refusal names the page, the line and the full path where one exists, and the settings page shows and saves the bound.
- Compatibility and operation: the pass is part of a normal fill; a run with no editorial option, or with no assigned editing pair, keeps every page byte-identical to what the writer wrote.

## Context
Decision 0032, section 6: the wiki is for people first; an editorial unit reads the pages as a newcomer and sends
bounded revision requests to the units that wrote them. Decision 0029 supplies the page format and grounding rules
the revision scope preserves.

## Coverage limits
The deterministic checks find the three stated kinds; they do not judge whether a page is well written in general.
The pass does not rewrite a page itself, does not start without an explicitly assigned editing pair, and does not
invalidate downstream units in this change.
