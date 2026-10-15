# 0021. The product repository format is madarch's contract; madarch embeds no skills, forms or kinds

Status: accepted
Date: 2026-10-12

Refines 0016 (the single versioned contract) and 0017 (the product wiki as the
source of truth); revises the boundary 0019 drew and completes 0010's one
offline image: where 0019 gave the skill set the product repository's
lifecycle as well and had madarch read the set's document forms, this record
makes the format itself madarch's published contract and the kinds the skill
set's data.

## Context and problem
After the wiki run (the features A-G of idea-to-wiki), madarch's own code knew
the skill set word by word. The wiki's kind table and the kinds' id prefixes
(`H-`, `PRA-`, ...) stand in `src/product-wiki/documents.ts` and the app; the
stages' kind-to-stage mapping stands in `src/wiki/stages.ts`; the set's
product-repository program (create, rename, bootstrap, remote) reaches
madarch only through a pinned vendored copy (decision 0019's clause). One
change of the set's vocabulary becomes a madarch code change; an engineer who
never installed the set cannot use madarch freely; the skills' forms reach the
wiki because madarch hard-coded them.

The owner drew the boundary (2026-10-12, ~13:20 MSK, in conversation with the
assistant), in substance: madarch is a standalone engine and CLI — the product
repository commands (new, rename, repo add, clone, bootstrap, remote), the
wiki, the model with its check, compile and views, and later `madarch server`,
the same binary in one offline Docker image (0010). It embeds no skills, no
templates, no document forms. shady2k-skills owns the skills, templates, forms
and their checks (0019); the engineer works with both installed, and madarch
does not depend on the skill set. The boundary is a published, versioned
contract for the product repository format, living in madarch as its input
format, with a JSON schema and conformance examples the way the model contract
has them (0016).

## Considered options
1. **madarch owns the structure**: the document forms, the kinds and the
   lifecycle commands stay in madarch and the skill set reads documents in
   madarch's format (0016 first sketched a document contract in madarch;
   its own text only later records the product-repository lifecycle as the
   set's — 0019).
2. **The skill set owns everything it owns today** — the forms, the kinds, the
   lifecycle program and the whole product-repository contract — and madarch
   keeps reading exactly the set's shapes (the line 0019 settled on for the
   lifecycle: "the product repository's lifecycle is the set's too").
3. **A shared contract owned by neither**: the format is a versioned, published
   contract; the kinds stay data the skill set writes into a product; the
   lifecycle commands are madarch's own code.

## Decision
Option 3, decided by the owner on 2026-10-12, the boundary quoted in the
context. The owner's analogies, kept for their readers: madarch's relation to
the set is the one Kubernetes has to its CRDs and Backstage's catalog has to
its kinds, and the contract is LSP's shape — one server with a fixed
mechanism, the languages are data.

- **The product repository format is a published, versioned contract that
  lives in madarch** (it is madarch's input format, like the model contract
  of 0016). It defines:
  - the **layout** of a product repository: `workspace.yaml`, `docs/`,
    `repos/`, the model folder;
  - the **generic document fields** a document may carry for madarch to link
    it and place it: `id`, `kind`, `status`, `links`;
  - a **kinds registry file** the product holds: per kind its name, its id
    prefix, its folder, the stage it belongs to and a next-step hint;
  - the **stages** as an ordered list, with no fixed kinds.
- **madarch knows the mechanism, not the kinds.** Any Markdown under the
  layout renders. A document with generic fields gets its links, its status
  and its stage place computed. Where the product holds a kinds registry, the
  wiki groups the documents by kind and stage and the "what to do next" hints
  come from the registry. Without one, the plain page behaviour stands and the
  hints are generic. No skill-set word (a kind name, a prefix like `PRA-`, a
  stage's kind mapping) appears in madarch's code.
- **The skill set writes its kinds registry into the product at setup**, so a
  product set up by the skills groups and hints itself. The set keeps owning
  the forms, templates and checks (0019 stands there); the kinds registry is
  that ownership made data, so nothing in the contract turns on its change.
- **The lifecycle commands are madarch's code** (revising the clause of 0019
  that gave them to the set and pinned the vendored program): `madarch new`,
  `rename`, `repo add`, `bootstrap`, `remote`, `clone` and `list` read and
  write the contract's own files; the vendored folder leaves the repository,
  and the contract's schema and conformance examples take the manifest-shape
  tests' place, on 0016's pattern.
- **madarch ships as one binary**, in one offline Docker image (0010): the
  wiki, the model's check, views and queries, the lifecycle commands and
  later `madarch server` stand behind one command; nothing in the image reads
  a skill set. The engineer works with both installed — the skills craft, the
  engine serves — and either of them works without the other.

## Consequences
What this record changes in the format work that follows (none of it belongs
to this record; the follow-up work is filed in the tracker, deferred, with
its observable criteria):
- The contract arrives as the format's JSON schema with its version, its
  conformance examples and a check command beside them, taking the place of
  the tests that pin the set's shapes (0016's pattern for the model
  contract).
- The wiki stands changed by the same work: `src/product-wiki/documents.ts`'s
  kind table and prefixes, `src/wiki/stages.ts`'s kind-to-stage mapping and
  the app's bundled kinds list give way to registry reads; what stands
  without a registry is the mechanism (the fields, the stages, the plain
  pages, the generic hints).
- The check in a product repository stays the set's installed check (0019 is
  unchanged there): madarch runs what the product carries, names it by the
  contract's check command, and shows its findings on the page, never a check
  of its own.
- The kinds registry example the set publishes and writes at setup is
  expected to keep being tested against this schema and its examples in the
  set's CI, as 0016 planned for the contract in the other direction.
- Revisit if a product needs kinds the registry cannot express, or if the
  lifecycle commands need the set's program's behaviour beyond the
  contract's surface.

## Amendment 2026-10-12 (change standalone-contract-v1): contract v1, the version in the file, declared links and statuses

## Context and problem of the amendment
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

## Options the amendment considered
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

## The amendment's decision
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

- **The storage forms are enumerated in the manifest, and the imported fact is the fourth (2026-10-12 ~22:15 MSK, appended to the same conversation).** A kind may carry its `storage` form: `document` (the Markdown under `docs/`, the only form this engine version implements), `task` (the product's tracker), `model-element` (the model YAML), `component` (the React component plus its story), and `fact` — an entity imported from a system (a code index, GitOps/IaC, a CMDB, a cloud inventory, a broker, tracing), carrying its evidence as field names the fact's document carries (the source system, the ref or commit, the record id), truth held by the system it came from, read-only in the wiki. Authored entities and imported facts live in one graph with the same ids and links, told apart by provenance (decision 0005); CMDB-like configuration items — environments, clusters, hosts, endpoints, ports, topics — are entity types of this graph (0006's deployment layer), declared by people or imported. The engine keeps a form it does not implement and names it with an honest "not supported by this engine version" finding, never dropping it; the evidence shape is kept as data beside the fact's declaration.
- **The goals section is reserved in the manifest (2026-10-12 ~22:15 MSK, appended to the same conversation).** The manifest may carry `goals`, an optional list of maturity levels — a level naming its rules over the graph (counts by type and status, required-link coverage, provenance agreement, approvals by role) and the perspective it is granted for (business, architecture, security, testing, ops) when it holds one. The shape is reserved: this engine version keeps the section as data, and when it renders, it names the section as reserved-but-unimplemented — never a silent unknown section. The implementation is filed as madarch-wkne, deferred under the standalone milestone.
- **With the same ruling, the other three reservations of the refinement stand in the manifest the day they can (the vision's section A, 2026-10-12 ~20:00 MSK):** product-scoped global ids live on the product's own id and its documents' ids, with cross-product links named as external links and no finding; the lifecycle's planned, active, retiring, retired states ride the entities with their milestones, and retired records keep their place; and the roles section — roles with members, approvals naming roles, a signature holding the person, the role and the revision's digest — is reserved to be validated first, computed later. None of these three is written into contract v1's schema: their shape arrives with the milestone that implements them, and the reservation is this record's, not a schema field.

## Consequences of the amendment
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


## Contract conformance copies

The `shady2k-skills` repository pins copies at
`test/schemas/product-registry.schema.json` and
`test/schemas/registry-cases.json`.
Those copies are intentionally maintained by the set, not generated from this
repository at test time: when madarch changes either contract artifact, the
matching pinned copy in the set must be reviewed and updated deliberately in
the same contract change. The set's conformance check uses its own reader and these pinned files; a
contract change must be mirrored there deliberately, and the set does not
check out or run madarch.
