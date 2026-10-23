# madarch's own wiki opens first, a help icon reaches it, every product has a glossary, and readers are served by role without page versions

Change: madarch-m38l.10
Base: 41f4c686fa88641183883a771c89adf1b6dfd89d
Tasks: madarch-m38l.10
Kind: behavior

## Intent
Decision 0031 (the owner's words, 2026-10-23) says a fresh install must not open an empty page, the wiki must serve a product manager who has never heard "manifest" and an experienced product engineer from one page, every product needs a glossary whose terms link from the text, a role chooses what is open, and every write must say who wrote it. This change builds the local half: madarch's own wiki as the first thing a clean machine opens and a «?» icon in the top bar that reaches it from any product; the glossary reading and page; the role asked once, kept on the machine and declared per role in the manifest; and the identity seam with its local-git implementation, used by every write the wiki makes today. The team server's half (OIDC sign-in, server commits, roles from groups) is designed in 0031 and left for the server milestone.

## Out of scope
- The OIDC identity, server-side commits and signing, the require-verified setting and roles from SSO groups (0031 designs them).
- Questions, answers and corrections as indexed entities (madarch-m38l.7): the identity seam is ready for them; their writes join it when that branch lands.
- Diagram blocks (madarch-m38l.9).
- Real agent runs; the terms an agent finds in code are written by the fill as terms in a glossary document, and this change reads them.

## Rationale
See "Design and decisions".

## Changes to requirements
- wiki-readers (absent on the target): add. Complete proposed text in `capabilities/wiki-readers.md`.

## Preserved contracts
- product-wiki/serve: the routes keep their addresses; routes are added.

## Coverage
- product-wiki/serve: test
- wiki-readers/own-wiki: test
- wiki-readers/glossary: test
- wiki-readers/roles: test
- wiki-readers/identity: test

## Where it is seen

Kind: screen
Place: the wiki on a clean machine, then any product's wiki
Mockup: docs/prototypes/madarch-m38l.10/first-run.html

1. A person starts madarch with an empty products home and opens the address it prints; madarch's own wiki opens with a card that asks which role they read as.
2. They choose a role or skip it; the home page says what madarch is in two words and goes down from there; they open the glossary and a term in a page's text is a link to its entry.
3. In any product they press the «?» in the top bar and madarch's documentation opens; they switch the role in the top bar and the same page opens other blocks.

## Blocking questions
None.

## Design and decisions
- The engine holds no product content (owner's rule, 2026-10-13). madarch's own product is the repository shady2k/madarch-product, brought to the current format on a branch there with a pull request in that repository.
- The binary build (`scripts/build-binary.ts`) fetches a pinned revision of that repository, recorded in a lock line in this repository, and embeds it as an asset. The first start installs it at `<madarchHome>/madarch-wiki` as a git checkout and serves it as the always-present `madarch` entry; online, the checkout is fetched and fast-forwarded when untouched.
- The glossary, the roles (manifest section plus `<madarchHome>/settings.json` through a server API) and the identity seam (through the discussion writer, with a commit trailer and an additive `verified` field) are built as planned.

## Acceptance evidence
(Filled at the end.)

## DONE WHEN
The decision record is merged; on a clean products home the root opens madarch's wiki with its glossary; the «?» icon opens it from any product; the first open asks the role and the pages open the role's blocks; the training repository's glossary page lists its terms with grounds (payment token flagged ambiguous); an answer written in the wiki is committed with the git identity and marked "local, not verified". The server half is designed in the record and left for the server milestone.
