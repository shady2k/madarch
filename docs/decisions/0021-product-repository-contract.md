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

