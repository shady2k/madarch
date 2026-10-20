# Stage 10 writes the intent the documents state, and turns their contradictions with code into open questions

Change: madarch-tzte.24.3
Base: 24ec77f2
Tasks: madarch-tzte.24.3
Kind: no-behavior

## Intent

Decision 0026, "Stages": "Agent: 8 overview hypothesis, 9 module-boundary
refinement, 10 intent from documents, 11 intent from comments and commits, 12
module understanding bottom-up (leaves first, parents from children's summaries),
13 system recovery and reconciliation (recovered architecture beside the intended
one with the mapping between them). Every stage writes facts into the graph and
reads its context from it." Stage 8 landed on the agent-stage shape of
madarch-tzte.24.1; stage 10 is the second of the six to declare itself on that
shape, and the first at the `intent` level of self-filling's outcome 4 — "evidence
of intent (documents, code comments, commits, pull requests, linked pages)".

The task's DONE WHEN: "Units per document cluster read the document index (21.4:
documents, sections, links to code) and write intent claims (what the system is
meant to do) tied to sections and to the code nodes they name; contradictions
with code facts become open questions of type 'contradiction'." And: "Fake ACP
agent tests including a stale README claim (the training repository plants one)."

- **`src/fill/stages/doc-intent.ts`** — stage 10 (`doc-intent`, fact stage
  `10-intent-documents`): one unit per repository that holds documents — the
  repository's document cluster — whose packet adds the document index of its
  scope to the shape's own sections (`documents`, `sections`, `links`), whose
  places are the documents of its scope, and which writes intent claims
  (`claim`) and open questions (`question`) beside the coverage the shape
  writes. The statements stand at the `intent` level: what people recorded,
  cited to the sections that record it, never what the agent assumes.
- **`src/fill/stages/index.ts`** — the stage's one import and one `.register`
  line beside stage 8's, where the run's wiring names an agent.

## Rationale

`no-behavior`: the change implements accepted decisions (0026's "Stages",
"Agent input", "Scale" and "Writing"; 0027's plan, split and publication; 0005's
layers and statuses; self-filling's outcomes 4 and 5) without moving a
requirement of the product, exactly as madarch-tzte.24.1 recorded for the shape
and stage 8. The fill's capability is proposed by change `fill-pipeline-monday`
and is not closed, so the rebuild's own requirement text lands with the stage
that closes decision 0026.

No served surface moves: the daemon's fill wiring names no agent
(`src/product/fill-stages.ts`), so a run registers no agent stage today; the
registry's second agent stage is visible to a run that wires one, which is what
the tests do. No route, command, help text or product command changes.

## Out of scope

- **Stages 9, 11, 12 and 13.** madarch-tzte.24.2, 24.4, 24.5 and 24.6 declare
  themselves on the shape in their own modules; each adds its own one
  registration line.
- **The comments' and commits' intent.** Stage 11 (24.4) reads the comments and
  the history; this stage reads the document index (21.4) and nothing else as
  its own input. A task key a document names is stage 6's `task-key` edge, and
  the intent it carries is stage 11's reading.
- **Children's summaries and the fan-in grouping level.** Stage 10's units are
  the shape's repository-level units; a unit that cannot finish splits into its
  documents, whose own scope is theirs, so no parent reads a child's summary and
  the shape's declared bounds (`scale`, `resolvedScale`) stand unused by this
  stage's plan — the bottom-up stage (24.5) is the one that reads children.
- **The fill's capability text**, proposed by `fill-pipeline-monday` and not
  current, as the changes before this one recorded theirs.

## Preserved contracts

- fill-stages/registry: a stage is still one module plus its registration line, and its declaration is still pure data; stage 10 adds its own line beside stage 8's and registers nothing when the run wires no agent.
- fill-stages/configuration: a product still enables, disables and limits a stage through its manifest, and a run still snapshots what it resolved; the numbers a unit is held to are the limits its stage resolved.
- fill-orchestrator/plan: a run still plans its units from the declared stages and reads the graph through the same reader; stage 10's plan is one unit per repository that holds documents (one per document past the planned size), and the plans of the stages before it are unchanged.
- fill-orchestrator/attempt: a worker still follows one unit through a lease, a draft, a validation and a publication, under one fence, with the unit's own MCP server opened for the attempt and closed when it ends.
- fill-orchestrator/split: a split still seals its child set and its parent's checkpoint in one transaction and suspends its parent; what a child of stage 10 covers is the document its place names, and a place that is the unit's own scope is still no child of it.
- fill-orchestrator/publish: a unit's facts are still published in one transaction, at most once per generation, with the reads rechecked and the queue settled inside it.
- server/protocol: the unit tool route, its refusals and its order are unchanged; stage 10 declares kinds the schema's table already gave `10-intent-documents`, so no tool answer changes.
- release-binary/installers: the release binary still builds, installs and runs; the change adds no dependency and no served surface.

## Coverage

- fill-stages/registry: test
- fill-stages/configuration: test
- fill-orchestrator/plan: test
- fill-orchestrator/attempt: test
- fill-orchestrator/split: test
- fill-orchestrator/publish: test
- server/protocol: test
- release-binary/installers: test

## Blocking questions

None.

## Design and decisions

Taken from decisions 0026, 0027, 0005 and self-filling's outcomes 4 and 5;
nothing here re-decides them.

- **A document cluster is the repository's documents, read together.** The
  task's words — "units per document cluster" — name the unit's granularity:
  one unit reads a cluster of documents because an intent claim may tie one
  document's section to the code node another names, and one reader of a
  repository's pages would read them together. The graph holds no node for such
  a cluster, so the plan names it by the node the scope stands at (the
  repository fact, 0026: an id is a node's, never a run's), estimates it at one
  bounded reading per document (0026's own measure of a place), and past 0026's
  planned size plans the level below: one unit per document, stage 6's own
  granularity ("a unit is one document"), each named by its document fact at the
  document's own scope. A repository past the plan's unit bound stands as one
  unit — never a shorter list — and its run-time split names the documents the
  plan did not, as every scope the bound cannot enumerate does. A product no
  repository of which holds documents is nothing found, not a failed plan
  (0027: "no producer" is distinct from "producer found nothing").
- **The packet's own sections are the document index.** `documents` names every
  document of the scope (path, title, media type, by its fact id), `sections`
  names their sections in the order a reader meets them (document, then the
  section's own line, then the anchor), and `links` names every end the scope's
  `document-link` edges reach, with the link's own place — the resolved ends
  with the node they name (its kind and path, so code files, documents and
  sections are told apart) and the unresolved ones as the term the document
  wrote. A link that names nothing of the graph is therefore something the unit
  sees and asks about, never something dropped (21.4 wrote it with its place
  exactly so). Each section is a read of the graph through the unit's own
  reader, recorded as the unit's dependency, bounded with its cut named in the
  packet's marker; a section takes a key of its own, so nothing of the shape's
  packet is replaced.
- **What stage 10 writes, and at what level.** A claim states what a document
  says the system is meant to do: its subject is the section (or document) whose
  words state it, its object the code node the document names or the words
  themselves, its evidence the section's own bytes at the pinned commit (0004's
  atom; the schema's table writes a `claim` at `10-intent-documents`, and the
  registry refuses a kind its own stage does not write). A question of type
  `contradiction` (self-filling's outcome 5 names the type) is what a
  contradiction between a document and the code becomes: its prompt names both
  sides, it is about the node the contradiction concerns, and it cites the
  section. Both stand at 0005's `inferred` layer, `proposed` — the shape's own
  rule for everything an agent writes — and the fixed part tells every unit the
  statements are `intent`: what people recorded, not what the agent assumes,
  which is the difference from stage 8's `meaning`.
- **A unit's places are its documents.** What a unit's coverage counts, what its
  answer names, and what the children of its split cover are the same list: the
  documents of its scope, each a place whose scope text is the document's own
  path. A document unit's one place is its own scope, so it splits no further —
  the finest place the document index has is the document, and its coverage says
  so whether it read the document or none. The documents are read as facts of
  the graph, which the store answers whole, so the list is no sample and the
  unit's coverage is never cut by its own enumeration.
- **The answer names documents, not code paths.** The stage's answer schema
  keeps the shape's fields (status, covered, remaining, summary) and reads the
  place lists as the documents of the scope: a `done` answer whose places are
  not all covered is a `partial` one, and the documents left out are planned as
  units of their own — the shape's own rule, worded for the document index. The
  nudge names the documents of the scope, so a unit that answered wrong can
  answer without reading the packet again.
- **The stage consumes the document index, and names it.** `document`,
  `section` and `document-link` are required at freshness `any` — read where the
  run published them, and a run whose configuration disables stage 6 is starved
  by the exact path, which 0027 asks the plan to name rather than run the stage
  over an empty packet. `claim` and `module` are optional: read as absent where
  no run published them.

## Acceptance evidence

The checks, each command's own exit status, at hand-over. The branch is one
commit over `origin/main` `24ec77f2`.

- `bun run check` (`tsc --noEmit`) exit 0 at every commit of the branch.
- The feature document gate (`node .shady2k/documents.mjs check --phase feature
  --change madarch-tzte.24.3 --candidate worktree --target origin/main`) exit 0,
  clean, after every edit round and at hand-over.
- The focused suites run in SkyPilot, not on this machine (the owner's rule),
  `madarch-sky-test <worktree> <files>`, each with the tests' own exit status:
  named in the queue entry with their run ids.
- CI on the exact SHA of the branch: named in the queue entry.
- The independent review, one fresh read-only session over
  `git diff origin/main...HEAD`, told not to run anything on this machine: named
  in the queue entry with its verdict and the answers.

## DONE WHEN

- Units per document cluster read the document index (21.4: documents, sections,
  links to code) and write intent claims tied to sections and to the code nodes
  they name; contradictions with code facts become open questions of type
  `contradiction` — held by `src/fill/stages/doc-intent.ts` and the tests named
  in the queue entry.
- Fake ACP agent tests, including a stale README claim shaped like the training
  repository plants one — `test/fill-doc-intent-stage.test.ts`.
