# The graph indexes the product's Markdown: pages, statements and their grounds are nodes and edges, so backlinks and changed grounds are queries

Change: madarch-m38l.8
Base: 290a1fa5fb3a9479e1e2aba0335341ed76c5d3ac
Tasks: madarch-m38l.8
Kind: no-behavior

## Intent
Decision 0029 says the graph indexes the product repository's Markdown together with the code facts. Today the agent's pages are read from Markdown on each request and joined in memory, a statement exists only as a footnote, and nothing records what a page was written from. This change makes the index real: on every fill and every page write one producer publishes, for the product repository's knowledge pages, page nodes, statement nodes (`statement-of` the page), `grounded-by` edges from each statement to its grounds (a graph key, or a document section node `path#anchor` with its text digest), `mentions` edges for entity links in the text and `relates` edges from the front matter. Deleting the graph and refilling restores the same nodes from the Markdown: the Markdown is the source, the graph is the index.

Three queries serve the wiki: the statements that rely on a graph key (the backlinks an entity page shows as "statements that rely on this entity"), the counts per kind for the catalogue, and the grounds that changed since a page was written (the digest of each ground at the page's written-at commit against now, recomputed from git and never stored in the page file).

The owner agreed two additions to the page format (2026-10-23), which this change makes in the writer and in the vertical's shared format, section 1:
- Named footnotes are stable statement ids: `[^refund-window]`. The writer generates a readable slug from the sentence, keeps a name while its sentence stands across rewrites, gives every statement its own footnote, and a page with numbered footnotes stays readable.
- The front matter records the page's basis, per repository the page was written from: `written-at: [{ repository, commit, branch, origin }]`. The engine turns origin, commit, path and lines into the web address on GitHub, GitLab, Bitbucket and Gitea/Forgejo, for ssh and https remotes; a host it does not know gets no link rather than a wrong one.

## Out of scope
- Drawing the backlinks, the catalogue counts and the "Open in GitHub" links in the wiki: the wiki app belongs to the walk-remarks task (madarch-m38l.4); this change delivers the queries and the link builder they call.
- Questions, answers and corrections as indexed kinds: the same mechanism, added when those pages exist.
- The incremental update that reacts to a changed ground (madarch-m38l.7): this change delivers the query it needs.
- A real agent run: it needs the owner's explicit yes with the agent and the cap.

## Rationale
The index is new modules under `src/knowledge/index` that depend on the graph store and on pure functions of the page; the writer calls it after a page is written, and a rebuild reads the Markdown from the product repository. The graph vocabulary gains four product relation types and three node kinds in the product namespace (`knowledge:` keys), so the engine's own namespaces are untouched.

## Preserved contracts
- product-repository/manifest: the manifest is read as before; the index adds no key to it.

## Coverage
- product-repository/manifest: test

## Where it is seen

Kind: command
Place: bun scripts/index-knowledge.ts, which rebuilds the graph index of a product's Markdown pages and prints its counts
Reason: the wiki that draws backlinks and changed grounds is another task's; today a person runs the rebuild and reads the counts.

1. A person runs `bun scripts/index-knowledge.ts --product /srv/training-product --store /srv/writer-store` after the writer ran.
2. The command prints the pages, statements, grounds, mentions and sections it indexed, and the statements whose grounds changed since the page was written.

## Blocking questions
None.

## Design and decisions
Decision 0029 and the vertical's shared formats. Choices inside them are recorded as the work proceeds.

## Acceptance evidence
To be filled with the test runs on the pod.
