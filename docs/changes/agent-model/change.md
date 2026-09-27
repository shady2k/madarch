# Let an agent write the intended model of a repository

Change: agent-model
Base: 8c258f41e360dc4fb9319b24827a3a205411d56b
Tasks: madarch-utk.1.1, madarch-utk.1.2, madarch-utk.1.3, madarch-utk.1.4, madarch-utk.1.5
Kind: behavior

## Intent
Today a repository gets an intended model only if a person writes it by hand,
and nothing says whether a model still matches the repository it describes.
After this change a coding agent with madarch's skill writes the model of a
repository it has never seen: it reads the documents first, checks each claim
in the code, and writes a model in which every element, interface and relation
names the text it was read from, at a commit and a blob. Beside the model it
leaves a review report: which document claims the code confirms, contradicts
or has outgrown, what the code holds that no document mentions, where every
file of the repository went, and which problems recognised methods find. A
local model check, run from a checkout of madarch, proves the model compiles,
that its evidence exists and still reads as it did, that every file is
accounted for, and renders the views for reading. Inside a pull request the
same skill updates the model from the branch's changes, so the model moves
with the code in small steps instead of being rewritten months later.

Stories:
- As an architect of a repository with no model, I ask my agent for one and
  get a model whose three levels I can read, and a report that tells me which
  of our documents are out of date.
- As an engineer, I open a relation in the model and follow its evidence to
  the exact lines at the exact commit, even after our squash merge.
- As an engineer opening a pull request, I ask my agent to update the model
  for my branch, and the reviewer reads the model's change next to the code's.
- As a reviewer, I run the model check and see what went stale, what file is
  unaccounted for, and which cycles, hubs, sinks and hidden couplings the
  model shows, each with the method that names it.

## Out of scope
The server and any view on request (the next outcome); running the skill or
the check in CI, or updating a model automatically after a merge; madarch
itself evaluating rules, and making the check's problems part of the server's
checks; a fact layer that keeps where each fact came from; per-fact provenance
in the model's YAML; views per environment or architecture state; our own web
viewer; code-level analysis (complexity, duplication, dead functions,
ownership); committing the model the skill writes for nocx to nocx or to this
repository (only findings about the skill are recorded here, as the charter
says); languages or repositories beyond what nocx and the two fixture
repositories exercise.

## Rationale
Planned with the owner on 2026-09-27. The owner asked that documents come
first and be confirmed by the code; that the review surface recognised
problems rather than invented ones (found by research in primary sources, and
compared with what repowise reports); that the model be updated as part of a
pull request, small increments being cheaper than a later catch-up; and that
evidence name the commit. Codex reviewed the design and recommended the claims
table, evidence rules by the kind of claim, capability-sized interfaces and an
acceptance hard to fake.

## Changes to requirements
- intended-model/evidence (replaced): an evidence item names a file and
  optionally a line or a range of lines, and a commit together with the file's
  blob id; a commit without a blob, a reversed range or a malformed id is
  refused. The compiled model keeps items as given.
- model-check (new capability): the model compiles; everything names evidence
  with a commit and a blob; every item resolves (by blob where a squash removed
  its commit); stale evidence and stale claims are reported; every tracked file
  is under a row of the review's assignment table; cycles, unstable
  dependencies, hubs, magic sources and sinks, flows across trust boundaries
  and hidden coupling are reported with their methods; views are rendered to a
  folder; one report with exit codes 0, 1 and 2.
- model-authoring (new capability): one Agent Skills folder; documents first,
  claims checked in code, intent from decision records and specifications,
  prose as hypothesis, undocumented code reported; evidence rules by the kind
  of claim; the review report beside the model; finishes on a passing check and
  read views; updates the model for a pull request from its changes.

## Preserved contracts
None.

## Coverage
- intended-model/evidence: test
- model-check/compiles: test
- model-check/evidence-complete: test
- model-check/evidence-resolves: test
- model-check/staleness: test
- model-check/assignment: test
- model-check/problems: test
- model-check/views: test
- model-check/result: test
- model-authoring/skill: skill-fixtures, nocx-run
- model-authoring/documents-first: skill-fixtures, nocx-run
- model-authoring/evidence-rules: nocx-run
- model-authoring/review: skill-fixtures, nocx-run
- model-authoring/checked: skill-fixtures, nocx-run
- model-authoring/update: nocx-update

## Blocking questions
None.

## Design and decisions
Decided with the owner on 2026-09-27:
- Documents first, confirmed in code. Accepted decision records and
  specifications state intent; descriptive prose is a hypothesis; plans go to
  the report only. This is the comparison of reflexion models (Murphy, Notkin,
  Sullivan, 1995).
- A review report beside the model, not provenance inside it: an element holds
  several claims (that it exists, its parent, its kind) that can be confirmed
  differently, and one mark on the element would hide that.
- The problems reported are those recognised methods define and the model can
  show: dependency cycles and unstable dependencies (Martin's Acyclic and
  Stable Dependencies Principles, Arcan), hubs (Arcan), magic sources and
  sinks and flows across trust boundaries (Microsoft's STRIDE method, the
  latter as questions), hidden coupling (Mo, Cai, Kazman and Xiao's modularity
  violation; repowise reports the same between files). Divergence and absence
  between documents and code are the claims table itself. Code-level findings
  repowise also reports (complexity, duplication, ownership) stay out:
  madarch consumes such tools, it does not repeat them.
- The model is updated inside the pull request, by the author's agent, not in
  CI and not after the merge.
- The check is a local script in madarch reusing the real loader, compiler and
  renderer. The charter's excluded "command-line client" is a client of the
  server, not this check.
- Evidence names the commit and the file's blob id, so an item survives a
  squash or a rebase: the check finds the blob in the main line's history when
  the commit is gone.

Decided by the agent within those:
- The check computes the problems it can compute from the model and the
  history, so they are deterministic and tested; the skill adds the claims,
  the undocumented findings and the questions only a reader can raise.
- The assignment table is a table in the review report, since every YAML file
  in the model's folder is read as the model.
- Interfaces are sized by capability, not by contract namespace (nocx has 49
  namespaces and 265 methods; about 10 to 15 capability interfaces), every
  contract file assigned or excluded.
- Findings name model ids, so a later viewer can lay them on the diagram.
- A missing commit or blob is refused by the model check, not by the format:
  hand-written models, such as the reference system, keep loading.

Acceptance (the checks named in Coverage):
- `skill-fixtures`: the skill run on two small fixture repositories built by
  the tests, one whose architecture document names a module the code no longer
  has, one with a package no document mentions; the report lists each, and the
  check passes.
- `nocx-run`: on a clean checkout of nocx at a pinned commit, with no model,
  the skill writes the model and the report; the check passes with no missing
  evidence; every tracked file is assigned or excluded with a reason; the
  landscape, nocx's parts and the groups of its core render readable, measured
  as the project's lesson on views says (labels at least 12 pixels, no
  overlaps, numbers recorded per page); the evidence of at least ten relations,
  chosen across kinds, is read by hand and supports each relation.
- `nocx-update`: the skill writes the model at an earlier nocx commit, then
  updates it over the real merges up to the pinned commit; the check passes,
  and every difference from the model written from scratch at the pinned
  commit is listed and explained.
- Estimated at 7 to 10 hours of agent work in two or three stages: the
  evidence format and the model check; the skill with its fixtures and the
  nocx run; the update mode. A guess: one finished run is too little history
  to measure against.

## Acceptance evidence
Recorded on the change's tasks as `check:` comments and in the stages'
acceptance records, with the nocx pages' numbers and the relations read by
hand.

## DONE WHEN
On a clean checkout of nocx at a pinned commit, an agent with the skill writes
an intended model and a review report; the model check passes with no missing
evidence and every tracked file assigned or excluded; the model's three levels
(context, nocx's parts, the groups of its core) render readable by the
project's measure; the report lists which of nocx's document claims the code
confirms, contradicts or has outgrown and the problems found, each with its
method; and the model updated from an earlier commit over the real merges
differs from the one written from scratch only in ways the report explains.
Where it is seen: the skill's folder in madarch and the model check's command,
run on a checkout of nocx; the model, the report and its pages in that
checkout.
