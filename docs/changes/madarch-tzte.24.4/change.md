# Stage 11 writes the intent and rationale that comments and commits state

Change: madarch-tzte.24.4
Base: 24ec77f2
Tasks: madarch-tzte.24.4
Kind: no-behavior

## Intent

Decision 0026, "Stages": "Agent: 8 overview hypothesis, 9 module-boundary
refinement, 10 intent from documents, 11 intent from comments and commits, 12
module understanding bottom-up …". Stage 8 landed on the shared agent-stage
shape (madarch-tzte.24.1); this change lands stage 11 on the same shape, the
fourth of the six stages 0026 lists and the second to stand at a level below
the product.

The intent of a product lives where its own words live: the comments its code
carries (stage 3 publishes them as `comment` facts) and the commits its
history records, with the task keys their messages name (madarch-tzte.21.2's
history stage publishes both). Stage 11 reads them in bounded units and writes
what they state:

- **`src/fill/stages/intent-history.ts`** — the stage. One unit per module
  fact of 0026's cluster level; a module past 0026's planned size is planned
  as its member files, one level down, within the shape's own bounds. Its
  packet adds two sections to the shape's own: `comments` (where each comment
  of the module's files stands — file, line, form — never the words, which the
  unit reads with `evidence_span`, because 0026 pastes no file content) and
  `commits` (the commits whose changed files the module's files hold, newest
  first, each with the task keys its message names). It writes claims — an
  `intent` claim states what the writers meant, a `why` claim states the
  rationale — every claim cited to the words it stands on, and a question of
  type `undocumented-behaviour` where the commits or the code show behaviour no
  comment explains.
- **`src/fill/stages/index.ts`** — one import and one `.register(...)` line:
  stage 11 stands beside stage 8 where a run wires an agent, in stage order.
- **The stage's own SQL through the reader seam** (`commentsRead`,
  `taskKeysRead`): a comment carries no repository in its value, so where it
  stands is its provenance, which the JSON read grammar of `graph-reads.ts`
  cannot filter by. The read runs over the `fact` view `stage-reads.ts`
  creates before a run (the history stage's own precedent), names a repository
  checked against `ID_PATTERN` and file paths `repositoryPath` checked, and is
  recorded as the unit's dependency like every other read.

## Rationale

`no-behavior`: the change implements an accepted decision (0026's stage 11,
"Agent input", "Scale" and "Writing"; self-filling's outcomes 4 and 5) without
moving a requirement of the product. The fill's capability is proposed by
change `fill-pipeline-monday` and is not closed, so the rebuild's own
requirement text lands with the stage that closes decision 0026, exactly as
madarch-tzte.24.1 recorded its own.

No served surface moves: the daemon's fill wiring names no agent
(`src/product/fill-stages.ts`), so a run registers no agent stage today; the
registry's change is visible to a run that wires one, which is what the tests
do. No route, command, help text or product command changes.

## Out of scope

- **Stages 9, 10, 12 and 13.** 24.2, 24.3, 24.5 and 24.6 declare themselves on
  the shape; this change lands stage 11 only. Its registry edit is one import
  and one registration line, so a sibling landing beside it is one line beside
  this one.
- **Reading pull requests.** 0026's stage 11 names comments and commits; the
  pull requests of a hosted forge are another source, and no stage of this
  build reads a forge yet.
- **Documents' contradictions and terms.** Stage 10's (24.3) own questions;
  this stage raises only what comments and commits leave undocumented.

## Preserved contracts

- fill-stages/registry: a stage is still one module plus its registration line, its declaration still pure data; stage 11 adds one line beside stage 8's and the shape's module is unchanged.
- fill-stages/configuration: a product still enables, disables and limits a stage through its manifest, and a run still snapshots what it resolved.
- fill-orchestrator/plan: a run still plans its units from the declared stages and reads the graph through the same reader; stage 11's plan is one unit per module, split into member files past the planned size within the landed bounds.
- fill-orchestrator/attempt: unchanged — the shape's own attempt runs stage 11's units as it runs stage 8's.
- fill-orchestrator/split: unchanged — the shape's own split seals stage 11's children as it seals stage 8's.
- fill-orchestrator/publish: unchanged — the shape's own publication publishes stage 11's draft as it publishes stage 8's.

## Coverage

- fill-stages/registry: test
- fill-stages/configuration: test
- fill-orchestrator/plan: test
- fill-orchestrator/attempt: test
- fill-orchestrator/split: test
- fill-orchestrator/publish: test

## Blocking questions

None.

## Design and decisions

Taken from decisions 0026, 0027 and 0005 and self-filling's outcomes 4 and 5;
nothing here re-decides them.

- **One unit per module, at the cluster level.** 0026's hierarchy runs product
  → repository → package/build target → cluster → sub-cluster, and stage 5's
  modules are its clusters: seeded from packages and build targets and split
  until each fits a unit. Intent is read where the code is, and the module is
  the division the graph already holds, so the plan names one unit per module
  fact and no unit per file that no module holds. A unit's scope text is its
  repository — a module is a cluster of files and no one path of them — so a
  checked write cites bytes anywhere in that repository, while the unit's
  places (what its coverage counts and what a split names as children) are its
  own member files, read by the shape's own `memberPlaces`. The rules tell the
  unit its places are its module's files; the fixed part already holds every
  unit to its scope.
- **The comments section names where a comment stands, never what it says.**
  The shape's own packet refuses to paste file content — a comment's own label
  is its text, and `agent-packet.ts` names such nodes by where they stand
  instead — so the section holds each comment's fact id, its form and its
  file and line, and the unit reads the words with `evidence_span`, the one
  read that carries bytes (0026, "Agents and tools"). The section is still the
  recorded read that makes a moved comment stale. Both sections read in the
  module's own files — the same members the packet's own list holds — so a
  member list the read's cap cut holds the section to the files it showed:
  a comment of another module is never shown under this scope's label, and
  the packet's marker is what names that cut.
- **The comments read is the stage's own SQL, not a grammar read.** A
  `comment` fact carries no repository in its value (its identity is its
  provenance place), so the grammar's `facts-with` cannot select the comments
  of one repository, let alone of one module's files. The stage's own SQL over
  the `fact` view is the seam `stage-reads.ts` already provides ("a stage's
  own SQL, through a view named `fact`") and the history stage already uses;
  the reader records it like any other read. Every name in the text is checked
  before it is interpolated (`ID_PATTERN` for the repository,
  `repositoryPath` for the paths, `FACT_ID_PATTERN` for the commit ids of the
  task-key read, quotes doubled), so no read is built from a value a product
  did not write.
- **Commits, with their task keys, bounded and newest first.** The packet's
  own `history` section reads the repository's twenty newest commits; stage 11
  needs the commits that touched its module's files, so its own `commits`
  section filters the repository's commit facts on their changed files and
  carries each shown commit's task keys beside it (one recorded task-key read
  for the shown commits, their ids schema-checked). A module with more history
  than the bound holds is cut by the section's own bound, named in the
  packet's marker — a unit that cannot see a commit cannot state it, and the
  plan's file-level units read the same history per file. A commit whose
  touched list is longer than a row holds is still one row, and the row itself
  names the cut (`touchedMore`, the count of the scope's files it touched
  beyond the twenty it lists): a row's cut is no packet cut, which alone the
  marker names, and no reader is left to guess a merge's extent.
- **Two predicates, so a reader can tell a purpose from a reason.** The
  schema's claim predicate is free (`one lower-case kebab token`); the fixed
  part pins this stage's own to `intent` (what the writers meant the part to
  do) and `why` (why it is as it is: a rationale a comment records, a choice a
  commit made). A claim from a commit names the commit and its task key in its
  text, so a reader can find the work behind it.
- **Undocumented behaviour is a question of its own type, not a claim.**
  Self-filling's outcome 5 types the open questions, and `undocumented
  behaviour` is one of them: behaviour the commits or the code show that no
  comment explains is raised as a question of type `undocumented-behaviour`
  (the token `QUESTION_TYPES` carries) about the node whose behaviour it is.
  0005 makes a complete coverage the only ground for a claim of absence, and
  the unit's answer is read by the shape's own contract, so nothing here
  decides a second one.
- **The plan's estimate is the module's own count.** Stage 5 writes how many
  files and symbols a module holds (`ModuleValue.members`); the plan estimates
  from it and falls back to the graph's held count where a fact carries none.
  A file unit of the plan is estimated as one bounded span, the same estimate
  the shape's own place reader gives a split child.

## Acceptance evidence

The checks, each command's own exit status, at hand-over.

## DONE WHEN

- One unit per module reads the comments of its files (the syntax stage's
  facts), the commits and task keys of its repository's history
  (madarch-tzte.21.2's facts) and writes intent claims and 'why' rationale
  tied to their sources; undocumented behaviour becomes an open question of
  its own type.
- Tested end to end with the fake ACP agent, including the training
  repository's planted 'why' comment as a fixture comment; no real agent
  prompt.
