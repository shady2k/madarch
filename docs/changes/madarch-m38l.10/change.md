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
Mockup: docs/prototypes/madarch-m38l.10/first-run-en.png

1. A person starts madarch with an empty products home and opens the address it prints; madarch's own wiki opens with a card that asks which role they read as.
2. They choose a role or skip it; the home page says what madarch is in two words and goes down from there; they open the glossary and a term in a page's text is a link to its entry.
3. In any product they press the «?» in the top bar and madarch's documentation opens; they switch the role in the top bar and the same page opens other blocks.

## Blocking questions
None.

## Design and decisions
- The engine holds no product content (owner's rule, 2026-10-13). madarch's own product is the repository shady2k/madarch-product, brought to the current format on a branch there (pull request shady2k/madarch-product#2): the engine's starter manifest and templates with the new `roles` and the `term` block, a Russian product page and four newcomer pages (how to start, the fill and the agent, what a ground is, roles and authorship), a glossary of 19 terms with their English words and inflected forms as synonyms, and reference documents (`docs/reference/`) that restate madarch's commands, repository format and fill from its documentation and that every statement is grounded in. The product's own AGENTS.md asks for Russian, so the pages are Russian (`language: ru`); a page's language is the product's, the interface follows the reader's.
- `own-wiki.lock` pins a revision of that repository. `scripts/build-binary.ts` fetches it at build time into a git bundle and embeds it (`own-wiki/madarch-product.bundle` and `REVISION`). The first start (`src/product/own-wiki.ts`, called by the background server) copies the bundle out of the binary's virtual file system, clones it to `<madarchHome>/madarch-wiki`, points origin at the repository, and serves the folder as the always-present entry under its folder name. A source checkout carries no bundle and clones the repository instead. A refresh runs after the server is up, never blocks it, and fast-forwards only a checkout with no change of its own; every refusal names the folder and the repository. `MADARCH_OWN_WIKI=off` switches the whole thing off (the test preload sets it).
- The own wiki is outside the products home, so `madarch list` is unaffected. The root opens it only while the home holds no product; reading it does not set the cookie that makes it the next default. Its status says `own`, so the app offers no fill and no start over, and the server refuses both.
- The glossary kind is the existing `doc.term` kind; its list items now carry labelled sub-lines in both interface languages (Also called, In code, Used in, Ambiguous), wrapped lines belong to the field above. Terms are read without a fill (`/api/k/glossary`), each with the document, line and anchor it is stated at and the resolution of the links it holds. The app links the first use of a term, or of a synonym, in each paragraph when the words are whole and in the same case (judged across inline formatting); a name two terms claim is linked to neither.
- Roles: `roles:` in the manifest names, per role, the template blocks that stand open (`open`) and the groups that lead the navigation (`lead`); a finding with file and line for an unknown role, block or group. Every page block carries the name of the template's block it came from, because `implementedby` and `linkedfrom` both draw as `refs`. A block a role does not open is collapsed under its title on the same page. The reader's role is `<madarchHome>/settings.json` (`role`, `roleAsked`), written with an exclusive temporary file, read and written through `/api/k/settings`; a file that cannot be read is an error naming its path. The starter manifest declares defaults for the six roles.
- Identity: `src/identity/identity.ts` answers `whoIsTheUser(folder)`: git's author variables, else `user.name` and `user.email`; a missing one is refused with the folder and the commands that fix it; the answer is marked "local, not verified" and says whether the user's own signing key is configured, in which case the wiki's commits are signed (`-S`). The discussion writer (comments, replies, anchor restores, answers to questions) and the questions loop's answers and corrections (`src/loop/answer.ts`, merged from origin/main) ask it. A commit by the wiki carries the trailer `Written-by: ... (local, not verified)`; a comment message carries `verified: local-git` (an additive optional field of the published schema).
- Shell follow-ups the coordinator asked for while merging the questions loop: the raw key badge is gone from entity and question pages; the refresh menu's "the agent asked N questions" line is a count the app words in the reader's language (`writer.asked`); the question, questions and problems pages set their tab titles.
- The reading of `madarch-product` content in tests uses a fixture repository only (`test/own-wiki-fixture.ts`).
- Known limits: a request that arrives in the few milliseconds a refresh takes to move the checkout may read a mixed tree and show an error once; the next read is whole (the pages are read fresh at each ask). `madarch demo` still clones madarch-product into the products home as a product of its own, so a machine that used it lists madarch twice. The OIDC half of 0031 is designed there and not built.

## Acceptance evidence
Run on the SkyPilot pool (the 2 CPU / 4 GB request waited about ten minutes for a slot and was queued with `--retry-until-up`; the wrapper's own launch was refused at first) and in CI on the pull request's head. Fixtures only (the generated training repository, a fixture repository standing in for madarch-product).
- Engine tests: `test/identity.test.ts`, `test/own-wiki.test.ts`, `test/wiki-readers.test.ts` and the changed `test/product-discussion-writer.test.ts`, `test/loop-*.test.ts`, `test/knowledge-parse.test.ts`, `test/knowledge-render.test.ts` pass. They cover: the identity and its refusals, the signing flag, a settings file written through a link, the install from a bundle and from a repository, the refresh (fast-forward, uncommitted change, own commit, unreachable repository, git variables of another repository), the root of a clean home, the selector flag, no fill and no start over for the own wiki, the settings route, the glossary of the generated training repository (its seven terms with the place each is stated at and "payment token" flagged ambiguous with its question), a term's page.
- Wiki app: `bun run check`, `bun test` (`readers.test.tsx`: what a role opens, the order of the groups, one page under two roles, exact term links, the glossary page, the role card, its skip and its refusal, the top-bar role and the «?»).
- Screenshots in Russian and English of the first run with madarch's own wiki and the role card, its home page, a page with term links, its glossary, a term's page, a product with the «?» beside the language globe, the role menu, the «?» opening the documentation, one function page as a developer (source open) and as the product role (source, callers, calls and sequence collapsed), the training product's glossary with the ambiguous term, and term links in a product page (`bun scripts/roles-shots.ts --lang ru|en`, on the pod with the AVX2 recipe); looked at, defects fixed after the first look: a bullet before each glossary entry, definitions that began in lower case, a raw key badge on pages. The first-run screenshots are the change's mockup (`docs/prototypes/madarch-m38l.10/`).
- A read-only Codex review found ten defects, all fixed with tests except one recorded as a known limit: the embedded bundle could not be read by git inside the binary (copied out first), the refresh and the build script passed the git variables that point at another repository, the settings were written through a guessable temporary name, the roles named `implementedby` and `linkedfrom` could not open because both draw as `refs`, a wrapped glossary line was lost, documents received no term links, a bold run inside a word was matched, the glossary page hid its findings, a configured signing key did not sign the wiki's commits; and the checkout is updated in place while being read (limit above).

## DONE WHEN
The decision record is merged; on a clean products home the root opens madarch's wiki with its glossary; the «?» icon opens it from any product; the first open asks the role and the pages open the role's blocks; the training repository's glossary page lists its terms with grounds (payment token flagged ambiguous); an answer written in the wiki is committed with the git identity and marked "local, not verified". The server half is designed in the record and left for the server milestone.
