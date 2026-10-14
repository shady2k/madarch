# The product home introduces the product before its page groups

Change: product-overview
Base: 986ee65a532e548ea68d7d3ed897065f6d52b3f5
Tasks: madarch-xq0v
Kind: behavior

## Intent
A product manager or architect opening the wiki should learn what the product is, who it serves, what problem and outcome its vision names, and where the current milestone stands before being offered a list of document groups. The app renders the optional normalized overview projection from product data, keeps the legacy top-level audience value compatible, and uses the active locale's missing-data copy rather than inventing values. The source paths, product identity and workflow remain product-owned. The overview UI is implemented here; the production projection/server reader and the ten pinned real reader-walk cases remain pending integration and acceptance.

## Out of scope
- Reading or validating manifest source documents and producing `/api/product` overview data; upstream server work remains owned outside XQ0V.
- Changing the product manifest schema or registry-label behavior.
- Completing the ten pinned real-product reader-walk cases or closing `madarch-xq0v`; these remain required acceptance work.

## Changes to requirements
- product-wiki/overview (added): a normalized optional overview is shown before document groups; product-authored identity and facts are not inferred; legacy audience remains supported; blank values get localized missing-data copy; only a nonblank milestone title with a safe supplied path is linked; absent overview omits the facts block.

## Preserved contracts
- product-wiki/pages: page enumeration, page addresses and the existing localized empty-home guidance remain unchanged.
- product-wiki/questions-and-overview: product declarations remain the source of reader-facing overview data; engine code does not add fixed document paths or workflow assumptions.
- product-wiki/internationalization: overview UI copy follows the selected English or Russian locale; product-authored documents are not translated.

## Coverage
- product-wiki/overview: static, test, mutation, review, browser-walk
- product-wiki/pages: test, browser-walk
- product-wiki/questions-and-overview: test
- product-wiki/internationalization: test

## Blocking questions
None.

## Design and decisions
Use an optional normalized projection on `/api/product`; retain top-level `audience` compatibility. Do not hardcode product identity, overview paths, or workflow. See the approved design target in `status.md` and the existing task acceptance.

## Acceptance evidence
Pending. The local UI tests and fixture render are evidence only for the client; no production reader-walk or final acceptance is claimed.

## DONE WHEN
On the demo product and madarch's own product wiki, the home page shows the product name, audience, vision problem and outcome, current milestone and next step from product documents before document groups, with correct links and localized missing-data copy; the ten pinned reader-walk cases pass. The task remains open until that rendered acceptance is recorded.
