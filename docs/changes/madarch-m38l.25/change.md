# Every page and every kind list is a file an agent reads

Change: madarch-m38l.25
Base: 1b55fdf3
Tasks: madarch-m38l.25
Kind: behavior

## Intent
An agent that can read a Web address should reach a product's wiki without scraping the app. Every entity page and every kind's list shall answer as Markdown and as a documented JSON document beside its HTML, and the product shall offer `/llms.txt` naming those addresses. A reader's HTML page shall name its Markdown sibling, so the file is discovered from the page a person opens.

## Out of scope
- The graph, MCP and other agent surfaces named in the same milestone: they are other tasks.
- A second renderer: the files are the page's own blocks serialised at the route and serialisation layer, not a second render of the templates, which are moving to LiquidJS in parallel (madarch-u3vw.1).
- A JSON Schema file under `schema/`: `bun run schemas` reproduces `schema/*.json` byte for byte, and the task's public format is documented here and asserted by tests instead.
- A real agent run: the tests use scripted fixture data only.
- New dependencies: the serializer uses the `unified`, `remark-parse` and `remark-gfm` readers the tree already holds, and writes Markdown itself.
- The owner-approval record: the coordinator writes it.

## Changes to requirements
- product-wiki/agent-files (added): every page and every kind list as Markdown and as a versioned JSON document, the product's `/llms.txt`, the HTML alternate link, the document schemas and their refusals. Complete proposed text and scenarios are in `capabilities/product-wiki.md`.

## Preserved contracts
- product-wiki/discussions: no discussion, plan, task or write surface changes; the new addresses are read-only and do not alter a page's HTML behaviour.
- product-wiki/pages: an entity page and a kind page keep their HTML text, addresses and statuses; the `/api/k/page`, `/api/k/entities` and `/api/k/block` answers the app reads keep their shapes, and `format=markdown` stays as it is.
- product-wiki/app: the served app's own addresses and files are untouched, and the alternate link names the Markdown sibling without changing the page's behaviour.

## Coverage
- product-wiki/agent-files: test
- product-wiki/discussions: test
- product-wiki/pages: test
- product-wiki/app: test

## Where it is seen

Kind: request
Place: a served product's entity and kind files — the `.md` and `.json` addresses of `/k/e/` and `/k/kind/` — and its `/llms.txt`

1. An agent asks for a page's `.md` and reads its text and links without the app.
2. The same page's `.json` carries every block as a section of a documented shape.
3. A kind's `.md` and `.json` hold every entity of the kind, not one page of them.
4. `/llms.txt` names every declared kind and the addresses of its lists.
5. The HTML page's head carries a `link` element with `rel="alternate"` and `type="text/markdown"`.

## Blocking questions
None.

## Design and decisions
The page model the app already draws is the only source: `src/knowledge/page-files.ts` turns its blocks into one documented JSON document and renders the Markdown from that same document, so the two answers cannot disagree. A page is asked for with `defer: false`: the block addresses the app uses to fetch diagrams one by one are an artefact of the first screen, not of the page, and a file that omitted them would be silently smaller. Every block type has a section type and an exhaustive switch; nothing falls through to a default that drops a block.

`madarch:` links are resolved by the page's own `resolutions` map. The link nodes are found by parsing the block's Markdown with the `unified` + `remark-parse` + `remark-gfm` readers already in the lockfile — no regular expression is applied to source or document text — and each resolved address is then substituted textually, key by key, including the `<…>` form. A link that does not resolve keeps its words, gains the reason beside them, and is listed as broken in the JSON.

The file suffix is the only addressing rule: `.md` or `.json` is stripped once from the end of the path, so an id that itself ends in `.md` stays whole, and the remainder is percent-decoded. An empty name and an unreadable escape are 400 rather than silently becoming another entity; an unknown id or kind is 404 naming what was asked and, for a kind, the product folder.

Kind lists are read with the graph's own cursor, 500 at a time, until the cursor says there is no more, and the answer is refused 500 when the pages read disagree with the list's own total or the cursor does not advance. The operations catalogue is not special-cased: its list's total already includes the channels of actual contracts, and the file serves that list.

A product home's prefix is passed into the knowledge part and written into every document address, because the shell's `withProductPrefix` rewrites HTML only. `/llms.txt` is a route of each product's handler; the products home strips the product prefix before forwarding, so the handler itself knows its addresses. The HTML alternate link is injected into the served shell before the same prefix rewriting, so it points inside the mounted product.

The public shapes are versioned names, `madarch.page.v1` and `madarch.kind.v1`, not files under `schema/`: the reproducibility check compares `schema/*.json`, and the change would otherwise have to teach it a second document family for no reader's benefit. The tests assert the top-level keys, the section types and the shapes of links, places and diagrams, so a shape that changes by accident fails them.

## Acceptance evidence

The checks below run in `/workspace/repo/work` with `bun` 1.4.2 and `PATH` holding `$HOME/.bun/bin`.

Red, against the base revision `1b55fdf3` with the implementation removed from `src/`:

```
$ git stash push -u -- src                                  # exit 0
$ bun test test/knowledge-server.test.ts                    # exit 1
  (fail) the pages for agents > a page is Markdown and JSON at its .md and .json siblings, and its HTML names the Markdown
  (fail) the pages for agents > a kind is Markdown and JSON at its .md and .json siblings, every entity of the kind
  (fail) the pages for agents > the product's llms.txt lists every declared kind and the addresses of its lists
  (fail) the pages for agents > a file address that names nothing is refused with the address it was asked for
  12 pass
  4 fail
Ran 16 tests across 1 file. [16.94s]
$ git stash pop                                             # exit 0
```

Green, with the implementation restored:

```
$ bun test test/knowledge-server.test.ts                    # exit 0
  16 pass
  0 fail
Ran 16 tests across 1 file. [15.96s]

$ bun test test/knowledge-vertical.test.ts                  # exit 0
  35 pass
  0 fail
  137274 expect() calls
Ran 35 tests across 1 file. [221.86s]

$ bun run check                                             # exit 0
$ node .shady2k/checks/check-product.mjs --root .           # exit 0
Product documents: clean
```

The vertical suite fills the generated training repository once and then asks for every entity of every kind as `.md` and `.json`, every kind list as `.md` and `.json`, and the product's `/llms.txt`; it compares relation lists with the page model and checks the alternate links of the HTML pages. The two tests about Git date formats that fail on this arm64 VM with an older Git than CI's are outside this change and were not touched.

The document gate (`node .shady2k/documents.mjs check --phase feature --change madarch-m38l.25 --candidate worktree`) reads the change and refuses it only with `untracked-change: change/taskIds` and `missing-approval: change`. This checkout carries no `br` tracker store (`~/.local/state/madarch/tracker` is absent), so the task id cannot be resolved here, and the owner's approval is the coordinator's to record. The approval digest from that refusal is `d76b71e9cf062bb22bfe92b86e81447ca933b6ba6ac6d74cadf72b01ea94eff0`. No other finding remains.

## DONE WHEN
On the generated training repository served by the wiki, every entity page and every kind list answers as Markdown and as JSON at its `.md`/`.json` address, every address a document names is a link in its Markdown, no kind list is shorter than the kind, `/llms.txt` names every declared kind, every HTML page carries the alternate Markdown link, and the schema is documented and asserted by tests.
