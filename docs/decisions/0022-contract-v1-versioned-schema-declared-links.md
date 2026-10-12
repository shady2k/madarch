# 0022. Contract v1: the registry carries its version and declares its links, statuses and required links

Status: accepted
Date: 2026-10-12

Refines 0021 (the product repository format as madarch's contract) and 0016
(the single versioned contract); counts the owner's refinement of 0021,
given 2026-10-12 around 19:20–19:35 MSK in conversation with the assistant,
as its decision — the constraint that no repository may depend on another,
the version in the file, the kinds' link declarations with statuses,
backlinks, cardinality and required links, the live pickup, and the
overridable templates.

## Context and problem
0021 makes the product repository's format madarch's published, versioned
contract and the kinds the skill set's data, but the landed schema knows
neither a version in the registry file itself nor what a kind's documents
link to. Three things sharpen it before anything is released:

- **The version is nowhere in the file.** A tool that validates a registry
  against the published schema cannot tell which version of the mechanism
  the file was written for; madarch serving a registry written for a later
  mechanism would misread it or, worse, misread it silently.
- **The links are words nobody declared.** The wiki knows how documents
  link (`Links: S-001`) but not what a field means: that a user story
  "Grew from" a source or hypothesis, that a use case "Serves" stories,
  what the target's page shows as a backlink, whether one target or many
  may stand, whether a kind's document without the link is broken. The
  owner decided the structure and the links belong to the product's
  manifest (`docs/kinds.yaml`), so the wiki is an engine with a fixed set
  of capabilities and the vocabulary is wholly data — no type name, field
  name or status value hard-coded in madarch.
- **A set copy pins a checkout.** The skills branch validated its registry
  against madarch at a pin, so the set's CI checked madarch's tree out and
  ran its code — one repository depending on another, whatever the files'
  names said.

Also falling to the same ruling: statuses a kind's documents may carry, so
a status outside what the kind declares is named rather than guessed; the
running wiki re-reading the manifest without a restart, both because the
acceptance walk needs it (a kind added at the served wiki shows within two
seconds) and because a manifest that is being edited must never take the
wiki down; and document templates the set ships as defaults that a product
may override per kind.

## Considered options
1. **Versioning stays on the schema alone** (the `$id` of the published
   file moves, the file itself carries nothing): a tool holding the
   schema can still tell the version, but the product and its tools
   cannot, and an unknown version is indistinguishable from a broken
   registry at the point where the wiki reads the file.
2. **Links stay implicit in the set's checks** (the check-product rules
   name `Grew from`, `Serves` and the statuses): the fastest path, and the
   exact one 0021 closed — madarch's code would hold the set's words, and
   a product with no set installed could not express them.
3. **The manifest declares everything structural, the engine computes
   from the declarations**: the registry file carries its contract
   version; each kind names its statuses and its link fields (field name,
   target kinds, backlink label, cardinality, required); the wiki draws
   links, backlinks, grouping, stage placement and hints from the data;
   every structural finding is computed against the declarations; the
   skill set keeps the content rules and the templates, overridable
   per product; and each side carries its own copy of the schema at the
   version it targets, validating with its own code.

## Decision
Option 3, decided by the owner in the conversation the record counts
above; the acceptance walk it settles (the registry lane's):

- a product holds use cases and no user stories; a user story kind is
  added to the served product's registry with its required link; a user
  story document written without the link shows a finding (a missing
  required link); written with it, the finding clears and the
  use-case/user-story links and their backlinks appear; and all of it,
  the regrouping included, happens within two seconds of the file being
  saved, with no restart.

- **The registry file carries its contract version, and the schema is
  published as a versioned document.** `docs/kinds.yaml` reads
  `contract: 1` on its first line; the published schema's `$id` carries
  the version (`https://github.com/shady2k/madarch/schema/v1/product-registry.schema.json`), and the file in madarch stays the one
  source of the schema, generated from the TypeBox source with
  `bun run schemas`. The version in the file and the version in the
  `$id` are the same number.
- **madarch accepts the versions it knows.** A `contract: 1` registry
  reads as before. On a version madarch does not read, the wiki names the
  version it found and the version it supports, and serves the product's
  pages as plain documents — the banner carries the reading's own words,
  file and line included; it never fails silently, and it never refuses
  the start. The same degradation, always named, covers a registry the
  wiki cannot parse, and nothing of it is an error the server dies on.
- **The kinds declare their links and their statuses.** Each kind may
  carry its allowed statuses, in the order the reader walks them, and its
  link types: the field the kind's documents carry the link in, the kinds
  the field's targets may name (by id prefix), the words the target's
  page shows the backlink under, whether the field holds one target or
  many, and whether a document of the kind without the link is a finding.
  The owner decided the required links belong in the manifest; the
  backlink label, the cardinality and the requiredness ride the same
  declaration, and the examples pin the words every malformed one of them
  is refused with.
- **The engine computes the structure from the declarations.** Drawing
  links and backlinks, grouping by kind, placing kinds in stages, showing
  hints and statuses, and naming the structural findings — a broken link,
  a link to an undeclared kind, a link through an undeclared field, a
  missing required link, a status outside the kind's list — all read the
  registry's data; no type name, field name or status value stands in
  madarch's code. A status outside the allowed list and a missing
  required link are findings on the page, never refusals of the registry.
- **No repository depends on another.** The skill set keeps a copy of the
  schema at the version it targets and validates the registry it writes
  with its own code; its CI never checks out or runs madarch, and the
  pin and the checkout leave the skills branch. Moving either side to a
  new contract version is a deliberate change on each side, visible in
  the `$id` and in the file's `contract` field.
- **The manifest is read live.** The wiki reads the registry fresh with
  every ask and digests its bytes with the pages, so an edit to it — a
  kind added, a link declared, the version changed — is a change the
  server-sent stream reports and the pages show, within the same two
  seconds a page's edit has always taken, with no restart.
- **The structural rules move to the manifest; the content rules stay
  the set's.** Wherever a rule of the set's product check can be
  expressed as a declaration (targets of a field, statuses, required
  links), the declaration carries it and the engine names the finding;
  the set's check keeps the content rules — the forms, the sections, the
  wording — and the set's documents record the boundary of what moved.
- **Document templates are overridable per product.** The set ships
  defaults; a product may hold its own template per kind at a documented
  place that is never rendered as a wiki page. The set's writing skills
  use the product's template when one exists, otherwise the default, and
  the set's reference records the precedence. The templates, their
  defaults and the override path belong to the skill set's lane; this
  record fixes the decision and the direction.

## Consequences
- The registry's contract-level refusals grow with the shape: the version
  gate (missing, not a whole number, unknown) and, per kind, the
  statuses given once and the links' fields given once, never named as
  one of the generic fields madarch reads itself, and each target naming
  a kind the registry declares — every refusal naming file, line, field
  path and words, and every one covered by a contract example.
- `schema/product-registry.schema.json` is versioned in its `$id`; the
  document-fields schema stands beside it unchanged. A reader of the
  published schema validates a registry of no other version; the
  examples' registries all carry `contract: 1`.
- The wiki's plain-pages degradation is the one seam a registry-driven
  wiki needs: what today's pages compute from the set's forms stands as
  long as the registry reads at a known version, and yields to the plain
  pages, under a named notice, the moment it does not. The kinds the
  pages compute from remain the set's forms until the registry lane
  (madarch-d7v3) moves them onto the declarations; the acceptance walk
  of the refinement is that lane's.
- The set's branch may drop the pin and the checkout; its registry test
  runs the copy of this schema beside its own reader. The set's
  `references/product.md` records the docs/ structure, the link
  declarations, the statuses, the template override path and its
  precedence.

Revisit if a link type needs more than the declaration carries (a label
per target kind, a direction the field cannot say), or if a version bump
is needed for the drawing the registry lane builds.
