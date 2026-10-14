# The product home introduces the product before its page groups

Change: product-overview
Base: 986ee65a532e548ea68d7d3ed897065f6d52b3f5
Tasks: madarch-xq0v
Kind: behavior

## Intent
A product manager or architect opening the wiki should learn what the product is, who it serves, what problem and outcome its vision names, and where the current milestone stands before being offered a list of document groups. The app renders the optional normalized overview projection from product data, keeps the legacy top-level audience value compatible, and omits absent facts rather than inventing values or rendering placeholders. The source paths, product identity and workflow remain product-owned. The localized empty-home guide names only shipped commands (`madarch new`, `madarch clone`, `madarch repo add` and `setup-shady2k-skills`) and offers the demo through its supported clone-and-serve path. This change includes the product-registry source mappings, production `/api/product` projection, client rendering and path validation; the ten pinned real reader-walk cases remain acceptance evidence.

## Rationale
Owner Addendum 12 (2026-10-14) corrects the empty-home guidance: `madarch clone` and `madarch repo add` are shipped, while `madarch demo` is not. Both locales name the current create, clone, repository-connect and setup commands, and offer the Madarch product example through clone and serve. The copy does not claim `madarch demo` exists.

## Out of scope
- Changing product registry-label behavior.
- The pending `madarch demo` shorthand tracked by `madarch-n5ip`; empty-home guidance uses the shipped clone-and-serve commands.
- Completing the ten pinned real-product reader-walk cases or closing `madarch-xq0v`; these remain required acceptance work.

## Changes to requirements
- product-wiki/overview (added): the first screen shows a normalized optional overview before document groups; product-authored identity and facts are not inferred; legacy audience remains visible without a facts block when the projection is absent; missing and blank values are omitted without placeholders; only a nonblank milestone title with a safe path in the served page list is linked.
- product-wiki/questions-and-overview (replaced): optional product-registry mappings for audience, problem, outcome, currentMilestone, milestoneState and nextStep each name their product-relative document and exact section; source paths, sections and semantic roles are product data, absent mappings remain absent, and invalid configured sources are reported without fallback. Existing question-form behavior is unchanged.
- product-wiki/pages (replaced): localized empty-home guidance names the shipped `madarch new`, `madarch clone URL`, `madarch repo add NAME URL --product FOLDER` and `setup-shady2k-skills` commands; it offers the linked Madarch example through `madarch clone https://github.com/shady2k/madarch-product` followed by `madarch serve --product FOLDER`, and does not present `madarch demo` as shipped.

## Preserved contracts
- product-wiki/internationalization: overview labels and empty-home UI copy follow the selected English or Russian locale; product-authored documents are not translated.

## Coverage
- product-wiki/overview: static, test, mutation, review, browser-walk
- product-wiki/pages: test, browser-walk
- product-wiki/questions-and-overview: static, test, review, browser-walk
- product-wiki/internationalization: test

## Blocking questions
None.

## Design and decisions
Use an optional normalized projection on `/api/product`; retain top-level `audience` compatibility. Read only the product registry's declared document-and-section mappings, validate each source as a product-relative wiki page, and never hardcode product identity, paths, headings or workflow. Missing or invalid mappings contribute no value. The client links a milestone only when its path is safe and present in the served page list. The empty-home guide uses only the shipped `madarch new`, `madarch clone`, `madarch repo add` and `setup-shady2k-skills` commands, and the demo's clone-and-serve path; it does not claim `madarch demo` exists. See the approved design target in `status.md` and the existing task acceptance.

## Acceptance evidence
Pending. The local UI tests and fixture render are evidence only for the client; no production reader-walk or final acceptance is claimed.

## DONE WHEN
On the demo product and madarch's own product wiki, the first screen shows the product name, audience, vision problem and outcome, current milestone and its state, and next step from product documents before document groups, with correct links and no placeholder text for absent facts; the ten pinned reader-walk cases pass. The task remains open until that rendered acceptance is recorded.
