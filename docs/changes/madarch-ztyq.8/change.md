# A known name in an agent's page is a link, and every page lists the pages that mention it

Change: madarch-ztyq.8
Base: 96b0558801d17eacdeecd2a604351aca89a62ee2
Tasks: madarch-ztyq.8
Kind: behavior

## Intent
The owner read the shop's agent-written pages on 2026-10-24 and said: «Еще заметил, что бэклинков по тексту почти нет». The pages named Postgres, Kafka, the outbox, UC-1, BR-3 and glossary terms as plain prose; a reader could not open them, and the pages they named did not list the pages that mentioned them. The old backlink block refused graph subjects altogether, so an entity page had only its relations, and the document block looked for a first identifier with a regular expression over every line.

This change makes the mention the core's. After a page's own checks accept it, `checkPage` inserts a `madarch:` link at every plain-prose occurrence of a name the product knows: a document entity's identifier or title, a glossary term's synonym or code name, and a graph node's label. The page's structure — headings, code, existing links and images, link definitions, footnote definitions, comments, front matter and addresses — keeps the bytes the agent wrote. The names come from the product's documents and graph; the core names no product data. A name several entities share keeps every candidate and the page's own evidence chooses, or the mention stays plain.

Every page's entity template now carries a "Mentioned on"/«Упоминается на» block. It lists the product pages whose prose links to the page and the statements that ground or mention it, for document and graph pages alike, and is left out when nobody mentions the page. The block reads parsed, rendered Markdown, so a link in a comment or an unused footnote does not make a mentioner. Because the inserted links are reading aids, a task's impact follows the grounds a reached statement stands on, not those links.

PR #202 merged these commits at `b96a5904`; this record is the backfill on the change-records branch.

## Rationale
A reader who meets a known name in a sentence should be able to open its page without the agent knowing a key, and the page they reach should show who named it. Doing the insertion in the core makes it true for every writer unit and for an already-written page when it is checked again, while leaving the agent's prose otherwise byte-for-byte as written. The names are data because product kinds and identifiers differ per product; a hardcoded list would be wrong in the next product.

The conservative rules are deliberate. A shared label is not guessed: the page id, its sources, a link it already holds or its `relates` evidence decide, and otherwise the word stays plain. A title is how a page names itself, not a mention of itself. `-` and `_` are word characters so `UC-1` does not match inside `UC-1-extra`. The block reads rendered prose rather than characters so code, comments and unused notes do not create backlinks. And a mention link is not evidence for a task: following it would pull an unrelated page into a brief, so impact follows grounds only.

The generated product's walk falls with the new block: empty-section 3 288 → 3 252, raw-key 4 810 → 4 704, foreign-language 6 358 → 6 357, and `scripts/wiki-walk-baseline.json` is lowered to match. No new finding is introduced.

## Out of scope
- Linking names in an agent's conversation, tool answers or front matter: only the Markdown body of an accepted page is rewritten.
- Extracting new entities or changing the graph schema: the names are the product's existing document entities, glossary terms and graph node labels.
- A new screen, route or application layout: the "Mentioned on" block is drawn by the existing reference block in the existing entity templates, and the app's rendering of a `refs` block is unchanged.
- Rewriting an old product whose pages are not checked again: the links appear when a page is checked, and no separate migration writes them.
- A real model run; the tests answer with scripted pages and fixtures.

## Changes to requirements
- product-wiki/mentions (new): a known document identifier, title, glossary synonym or code name, or graph label in plain page prose becomes a `madarch:` link to its entity; structure keeps the agent's bytes; names are data; a shared name resolves only from page evidence or stays plain; a page does not link its own title; checking again is idempotent. Every page lists the pages whose prose links to it and the statements that ground or mention it, leaving the section out when empty, and invisible links do not count. Scenarios: `prose-links-all-known-names`, `names-resolve-from-page-evidence`, `every-page-lists-its-mentioners`, `invisible-links-do-not-mention`, `reading-aid-does-not-widen-task-scope`.
- product-wiki/front-matter (changed): the document form's backlink section is the same "Mentioned on" section, naming the product pages whose prose links to the page and the statements that ground or mention it, instead of a "Linked from" list of link fields, ids and addresses. Scenario: `backlinks-across-kinds`.
- product-wiki/architecture (changed): an element's page keeps its incoming and outgoing relations and now names the pages that mention it; a page links a known name as `mentions` describes, with an element id linked at a standalone, word-bounded occurrence and nothing wrapped inside code, fences or link targets. Scenario: `document-links-to-element`.

Complete proposed capability text: `capabilities/product-wiki.md`. It is the whole capability, not a hand-written delta.

## Preserved contracts
- product-wiki/pages: the page format, its front matter, the canonical form and the `madarch:` address resolution are unchanged; the pass inserts a link into accepted prose and adds a block the same renderer reads, and it invents no page or kind.
- product-wiki/stages: the writer still decides which pages need a unit, and the mention pass runs on the page a unit writes; it neither schedules a unit nor rewrites another page.

## Coverage
- product-wiki/mentions: test
- product-wiki/front-matter: test
- product-wiki/architecture: test
- product-wiki/pages: test
- product-wiki/stages: test

## Where it is seen

Kind: internal
Place: any page an agent wrote, and the "Mentioned on" section of a document or graph page in the wiki
Reason: no screen, route or control is added; the same pages carry new links in their prose and a new reference section, drawn by the existing block renderer.

1. Fill the shop product and open a page an agent wrote: Postgres, Kafka, the outbox, UC-1, BR-3 and the glossary terms in its prose open their pages; headings, code spans, comments and existing links keep the text the agent wrote.
2. Open one of those target pages: "Mentioned on"/«Упоминается на» lists the pages whose prose links to it and the statements that ground or mention it; a page nobody mentions has no such section.
3. Check the same page again, and compute a task's impact: the links do not change, an invisible comment adds no mentioner, and the task's pages follow the changed ground rather than a prose link.

## Blocking questions
None.

## Design and decisions
`src/writer/mentions.ts` is the implementation. It parses the page with remark and GFM and rewrites only the source slices of rendered text nodes, so structure is recognized rather than pattern-matched. It removes the front matter before scanning, skips the node types that are not prose, expands used footnote definitions, and skips comments and unused definitions. Names are collected from `documentMentionNames` (identifiers, titles, glossary synonyms and code names; document names are case-sensitive) and `GraphView.mentionNames` (graph labels, with paths, hashes, directories, content sections and unqualified lower-case symbols filtered out; graph symbol labels are case-sensitive). A name repeated across targets keeps a candidate list; `resolveMentions` uses the page id, title, sources, existing `madarch:` targets and `relates` as evidence and refuses to choose without it. Longest names are tried first, and identifier edges count `-` and `_` as word characters.

`checkPage` runs the page's own checks first and only then inserts links, so a page cannot become unacceptable because of a link. The insertion is idempotent: an existing `madarch:` link is structure and is never nested. `src/writer/tools.ts` merges document names first, then graph labels no document already names; `src/writer/run.ts` supplies the document names it already holds.

`linkedFromBlock` now serves graph subjects too. It reads the target key directly, resolves rendered `madarch:` targets with `madarchTargets`, asks the index for statements that rely on the key, and reads document identifier mentions with `identifierMentions` rather than a regular expression. `src/knowledge/seed.ts` adds the `mentionedon` block to the base entity template and removes the duplicate `linkedfrom` from `entity-text.liquid` and `term.liquid`; `src/knowledge/render.ts` drops a hidden empty reference block. `src/loop/impact.ts` stops adding `one.mentions` to the second hop, because those mentions are now the pass's reading aids.

## Acceptance evidence
The code is the merged PR #202 tree at `b96a5904` (the same tree was present in this repository before switching to the change-records branch). On that tree, 2026-10-29:

- `bun install --frozen-lockfile`: exit 0.
- `bun run check`: exit 0 (`tsc --noEmit`).
- `bun test test/writer-mentions.test.ts test/writer.test.ts test/knowledge-vertical.test.ts`: 82 pass, 0 fail, 126 610 expect calls, 395.42 s. This includes the structural cases (setext heading, indented and four-backtick fences, reference links and definitions, code spans, comments, unused footnotes, addresses), the shared-name and document-collision cases, own-title, identifier boundaries, idempotence, graph and document "Mentioned on", and the task-impact case.
- The commit records the walk before the ratchet: empty-section 3 288 → 3 252, raw-key 4 810 → 4 704, foreign-language 6 358 → 6 357.

The full repository suite and `test/madarch-init-e2e.test.ts` were not run for this backfill. No assertion or bound was weakened, and the branch is docs-only: it changes no product code or test.

## DONE WHEN
On the shop product, every known name in an agent-written page's plain prose is a link to its entity's page; headings, code, existing links, comments, footnote definitions, front matter and addresses keep the agent's bytes; checking a page again changes no link. Every document and graph page lists the pages whose prose links to it and the statements that ground or mention it under "Mentioned on"/«Упоминается на», leaves the section out when nobody mentions it, and counts no invisible link. A task's impact follows the changed statement's grounds rather than a prose mention, and the writer-mentions, writer and knowledge-vertical tests pass with the lowered walk baseline.
