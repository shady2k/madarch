# The engine's checkout stops shipping the moved skills; the install contract names the set

Change: engine-skills-install-contract
Base: 9ac753e557c3428e77573dab3f786cc2a27c1fbc
Tasks: madarch-cswc
Kind: behavior

## Intent
The standalone charter's outcome 4 (docs/milestones/standalone.md) and
decision 0021 (d) give the moved skills' home as the skill set:
describe-repository and write-intended-model live in shady2k-skills. The
set's release 0.106.0 (shady2k/skills main 5030227) now carries both, so the
engine's own checkout stops shipping them: the `skills/` folder leaves the
repository, the engine's documents name the skills only in the single
install-contract line (the set of 0.106.0 or later), and the start-a-product
guide's skills step names the set's release instead of this checkout's
`skills/` folder. The product-repository capability is restated whole as the
proposal below: the `describe-step` requirement keeps its name and now says
the step arrives through the set's installed release (requirement
`describe-step`: madarch carries the step), and `describe-skill` keeps the
product contract's behaviour, read from what the installed set writes — the
model folder with its review report, the architecture page and the derived
requirements, use cases and decision records under `docs/repositories/` —
proved by project-owned fixtures, never by the moved skill content the
checkout no longer holds.

The owner's approval for this behavior change:
"the standalone charter's outcome 4 (docs/milestones/standalone.md), decision 0021 (d), and the owner's yes of 2026-10-13 to running madarch-cswc".

Stories:
- As an engineer starting a product from the guide, the describing step
  comes from the skill set's installed release; a fresh clone of madarch
  alone holds no skills to copy.
- As a reader of the engine's documents, one line names the install
  contract — shady2k-skills 0.106.0 or later — and no current document
  sends anyone into the engine checkout for a skill.

## Out of scope
- The set's side: its checkout and releases (shady2k-skills 0.106.0 is
  released; the set's own documents and tests are its own lane).
- The product-repository generic `skills/` folder layout itself: the
  contract keeps the folder and the constitution's line about it; this
  change removes only the skill sources this checkout shipped and every
  code path or test that read them.
- Syncing the proposal into `docs/system/capabilities/product-repository.md`
  (the spec sync at closure, by the integration).

## Changes to requirements
- product-repository/describe-step (replaced): the describing step is
  carried by the installed skill set — the install contract being
  shady2k-skills 0.106.0 or later — and the engine's checkout ships no
  skills; the guide names the set's release, the checkout holds no
  `skills/` folder, and a fresh draft carries nothing laid until the
  installed set lays the section. The old requirement pinned the step to
  `skills/describe-repository/` in this checkout, its `SKILL.md` and
  `AGENTS-section.md`, and the guide's copy commands; all of it goes with
  the set.
- product-repository/describe-skill (replaced): the described
  repository's artifacts — the model and its review report in the
  repository's own model folder, the architecture page, the derived
  requirements and use cases marked derived from code with
  `Source: code` and `Evidence:` citations, and the decision records —
  are the product contract the wiki reads, run by the product's agent
  through the installed release and proved by project-owned fixtures;
  the description refuses an uncommitted checkout, keeps evidence
  traceable, and the product serves the same wiki with no skill
  installed at all. The old requirement named the skill's internal
  steps and the set's product forms as madarch's to spell; the places
  and the guarantees stay, the spelling goes with the set.

## Preserved contracts
- product-repository/draft: the draft's layout and skeleton are unchanged; `skills/` stays a created, tracked, empty-but-kept folder of the product (test)
- product-repository/manifest: the reading of a manifest, its `skills` pin field included, and every manifest case are unchanged (test)
- product-repository/list: `madarch list` output and refusals are unchanged (test)
- product-wiki/pages: the wiki's grouping reads the product's files only; a `skills/own.md` file stays a non-page (test)

## Coverage
- product-repository/draft: static, test
- product-repository/manifest: static, test
- product-repository/list: static, test
- product-repository/describe-step: static, test
- product-repository/describe-skill: static, test
- product-wiki/pages: static, test

## Blocking questions
None.

## Design and decisions
- The product contract keeps the generic `skills/` folder; only this
  checkout's skill sources and every code path or test reading them leave
  (the interpretation the owner's approval carries).
- Product behaviour is read from what the installed set writes — the model
  folder with its review report, `docs/repositories/<name>/` — and proved
  with project-owned fixtures (`test/fixtures/model-skill-example/`), never
  with a copy of the moved skill content.
- The set release is pinned beside decision 0021 in the milestone's
  outcome-4 note, in documents, never in code.

## Acceptance evidence
To be recorded at review and acceptance: `bun run check`,
`MADARCH_SKIP_PERF=1 bun test` on the touched files, the scoped searches
naming no moved skill content outside the install-contract line, one
gpt-6-luna review.

## DONE WHEN
- `skills/` no longer exists in this repository, and no code path or test
  in `src/`, `wiki/app/src/`, `scripts/` or `test/` reads it;
- the current engine documents name the moved skills only in the single
  install-contract line (shady2k-skills 0.106.0 or later);
- the guide's skills step names the set's release, not this checkout's
  `skills/` folder;
- `madarch new` and the describe step keep working for a product whose
  agent installs the set.
