# Model check

Capability: model-check

## Purpose
Checking a repository's intended model against the repository it describes,
without a server: that the model compiles, that every element, interface and
relation names evidence that still exists and still reads as it did, that a
data entity's evidence, when it gives one, is resolved and reported stale like
any other item, that
every requirement a scenario names exists in the repository's capability
specs, that every file of the repository is accounted for, which problems recognised
methods find in it, and what its views look like. Run by a person or an agent
from a checkout of madarch, on a checkout of the repository, before the model
lands; it reads and never writes the repository.

## Requirement: compiles — The model is loaded and compiled as the server would
When a repository is checked, the check shall load and compile its model with
the same loader and compiler the rest of madarch uses, and report every error
and every warning with its file and line. If the model does not compile, then
the check shall fail and report nothing it could only compute from a compiled
model.

### Scenario: refused-model
- Given: a repository whose model names a parent `billing` that no element has
- When: the repository is checked
- Then: the check fails, reporting the element, its file and line and `billing` as not found, and reports no evidence, coverage or problem findings

### Scenario: warnings-reported
- Given: a repository whose model compiles with one unnamed relation
- When: the repository is checked
- Then: the check reports the warning with the relation, its file and line, and does not fail for it

## Requirement: evidence-complete — Everything names its evidence at a revision
When a repository is checked, the check shall fail for every element,
interface and relation that has no evidence item, and for every evidence item
without a commit and a blob, naming each by its id and the file and line where
it is declared.

### Scenario: missing-evidence
- Given: a model in which the relation `ui-calls-core` has no evidence and the element `core` has an item with a file and no commit
- When: the repository is checked
- Then: the check fails, naming `ui-calls-core` as having no evidence and `core`'s item as having no commit and blob, each with its file and line

## Requirement: evidence-resolves — Every item names text that exists
When an evidence item is checked, the check shall confirm that its file has
the item's blob at the item's commit and that its lines are within that blob.
This covers every evidence item the model declares, a data entity's included:
an entity's item is resolved like any other, while naming none is still no
failure (evidence-complete asks it of elements, interfaces and relations only).
If the commit is not in the repository (a squash or a rebase removed it), then
the check shall accept the item when the blob appears at the item's path in the
history of the checked revision, and report that its commit is missing. If the
file, the blob or the lines cannot be found that way, then the check shall
fail, naming the item.

### Scenario: line-past-end
- Given: an item naming lines 40 to 45 of a file that has 30 lines in its blob
- When: the repository is checked
- Then: the check fails, naming the item and saying the file has 30 lines

### Scenario: squashed-commit
- Given: an item whose commit was removed by a squash merge, and whose blob is the file's content in the squashed commit on the main line
- When: the repository is checked
- Then: the item is accepted, and the check reports that its commit is missing and where the blob was found

### Scenario: wrong-blob
- Given: an item whose blob is not the file's blob at its commit
- When: the repository is checked
- Then: the check fails, naming the item, the blob it names and the blob the file has at that commit

### Scenario: entity-line-past-end
- Given: the data entity `session-id`, whose evidence item names lines 40 to 45 of a file that has 30 lines in its blob
- When: the repository is checked
- Then: the check fails, naming `session-id`'s item and saying the file has 30 lines

## Requirement: staleness — What changed since it was read is reported
When a repository is checked at a revision, the check shall report as stale
every evidence item the model declares, a data entity's included, and every
document claim in the review report, whose file
at that revision differs from its blob, naming the model id or the claim and
the file; stale evidence alone does not fail the check.

### Scenario: file-changed-since
- Given: an item on `core` naming a file whose content changed in a commit after the item's commit
- When: the repository is checked at the newer commit
- Then: the check passes and reports `core`'s item as stale, with the file and both blobs

### Scenario: entity-file-changed-since
- Given: an evidence item on the data entity `session-id` naming a file whose content changed in a commit after the item's commit
- When: the repository is checked at the newer commit
- Then: the check passes and reports `session-id`'s item as stale, with the file and both blobs

## Requirement: requirements-resolve — Every requirement a scenario names exists
When a repository's model compiles, the check shall resolve each requirement a
scenario names, `capability/requirement`, against the capability specs of the
checked revision: the file named after the capability, with the extension
`.md`, under `docs/system/capabilities/`, and in it a heading
`## Requirement:` followed by the requirement's id. If the file or the heading is not
there, then the check shall fail naming the scenario, the requirement, the
model file and line where it is named, and which of the two is missing.

### Scenario: requirement-found
- Given: a repository whose scenario `send-model` names `server/store`, and whose `docs/system/capabilities/server.md` has the heading `## Requirement: store — Sent models are kept`
- When: the repository is checked
- Then: the check reports nothing about `send-model`'s requirements

### Scenario: unknown-requirement
- Given: a repository whose scenario `send-model` names `server/archive`, and whose `server.md` has no requirement `archive`
- When: the repository is checked
- Then: the check fails naming `send-model`, `server/archive`, the model file and line, and saying `server.md` has no requirement `archive`

### Scenario: unknown-capability
- Given: a repository with no `docs/system/capabilities/billing.md`, whose scenario names `billing/refund`
- When: the repository is checked
- Then: the check fails naming the scenario, `billing/refund`, the model file and line, and saying there is no capability spec `billing`

## Requirement: assignment — Every file is accounted for
When a repository is checked, the check shall read the review report's
assignment table, in which each row names a path (a file or a folder, covering
everything under it) and either the id of an element or `excluded` with a
reason. If a file tracked by git at the checked revision is under no row, a
row names an element the model does not have, or an `excluded` row gives no
reason, then the check shall fail naming each. The deepest row covering a file
decides it.

### Scenario: unassigned-package
- Given: a repository with a folder `internal/notify` that no row of the assignment table covers
- When: the repository is checked
- Then: the check fails, naming the files under `internal/notify` as unassigned, grouped by folder

### Scenario: excluded-with-reason
- Given: a row `docs/` `excluded` "documentation, read for claims"
- When: the repository is checked
- Then: no file under `docs/` is reported

## Requirement: problems — Problems recognised methods define are found
When a repository's model compiles, the check shall report, each with the
method that defines it, its source and the ids of the elements and relations
involved:
- a dependency cycle among elements of the same parent, relations collapsed to
  that level (the Acyclic Dependencies Principle; Arcan's Cyclic Dependency);
- an unstable dependency: an element depending on a sibling less stable than
  itself, stability computed from the count of relations in and out at that
  level (the Stable Dependencies Principle; Arcan's Unstable Dependency);
- a hub: an element whose relations in and out at its level both reach the
  threshold stated in the report (Arcan's Hub-Like Dependency);
- a magic source or sink: a store, or a topic or queue interface, that some
  relation writes to or sends to and none reads or receives from, or the
  reverse (Microsoft's rules for a sensible data flow diagram);
- a flow across a trust boundary: an interaction whose ends are in different
  zones, or a data transfer of a confidential category to an external element,
  reported as a question to examine for tampering, disclosure and denial of
  service, not as a defect (STRIDE per element);
- hidden coupling: two elements whose assigned files changed together in at
  least the number of commits stated in the report, within the history window
  stated, with no relation between them at any level (Mo, Cai, Kazman and
  Xiao's modularity violation).
Problems do not fail the check.

### Scenario: cycle-between-siblings
- Given: modules `a`, `b` and `c` under one service, with relations `a` to `b`, `b` to `c` and `c` to `a`
- When: the repository is checked
- Then: one cycle is reported naming `a`, `b`, `c` and the three relations, citing the Acyclic Dependencies Principle

### Scenario: sink-without-reader
- Given: a topic interface that one relation marks `action: send` and no relation marks `action: receive`
- When: the repository is checked
- Then: a magic sink is reported naming the interface and the sending relation

### Scenario: hidden-coupling
- Given: modules `x` and `y` with no relation between them, whose assigned files changed together in six commits of the window, the threshold being five
- When: the repository is checked
- Then: hidden coupling is reported naming `x`, `y`, the count and three of the commits

## Requirement: views — Every view is rendered for reading
When the check is asked for views and the model compiles, it shall render
every view of the model as Mermaid pages and a LikeC4 workspace into a folder
the caller names, the same pages the renderer gives, at the checked revision
and the first state.

### Scenario: views-rendered
- Given: a model with one system holding two services, one of which holds modules
- When: the repository is checked with a views folder
- Then: the folder holds the landscape page, one page per element with children and the LikeC4 workspace

## Requirement: result — One report, read by people and agents
The check shall print its findings grouped as errors, stale items and
problems, and on request the same as JSON; it shall exit 0 when nothing fails,
1 when something fails and 2 when the repository or its model cannot be read.

### Scenario: exit-codes
- Given: a repository whose model has stale items and problems and nothing that fails
- When: the repository is checked
- Then: the exit code is 0 and the output lists the stale items and problems

## Quality requirements
- Performance: checking a repository of 3 000 tracked files and a model of 200
  elements, history included, takes under one minute on a developer's laptop.
- Reliability and recovery: the check writes nothing to the repository or its
  git data; the views folder is the only place it writes.
- Security and data protection: it reads only the repository's files and git
  history; no network.
- Data: not applicable (it keeps nothing).
- Usability: every finding names a model id or a file, with the line where it
  has one; thresholds are printed with the findings they decide.
- Compatibility and operation: needs git and Bun on the machine; reads any
  repository git can read.

## Context
Decisions 0002 (the intended model in git), 0014 (format principles), 0016
(the product's knowledge base). The
methods behind the problems: R. C. Martin, "Design Principles and Design
Patterns" (2000); F. Arcelli Fontana et al., Arcan (ICSA 2017); S. Hernan, S.
Lambert, T. Ostwald, A. Shostack, "Uncover Security Design Flaws Using the
STRIDE Approach" (MSDN, 2006); R. Mo, Y. Cai, R. Kazman, L. Xiao, "Hotspot
Patterns" (WICSA 2015).

## Coverage limits
The problems are computed from the model and the history, not from the code:
a relation the model lacks is not seen by the dependency problems. Thresholds
for hubs and hidden coupling are the check's own, not a standard's.
Requirements are found only at the capability specs' default path; a mapping of
documents kept elsewhere comes with the document contract (madarch-o3b).
