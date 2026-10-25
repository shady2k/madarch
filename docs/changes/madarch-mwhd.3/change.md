# Repository facts come from structure, not from the shape of one repository

Change: madarch-mwhd.3
Base: a083f53625d5f139d5ea6c78ade825fbc49e7ad5
Tasks: madarch-mwhd.3
Kind: behavior

## Intent
Readers need true source facts when they open any supported repository, not only
the generated training product. A false logger use, metric update, route or data
access tells them something the code does not do. The owner has chosen structural
parsing and resolved identities over text patterns. A missing fact with a located
gap is better than a wrong edge.

The main path stays the same: fill a pinned repository, open a generated entity
page, and follow a relationship to the exact source that supports it. Success
means that misleading member-suffix matches disappear, supported facts retain
their evidence, and the same rules work on differently structured repositories.

## Rationale
This is a full behavior proposal: it changes facts readers see, a shared internal
interface, dependencies and the way producers identify their interpretation.
It is not a regex repair or an implementation permission. The complete proposed
capability is the accepted `product-wiki` text at `Base:` plus the requirements
below. The unaccepted graph-truth proposal remains owned by madarch-m38l.20; its
counterexamples and evidence contracts are preserved, not silently declared
accepted here. Both proposals must be reconciled at integration if the target
capability moves.

The owner supplied the outcome frame and architecture in the coordinator's
2026-10-25 15:23:15, 15:25:44 and 15:29:13 instructions. `design.md` records
current interfaces, every extractor family, alternatives and unresolved parser
packaging gates. `stages.md` sizes the work without creating tracker children or
changing the existing leaf into a container before approval.

## Out of scope
- Runtime instrumentation, whole-program proof, executing repository code or
  configuration, arbitrary language support, and guessed dynamic targets.
- A new graph store, graph schema, second source-code parser, second resolver,
  in-place extractor-set upgrade, or changes to Markdown written by people.
- Layout work, screenshots, broad reader-page changes and unrelated findings.
- Repository-specific recognition rules, including names, topics, tables,
  ports, paths and symbols from the training product.
- Selecting unverified parser packages by assertion. Bounded parser research
  and packaging verification precede each dependency decision.

## Changes to requirements
- product-wiki/parser-facts (new): code-derived relations use a shared, resolved
  structural fact view produced by the existing code extraction pass.
- product-wiki/parser-formats (new): non-code formats use real parsers and
  explicit dialect/support boundaries, never regex or ad hoc source scans.
- product-wiki/library-model-data (new): package/framework knowledge is typed,
  declarative, versioned data with behavior checks for every entry.
- product-wiki/no-source-patterns (new): CI guards every file under `src/extract`
  against source regex, including indirect construction and query predicates.
- product-wiki/parser-evidence (new): exact byte spans, origins, callback semantics,
  bindings, gaps and pinned-input behavior survive the migration.
- product-wiki/parser-generality (new): portable fixtures and one-time walks on
  the engine's own repository and a differently structured generated fixture
  check that the rules are not fitted to the training product.
- product-wiki/parser-identity (new): deterministic query/registry/parser identity
  invalidates the derived graph when its interpretation changes.

Complete proposed capability: `capabilities/product-wiki.md`.

## Preserved contracts
- product-wiki/pages: product Markdown remains the source of pages; extraction and derived-graph rebuilds never rewrite it.
- product-wiki/serve: existing wiki and JSON routes remain reachable unchanged.
- product-wiki/internationalization: new reader-facing gaps/progress follow the existing English and Russian contract; source identifiers are not translated.

## Coverage
- product-wiki/parser-facts: parser-code-facts, parser-binding-counterexamples
- product-wiki/parser-formats: parser-format-matrix, parser-package-walk
- product-wiki/library-model-data: parser-registry-entries, parser-registry-invalid
- product-wiki/no-source-patterns: parser-source-guard, parser-guard-counterexamples
- product-wiki/parser-evidence: parser-evidence-regressions, parser-pinned-inputs
- product-wiki/parser-generality: parser-fixture-matrix, parser-acceptance-audits
- product-wiki/parser-identity: parser-digest-rebuild, parser-package-walk
- product-wiki/pages: parser-digest-rebuild
- product-wiki/serve: test
- product-wiki/internationalization: test

## Where it is seen

Kind: request
Place: the existing product knowledge JSON page API and its generated wiki pages

1. A reader fills a supported repository at a pinned commit.
2. They request a logger, metric, route, channel or data-model entity and follow
   a relationship to its actual source declaration or use.
3. A member of a different receiver is not shown as a use of a standalone
   binding. An unsupported or ambiguous target is a located gap, not a link.
4. A second repository with different names, layout and supported libraries is
   read by the same rules, without edits to those rules.

## Blocking questions
None.

## Design and decisions
The coordinator recorded owner approval of digest `7f3c09e5ba9557012bff21f7cf999ae80ea8e06b1c765c75d4d850d87e496546` and authorized the first cohort in the 2026-10-25 15:57:13 instruction. This settles architecture direction, not unverified package adoption. Parser APIs, locations, license and compiled-binary packaging remain the bounded stage research gates in `design.md` and `stages.md`. No dependency is deemed compatible merely because the architecture is approved.

Recommended: Shared Semantic Model plus parser Adapters and models-as-data.
Keep the current pure tree-to-extraction seam and existing code resolver. Add an
immutable public `CodeFacts` view to the existing code pass; consumers do not
rescan source code. Structural query files capture exact syntax; package binding
and scope resolution establish meaning. A small closed evaluator applies typed
registry entries, not executable snippets or method-name-only rules.

The first migration cohort is metrics, loggers, symbol sites, messaging and env.
Contracts, data access, SQL/Prisma and all remaining extraction readers follow.
The guard must eventually pass over all of `src/extract`; there is no broad
legacy allowlist and no claim that the first cohort completes this task. PR #168
waits for the owner's required no-regex acceptance, not an old READY receipt.

No new ADR is needed before direction approval. The durable principle will be
added to AGENTS and the existing decision record, or a proposed ADR if a distinct
trade-off needs its own record. No accepted ADR or current capability is edited
by this proposal. The owner's final-only Codex rule overrides the generic
skill's design-review round. This proposal receives no Codex design review.

## Acceptance evidence
Not run. This is a proposal, not a passed result. After approval, use focused
checks and exact-head CI. Mutation and content walks follow the coordinator's
milestone-close policy; they are not silently reported passed or run per PR.
The own-repository and second-fixture extraction audits are explicit one-time
acceptance requirements of this task, not committed outside-checkout tests.

## DONE WHEN
All source-reading extractors use the approved structural/parser boundaries;
the complete source guard passes with no source-text exception; every registry
entry has its own positive and counterexample coverage; both named false edges
are absent; preserved truth/evidence scenarios and the training answer key do
not regress; one-time own-repository and second-fixture audits are recorded;
producer identity includes interpretation data; exact-head CI and the required
final PR review are clean. Intermediate cohorts do not complete this task.
