# Built-browser coverage for wiki page navigation

Change: wiki-navigation-e2e
Base: 60f557318acd993eda17365cac8202de6b24d34e
Tasks: madarch-0n3p
Kind: behavior

## Intent
Add a generic group page at `/g/` followed by the URI-encoded group identity keyed by each page's existing `PageMeta.kind ?? groupOf(path)` identity. The group page uses the existing localized/fallback group label as its heading and lists only that group's live pages as links in code-point path order. The sidebar group heading and group breadcrumb open that page; the sidebar `madarch вики` brand and first breadcrumb `Продукт` open Product overview. The breadcrumbs are the in-app way back; no separate Back button is added. Extend the factory-built, production-app Chromium test to click the logo, both breadcrumb segments, and the sidebar group heading and assert each URL and heading, including the group page's links. Preserve body-link, backlink, every footer-entry, browser Back/Forward and overview coverage.

## Rationale
Owner approval in task comments 2517/2520 and Coordinator Brief Addendum 3 establish the generic group-route contract. The group address carries existing group identity rather than product-specific names, and its page reads the live page list through the same grouping rule used by the sidebar.

## Out of scope
- Tabs, the product card/chevron, and bottom status, which belong to madarch-gj94.
- A separate Back button; the breadcrumbs provide the visible in-app way back.
- Any dependency on the committed demo product as automated fixture data.

## Preserved contracts
- product-wiki/pages: a body link to a held wiki page opens that page; all other page-link behavior is unchanged.
- product-wiki/front-matter: declared outgoing references and backlinks remain linked to their held pages.

## Coverage
- product-wiki/pages: test
- product-wiki/front-matter: test
- product-wiki/shell: test
