# Diagrams on the product pages, with renderer switchers and drill-down

Change: madarch-m38l.15
Base: 2e0848bd86848f1a85e0651b2de0b5ad15b65118
Tasks: madarch-m38l.15
Kind: behavior

## Intent

A reader of the product wiki needs diagrams that follow the code graph and can be explored, rather than static boxes that hide the system's connections. This change replaces the old chain and system diagrams with graph-checked views rendered by LikeC4, Mermaid and archify. It adds the domain context map and domain page views, C4 context/container/component and deployment views, sequences, ER and state diagrams, renderer choice, links and drill-down, and full-screen controls with zoom.

## Out of scope

- Editing product model facts from a diagram.
- Treating a guessed relationship as a graph fact. Assumptions stay dashed and are explained.
- Replacing the existing neighborhood and treemap views.
- Adding product-specific content to the madarch engine or fixtures that depend on an outside checkout.

## Rationale

The former diagrams did not follow decision 0026 and did not provide the requested interactive renderer set. The server now validates view specifications against the graph and shapes the views; the wiki renders the returned diagrams. User additions to madarch-m38l.15 require a domain map/list and domain detail, C4 home and service views, and full-screen interaction on every diagram. English and Russian catalogues carry all app-owned text.

## Changes to requirements

- product-wiki/diagrams: replace the diagrams requirement with the complete proposed text in `capabilities/product-wiki.md`.

## Preserved contracts

- product-wiki/pages: diagram routes remain page/entity routes; existing pages are preserved.
- product-wiki/live: views are derived from the current graph and do not alter source data.

## Coverage

- product-wiki/diagrams: test, browser-walk
- product-wiki/pages: test
- product-wiki/live: test

## Where it is seen

Kind: screen
Place: the product wiki home, domain list and domain pages, and service, route, database and state-machine pages
Mockup: docs/prototypes/madarch-m38l.15/domain-diagrams.html

1. A reader opens a product home to see its C4 context and container views, switches renderers, and opens a service's component view.
2. A reader follows the domain map, then opens a domain to see its services, data, neighboring domains and named use cases.
3. A reader opens a route, database or source file to explore its sequence, ER or state view, and can expand any diagram to full screen, zoom, and follow links.

## Blocking questions

None.

## Design and decisions

- Diagram specifications are checked against the graph before rendering. The graph supplies facts; assumptions and unordered sequence steps are dashed and have a reason.
- View types include C4 context/container/component, domain map/domain, sequence, ER, state and deployment. The product's `diagram:` choice takes precedence over `MADARCH_WIKI_DIAGRAM`; LikeC4 is the default and a renderer unavailable for a type is not offered.
- Mermaid source is rendered in the app. LikeC4 and archify frames are generated from the same view model. Elements link to wiki pages and code locations; drill-down and up links keep the reader in the view.
- The existing treemap and neighborhood remain. Oversized diagrams fold at a higher level with drill-down.
- The generated training repository and fixture data are the only test inputs; no test names an outside product repository.

## Acceptance evidence

Pending focused checks, browser-rendered screenshots and independent read-only review. Evidence and any limits will be added before final submission.

## DONE WHEN

The product home shows the C4 context and container diagrams with a renderer switcher; service pages show component views; domain list and domain pages show the requested map and details; sequence, ER, state and deployment views work from the graph; assumptions are visibly dashed with reasons; links and drill-down work; and every diagram can be expanded full-screen with working zoom and links. The English and Russian interface catalogues match, and the reader-facing diagrams have been inspected at 1150 px and 390 px in light and dark themes.
