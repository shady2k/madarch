# An agent writes the product page and the domain pages as grounded Markdown in the product repository

Change: madarch-m38l.2
Base: 65d1b549541b44d88532e75e794a0656587a2e19
Tasks: madarch-m38l.2
Kind: no-behavior

## Intent
After the deterministic fill, one agent unit for the product and one per domain read the temporal graph and the product's documents through checked tools and write `docs/product.md` and `docs/domains/` pages in the product repository, in the format of the vertical's shared formats (section 1): front matter, `madarch:` entity links, and a footnote of grounds at the end of every statement sentence. The write tool checks every ground (a graph key that exists at the fill's last commit, or a document section that exists) and every link before it writes, refuses a statement-looking sentence with no grounds, and sends every refusal back to the agent within a bounded number of attempts. The core serves file content from the graph's content nodes, so an agent has no repository access. Same graph, same prompts and same answers give the same files.

## Out of scope
- Rendering these pages in the wiki: the sibling task madarch-m38l.1 reads them.
- A real agent run on the training repository: it needs the owner's explicit yes with the agent and the cap.
- Wiring the writer into the fill orchestrator's stages; it is a command until the vertical is accepted.
- Pages for kinds other than the product and its domains.

## Rationale
New modules under `src/writer` and one command script that nothing in the product calls yet. The one change to existing code is typing: the unit MCP server accepts any tool catalogue (`McpToolDefinition`), so the writer's tools reuse its protocol code; the fill's own tools are unchanged. The test fixture ACP agent learns to speak to an HTTP MCP server, as a real agent does.

## Preserved contracts
- product-repository/manifest: the writer reads a graph and writes two kinds of Markdown file; the manifest and its behaviour are unchanged.

## Coverage
- product-repository/manifest: test

## Where it is seen

Kind: command
Place: bun scripts/write-knowledge.ts, which writes docs/product.md and docs/domains/ pages into a product repository
Reason: the pages are read in the wiki once the engine task of the vertical renders them; today a person reads the written files.

1. A person fills the graph and runs the writer in one command: `bun scripts/write-knowledge.ts --repository /srv/training-repository --output /srv/training-product --product-name "Training shop" --agent claude-code --store /srv/writer-store`.
2. The command prints each unit as it ends, with its write attempts and tool calls, and the refusals of a unit that failed.
3. The person opens docs/product.md and docs/domains/payments.md in the product repository and sees, after each statement, a footnote whose grounds are `madarch:` links that open a graph key or a document section.

## Blocking questions
None.

## Design and decisions
Decision 0029 (the pages are Markdown in the product repository, the graph indexes them) and decision 0026 (agents read only through the graph, in bounded units: a 272K window with a wrap-up at 70% and a stop at 80%, 30 turns, ten minutes, 16K output). The format is the vertical's shared formats, section 1. The writer's choices inside it:
- A statement sentence is any sentence of two or more words (or holding a `madarch:` link) outside headings, "See also" lines and link-only lines; it must end in footnote references placed right after its full stop.
- Tables, fenced blocks and raw HTML are refused: a table or a diagram would carry statements without grounds, and the engine draws diagrams from the graph.
- A ground is a graph key as the graph's `recordKey` holds it, or `doc:path#anchor` where the anchor is a heading slug, the slug of a list item's leading bold phrase, or the identifier such a phrase or heading starts with (UC-2, BR-4, ADR-0001).
- The product unit declares the domains with the page: slug, title, summary and evidence that must resolve. Each declared domain must be linked from the product page, and gets one unit. A domain may be named only with evidence in the graph.
- A page is written in canonical form (front matter in the format's key order, sorted and de-duplicated relations and sources, footnotes numbered by first use), so determinism does not depend on the agent's numbering.
- File content reaches an agent only from `engine:content` nodes, which the writer stores (one publication, producer `writer.content`) for the text files of the last filled commit; a file it cannot store is named with its reason.

## Acceptance evidence
To be filled with the test runs on the pod.
