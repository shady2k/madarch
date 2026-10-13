# Contract v1: the versioned published schema, the declared links and statuses, and the degradation the wiki names

Change: standalone-contract-v1
Base: 46dfdaad
Tasks: madarch-m8eo.1
Kind: behavior

## Intent
The owner's refinement of decision 0021 (the brief at the run's start, its
manifest-shape addendum confirmed ~19:35 MSK, 2026-10-12), landed as
contract v1 before anything of the standalone milestone ships: the kinds
registry file carries its contract version (`contract: 1`), the published
schema carries the same version in its `$id`
(`https://github.com/shady2k/madarch/schema/v1/product-registry.schema.json`),
no repository depends on another, and the kinds declare their structure as
data — per kind its allowed statuses and its link fields, each link field
naming the kinds its targets may come from, the backlink label the
target's page shows, the cardinality (one or many) and whether the link is
required. madarch accepts the versions it knows: a `contract: 1` registry
reads as before; on a version it does not read, or a registry that refuses
its own reading, the served wiki names what stands in a banner over plain
pages, never failing silently. The registry's bytes ride the pages
revision, so an edit to the manifest is a change the wiki reports and
shows without a restart. The structural findings the declarations can
express (a missing required link, a status outside the allowed list, a
link to an undeclared kind or field, a broken link) are the registry
lane's (madarch-d7v3) computing surface; this change lands the shape, its
validation and its refusal words, and the version gate the lane builds on.

What a user can do that they could not before: a product manifest can say
what its documents may carry and link to, a tool can validate a registry
against a schema whose `$id` names the version, and a wiki serves a
manifest of a version it does not know by naming it and degrading, never
by hiding it or failing.

## Out of scope
- Drawing links and backlinks from the declared link fields, and
  computing the structural findings (missing required link, status
  outside the allowed list, an undeclared kind or field target, a broken
  link): madarch-d7v3 builds them on this change's declared shape; this
  change moves no page behaviour for a reading registry beyond keeping it
  as today.
- Moving the wiki's kinds, eyebrows, groups, stage mapping and hints onto
  the registry data, and the plain-page behaviour of a registryless
  product (decision 0021 outcome 3, madarch-d7v3).
- The skill set's side: the copy of the schema at the version it targets,
  the dropping of the pin and the checkout on the skills branch, the
  docs/ structure and the template override path with its precedence, and
  the move of the structural rules out of the set's check — the set's lane
  (the registry and t3yt work in the set's repository); the record of the
  decisions is 0021, as amended.
- The lifecycle commands and `madarch list`: the manifest's own schema
  version has its own gate; the registry is not read by `madarch list`,
  and nothing there changes.

## Rationale
The version lives in the file itself (the first word of `docs/kinds.yaml`,
reading as `contract: 1`) because the wiki reads the file before anything
of the schema's shape is certain, and because a product's manifest must
name what it was written for wherever it travels — the schema's `$id`
carries the same number so the two sides' versions can never drift
silently. The degradation is the owner's wording: the wiki names the
version it found and the version it supports, and serves plain pages — so
the same seam covers an edited-while-being-saved manifest, which the live
pickup needs to never fail.

## Changes to requirements
- product-repository/contract (new here; the landed change recorded it
  and the replay into the current spec is part of this change): the
  registry schema published with its version in its `$id`, the registry
  file's own `contract` field, the per-kind declarations (statuses; link
  fields with field, targets by id prefix, backlink, cardinality, one or
  many, required or not), the version gate and the whole reading's
  refusals with their words, the served wiki's banner and plain-pages
  degradation for a version madarch does not read and for a registry that
  refuses its reading, and the registry's bytes in the pages revision.

## Preserved contracts
- product-repository/draft: test
- product-repository/manifest: test
- product-repository/list: test
- product-repository/describe-step: none (the change touches no describing file)
- product-repository/describe-skill: none
- product-wiki/pages: test
- product-wiki/shell: test
- product-wiki/front-matter: test
- product-wiki/live: test
- product-wiki/serve: test
- product-wiki/app: test
- product-wiki/result: test
- product-wiki/stages: test
- intended-model/schema: test
- compiled-model/shape: test
- views/view-set: test
- wiki/pages: test
- wiki/links: test

## Coverage
- product-repository/contract: test
- product-repository/draft: test
- product-repository/manifest: test
- product-repository/list: test
- product-repository/describe-step: test
- product-repository/describe-skill: test
- product-wiki/pages: test
- product-wiki/shell: test
- product-wiki/front-matter: test
- product-wiki/live: test
- product-wiki/serve: test
- product-wiki/app: test
- product-wiki/result: test
- product-wiki/stages: test
- intended-model/schema: test
- compiled-model/shape: test
- views/view-set: test
- wiki/pages: test
- wiki/links: test
