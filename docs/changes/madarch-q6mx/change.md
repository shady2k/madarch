# The wiki's addresses drop the /k segment

Change: madarch-q6mx
Base: f9367571ff2fd7d0aad5499fbc5cdd09806b9a57
Tasks: madarch-q6mx
Kind: behavior

## Intent

The wiki's addresses still carry `/k`: the reader's pages stand at `/k`, `/k/e/{id}`,
`/k/kind/{kind}` and the rest, every page file at `/k/e/{id}.md`, and every answer of the API
at `/api/k/...`. The segment once separated the knowledge wiki from the documents app, which is
gone; it names nothing now. The owner, asked why the demo address reads `http://localhost:4180/k`,
said: «Да, это k нужно убрать».

This change serves every wiki route without the segment and moves every address the server or the
app writes onto the new ones, before the public wiki is linked from the README and the landing
page. One helper builds an address, so a route is spelled in one place. A former `/k` or `/api/k`
address is not redirected and gets no second route: it answers 404 like any unknown path.

## Out of scope

- Redirects, aliases or a compatibility route for a former `/k` address: the replacement retires
  the old address, and the task asks for none.
- The content of a page, the shape of the app and the names of the route kinds: only the path
  before them changes.
- The change records under `docs/changes/`, which stay history; the current text of decisions and
  the present documents are updated where they state a route.
- The page model's blocks and the API's answers beyond the addresses they carry.

## Rationale

An address is a contract: it is written into page models, `/llms.txt`, generated Markdown, MCP
answers and the addresses a command prints. Leaving the source of those addresses scattered as
string literals is what let `/k` stand in every one of them, so the change first makes one module
the only builder (`src/knowledge/addresses.ts`) and one map the only API table in the app
(`wiki/app/src/knowledge/routes.ts`). The app's own route matcher then answers exactly the pages it
knows: the server's fallback to `index.html` accepts no unknown path, so a former `/k` address is a
named 404 rather than a page that silently opens the home.

The one collision found is `/api/products`: the products home answers the selector's list there and
the knowledge part answered its own list at `/api/k/products`. After the segment goes, both stand
at `/api/products` at their own level — the home at the root, the product under its mount — and
both name the same products, so the app reads one address and drops the mounted special case. No
page, page file or app route collides with a static file: the build ships only `assets/` and
`fonts/`, and the routes are the pages the app already knows.

## Changes to requirements

- product-wiki/addresses (new): every reader page, page file and API answer stands without a `/k` segment; no route collides; every written address comes from one helper; a former `/k` or `/api/k` address is 404 like any unknown path. Scenarios: `reader-pages`, `page-files`, `api`, `written-addresses`, `no-collision`.
- product-wiki/pages (changed): a document page's address is `/doc?path={its path within the product}` rather than `/p/{path}`, matching the reader the app already draws. Scenarios: `draft-pages`, `open-page-follows-its-file`.
- product-wiki/architecture (changed): a document's mention of an element opens the element's page at `/e/{id}`, not the old document app's path. Scenario: `document-links-to-element`.
- product-wiki/live (changed): the open page's own address is the document's `/doc?path=...` address, and the repaint still follows the file. Scenario: `open-page-follows-its-file`.

Complete proposed capabilities: `capabilities/product-wiki.md` (every accepted requirement of the current file is retained; the new `addresses` requirement stands at its end, and `pages`, `architecture` and `live` carry the document and element addresses the app already serves).

## Preserved contracts

- product-wiki/serve: a local madarch still serves the product's built files, prints and opens its address, and refuses a path it cannot answer with a message naming what was asked.
- product-wiki/app: the wiki is still one built app; its routes are the same pages, read by the same matcher at the new paths.
- product-wiki/reading-typography: the page's layout, tokens and type scale are unchanged.

## Coverage

- product-wiki/addresses: static test mutation review
- product-wiki/pages: static test mutation review
- product-wiki/architecture: static test mutation review
- product-wiki/live: static test mutation review
- product-wiki/serve: static test mutation review
- product-wiki/app: static test mutation review
- product-wiki/reading-typography: static test mutation review

## Where it is seen

Kind: request
Place: every address of a product's wiki — the reader's pages, the page files and the API
1. Open the product's home; it answers at the origin, without `/k`.
2. Open an entity's page and a kind's list; they answer at `/e/{id}` and `/kind/{kind}`.
3. Read `/e/{id}.json`; the page's JSON answers, and `/k/e/{id}.json` answers 404.
4. Read `/api/status`; the status answers, and `/api/k/status` answers 404.
5. Follow a link inside a page's Markdown or `/llms.txt`; it names the new address.

## Blocking questions

None.

## Design and decisions

- `src/knowledge/addresses.ts` is the one builder: the address name rule, the reader's pages, the
  page-file bases, `isWikiPagePath` for the app fallback, and the `API` map. `resolve.ts` re-exports
  the entity, kind, source and document builders under their old names; `page-files.ts`,
  `history.ts`, `product.ts`, `loop/views.ts` and `problems/documents.ts` import from it.
- `src/server/http.ts` builds each route from the `API` map and the two page-file bases, so the
  server's "no such path" list names the new addresses.
- `wiki/app/src/knowledge/routes.ts` holds the same builders for the browser (the package cannot
  import the engine), the `API` map the app reads, and `wikiRouteOf`; the identifiers lost their
  `K_` prefix. `isWikiAddress` decides when a Markdown link opens in the wiki.
- `src/server/wiki-app.ts` accepts `index.html` only for the app's own routes (`isWikiPagePath`),
  so an unknown path — a former `/k` address included — is a named 404.
- The collision `/api/products` is shared by the home and the product, at their own mount levels:
  the app now reads that one address and the two answers name the same products.

## Acceptance evidence

Recorded on the task in the tracker: the static, test, mutation and review receipts at the
revisions they read. The commands and their counts are in the report `/work/out/report-q6mx.md`.

## DONE WHEN

- every wiki route the server offers has no `/k` segment: the reader's pages, the page files and
  the API, with no collision with an existing `/api/*` route, the SPA's routes or its static files;
- every URL the server writes and every link the app builds uses the new addresses, built by one
  helper, and no `/k/` literal remains in `src/`, `wiki/app/src/` or `scripts/`;
- a former `/k` or `/api/k` address answers 404 like any unknown path, with no redirect and no
  second route;
- the present documents and the current text of decisions name the new addresses, while
  `docs/changes/` stays history;
- the tests, the e2e tests and the CI wiki walk use the new addresses, and a test asserts
  `/k/e/{id}.json` 404 and `/e/{id}.json` 200 for the same id;
- root checks, the full root suite, the wiki app's install, check, test and build, and the CI walk
  are green, with their counts in the report.
