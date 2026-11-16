# Mentions in text and JSON strings become edges, with hints for plain names

Change: madarch-64o5.120
Base: d9a0d32904ec6d033177de9f53f3af9ee66f9788
Tasks: madarch-64o5.120
Kind: behavior

## Intent
Decision 0039 items 5, 6 and 29. A uid token in a text field or a JSON string names a vertex: the one writer records the
occurrence as a `mentions` edge of the assertion that holds the string, with the field's RFC 6901 pointer and the
token's code-point span as its discriminator, and refuses a token that names no active vertex. A text stated again
retracts the mentions it left, in the same transaction, as that source's own statement. A plain name is never guessed:
every text write's answer carries the unlinked spans with every same-named candidate, and the entity page lists them
under «Упоминания без ссылки», each with a kit Button that links the one the reader chose.

## Rationale
The owner: «Все сущности у нас — вершины графа» and «эта ссылка называется Reference», and for names: «payments это
может быть домен, и payments это может быть подсистема. Это же разные вещи». The audit behind 0039 found text holding
references as scalar names, and an agent able to write without the kind/type check. The write answer and the page both
point at the same dictionary, so what an agent is offered and what a person sees cannot differ.

## Out of scope
- Linking a name from another entity's text through the page: the page lists the names its own entity's text holds.
- Backlinks drawn from token mentions beside the declared edge kinds: the page's backlinks section keeps reading the
  declared relations; a mention traversal of all statements is not drawn yet.
- Screen mockups: this box has no browser (chromium or puppeteer), so the record names the page's place and its texts
  instead of pictures; the owner's review may ask for them from a worker with a browser.

## Changes to requirements
- graph-storage/mentions: add
- graph-storage/mention-hints: add
- graph-storage/mention-dictionary: add
- graph-storage/unlinked-mentions: add

## Preserved contracts
- product-wiki/internationalization: unchanged; the section's words come from both locale catalogues (test)

## Coverage
- graph-storage/mentions: test
- graph-storage/mention-hints: test
- graph-storage/mention-dictionary: test
- graph-storage/unlinked-mentions: test
- product-wiki/internationalization: test

## Where it is seen
Kind: request
Place: an entity's page in the served wiki, the MCP write tools, and the page's one mutation on `POST /graphql`.

1. Open the page of a term whose body names a stated domain in plain text: the section «Упоминания без ссылки» lists
   the name with the domain's own label and kind.
2. Press the candidate's Button: the `linkMention` mutation runs at `/graphql`, the page is read again with the name
   replaced by the token, and the term's body holds the token.
3. Ask the MCP `put_entity` tool the same text: its answer carries the same unlinked span and candidates.

## Blocking questions
None.

## Design and decisions
The grammar lives in `src/graph/mention-text.ts` (token scanner over decoded strings, RFC 6901 walk, Aho–Corasick over
exact names) and its graph half in `src/graph/mention-graph.ts`. The dictionary is `src/graph/mention-dictionary.ts`,
read once from the same assertion read the graph uses. The writer asserts each mention as the source's `$exists` of the
`system.assertion-mentions` edge and retracts the previous statement's mentions; a mention whose text left is therefore
not active, and the row stays as history. The page reads `Entity.unlinkedMentions`; the Button sends the page's one mutation, `linkMention`, to the same
`/graphql` endpoint every read uses. The executor opens a write transaction for that operation alone, binds the
reader's person source to the write contract and writes the field through the one writer; no route is added.

## Acceptance evidence
Static: `bun run check` passed: `tsc --noEmit` clean; architecture 874 violations found, 874 listed in
`.architecture/violations.json` (no gained entry; `graphql-only-reads` 0 after the command route is named in the
allowed list); UI architecture 0; catalog 501 kinds read, no finding on 117 page-holding kinds; workflows 4; quarantine
0. The wiki app's `bun run check` passed: `tsc --noEmit` clean and UI architecture 0.
Test: `test/mention-text.test.ts`, `test/graphql-writes.test.ts` and `test/page-contract.test.ts` passed together:
54 passed, 0 failed (the mention grammar's 12; the writes suite's 27, including the new changed-text retraction, the
unlinked-mentions read with two same-named candidates and the press that links the shown span; the entity template's
section list). `test/authored.test.ts`, `test/authored-import.test.ts`, `test/manual-operation.test.ts`,
`test/system-overlay-binding.test.ts` and `test/graphql-writes.test.ts` passed together: 49 passed, 0 failed, after the
authored view was narrowed to the kind's own declared fields (a person's form states what the kind declares, not the
system's synonyms) and a producer's slots were checked against the write contract. The wiki app's suite passed: 127
passed, 0 failed, including `mentions.test.tsx`'s 3 (two candidates of two kinds each named with its kind, the press
sending the `LinkMention` mutation to `/graphql` with the exact span, an all-linked text drawing nothing).
The full `test/` run with `MADARCH_PLUGIN_SANDBOX=off` (this box has no delegated cgroup) fails the same suites as the
base commit d9a0d329 does, measured by running them in a worktree of that commit: the disk/git fill fixtures, the
init/start commands, the draft templates, the golden fixture SDL, the catalog row check and the parent-bound fact case
that the run's 5 s unnamed bound stops. None of them is new.
Mutation: not run, filed per the stage rule.
Review: pending; this record is for the review.

## DONE WHEN
A token in text or a JSON string is a `mentions` edge with its pointer and span, a token naming no vertex is refused,
a changed text retracts the mentions it left, every text write's answer carries the unlinked names with each
candidate's kind label through MCP too, and an entity's page lists the names its text leaves unlinked with a kit Button
that links one as the reader's statement.
