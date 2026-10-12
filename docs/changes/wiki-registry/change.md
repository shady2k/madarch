# The wiki reads the product's kinds registry: kinds, eyebrows, groups, stage mapping and hints

Change: wiki-registry
Base: 46dfdaad7f8952bfa490f015a4eced96cf3a8f18
Tasks: madarch-d7v3.1
Kind: behavior

## Intent
Decision 0021 (docs/decisions/0021-product-repository-contract.md) drew the
boundary: madarch is the standalone engine, it knows the mechanism and not the
kinds, and the kinds are data the product (usually the skill set, at setup)
writes into its kinds registry file. Today the wiki still carries the set's
vocabulary in code: the kind table and the id prefixes stand in
`src/product-wiki/documents.ts` (`KIND_ORDER`, `ID_PREFIX_KIND`, `ID_REGEX`,
`kindOfPath`), the stage mapping and the skill words stand in
`src/wiki/stages.ts` (`KIND_FOLDERS`, `STAGE_SKILLS`, `KIND_BY_PREFIX`), the
app groups by a bundled `KIND_ORDER` and keeps the kind words in its locale
catalogues. One change of the set's vocabulary becomes a madarch code change.

After this change the wiki reads the product's own kinds registry file
(`docs/kinds.yaml`, the file the set's setup writes, the place the contract's
capability pins), validated by the landed contract's read
(`src/product/contract.ts`, with its refusal words naming the file and the
line). The document kinds, the eyebrows' kind words, the sidebar groups (their
names, counts and order, ordered by the registry's stage list), the stages
view's kind-to-stage mapping and the next-step hints all come from the
registry; the YAML data joins the grouping (a file kind is addressed by its
file stem's word the way the form's link lines spell it, like `VISION`).
A product that holds no registry renders the plain pages it had: no invented
kind, the path groups, the generic life cycle, generic next-step hints, and no
kind word on any page. The reference demo product (`wiki/demo`, Fieldnote) keeps
today's groups, hints and eyebrow kinds through the kinds registry it now
commits, written in the set's writer shape. No kind name or id prefix of any
set is left in `src/`, `src/product-wiki/`, `src/wiki/`, `src/server/` or
`wiki/app/src/`.

What a user can do that they could not before: a product whose kinds differ — a
set-up product, a hand-written set of kinds, a product in another language —
groups, hints and names itself in the wiki through its registry data alone,
without a madarch change; a registryless product reads plain.

## Out of scope
- The lifecycle commands' move to madarch's own code and the vendored program's
  leaving (madarch-x73l, outcome 2).
- The skill set's writing of the registry at setup and its CI conformance
  (madarch-d3yt, outcome 7, in the set's repository).
- The engine stopping to ship the moved skills (madarch-cswc).
- The set's product-document check (0019 stands) and the questions view's
  question semantics (the states stay the set's own three).
- The demo product's documents themselves: only the registry file joins the
  demo tree.

## Changes to requirements
- product-wiki/front-matter: replaced. The kind a page shows is the product
  registry's kind, matched by the document's explicit `Kind:` field, its
  identity line's id prefix or its path's place, in that order, and nothing is
  invented; the document's link fields are the kind's declared links, each
  naming its target kinds, its backlink label, its cardinality and whether it
  is required, and the backlink rows carry the declaring kinds' labels; the
  registry's reads report the structural findings (a broken link, a link to an
  undeclared kind or field, a missing required link, a status outside the
  kind's statuses) on the pages they name; the product's registry drives the
  navigation's groups and their order; without a registry no kind is computed
  anywhere and no link field is read.
- product-wiki/live: replaced. The kinds registry file joins the sources the
  revision digest covers, so a saved registry — a kind added, its link
  declarations published, a document naming a new kind — is a wiki change the
  stream reports; the regroup, the eyebrow kind and the declared links answer
  inside two seconds with no restart, and the required link's finding stands
  on the new kind's page until its document carries it. The live rules stand
  otherwise, as the requirement has always run them.
- product-wiki/stages: replaced. The stage list, its order and its names are
  the registry's; each kind rides the stage the registry gives it; the
  next-step lines carry the registry's hint where a kind has one and the
  mechanism's own generic wording where they do not; no skill of the set is
  named; a stage that holds nothing of any kind names it plainly.

## Preserved contracts
- product-wiki/pages: test — the pages list, the walk of docs/ and README.md, titles, addresses and links do not change; a page without a registry reads the same.
- product-wiki/shell: test — the reading shell's chrome, its fixed wordings and the document panel stay; only the kind and group words that come from the registry change their source.
- product-wiki/architecture: test — unchanged.
- product-wiki/repositories: test — unchanged.

- product-wiki/serve: test — serving, refusals and read-only answers unchanged; the new /api/registry read answers the same offers the app asks for.
- product-wiki/app: test — the build and serving of the app's files unchanged.
- product-wiki/result: test — exit statuses and silent serving unchanged.
- product-wiki/internationalization: test — the catalogues keep the shell's fixed words in both languages; the kind and stage words are the registry's data, read off the registry, not catalogue keys.
## Coverage
- product-wiki/front-matter: test
- product-wiki/stages: test
- product-wiki/pages: test
- product-wiki/shell: test
- product-wiki/live: test
- product-wiki/serve: test
- product-wiki/app: test
- product-wiki/architecture: test
- product-wiki/repositories: test
- product-wiki/result: test
- product-wiki/internationalization: test

## Blocking questions
None.

## Design and decisions
- The registry is read fresh per ask from `src/product/registry.ts`
  (`readProductRegistry`): absence, the whole read through
  `parseContractText`, or the contract's refusal values without any thrown
  error. A symlink standing in the registry's place is refused unless it
  points back into the product.
- The wiki consumes the registry through one kit (`registryKit`): the kinds by
  id prefix, the folders longest first, the whole id shape, the mention shape
  and the file kinds' file-stem addresses. The stage index (`src/wiki/stages.ts`)
  and the page reader (`src/product-wiki/documents.ts`) take the kit; the app
  takes the server's `/api/registry` answer.
- The set's hard-coded surfaces are removed, not replaced by other words:
  `KIND_ORDER`, `ID_PREFIX_KIND`, `KIND_FOLDERS`, `STAGE_SKILLS`,
  `KIND_BY_PREFIX` and the app's `kinds.ts` are gone; the locales keep only the
  shell's fixed words. The status computation reads the document's own
  sections, never a prefix.
- The demo product's committed registry `wiki/demo/docs/kinds.yaml` carries the
  set's writer shape (the contract's fields, the stages as an ordered id list)
  with the product's own kind words, prefixes and places, so the served demo
  reads as it did through the registry alone; `bun run contract:check --src`
  accepts it.

## Acceptance evidence
Recorded on the task in the tracker: the static, test, mutation and review
receipts at the revisions they read.

## DONE WHEN
- the server reads the product's kinds registry (missing reads as none; a bad
  file is refused by the contract's own words with its file and line, and the
  pages stay plain);
- the kinds, the eyebrows' kind words, the sidebar groups (names, counts, the
  registry's stage order), the kinds' stage mapping and the next-step hints
  come from the registry, the YAML tags with them;
- a product without a registry renders plain pages with generic hints and no
  kind word anywhere;
- the demo product (wiki/demo, Fieldnote) keeps today's groups, hints and
  eyebrow kinds through its committed kinds.yaml in the set's writer shape;
- the document's links are the kinds' declared links with their backlink
  labels, cardinalities and required flags, and the structural findings show
  on the pages they name;
- the live walk holds: a story kind joins the registry with its required
  link, the stream says it inside two seconds, the finding stands and
  clears, the backlinks stand both ways, no restart;
- `grep -rn "PRA-" src/ wiki/app/src/` and a search for the set's kind names in
  those trees name no kind;
- the registry-reading tests (valid read, bad refused by file and line, missing
  renders simply), the declared-link and structural-findings tests and the
  kind fixtures replace the hardcoded-kind tests;
- root checks and wiki/app checks green at the landing.
