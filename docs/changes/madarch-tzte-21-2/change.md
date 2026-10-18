# The history stage: the pinned commit's ancestry as commit facts and the task keys its messages name

Change: madarch-tzte-21-2
Base: 5c712dea9b05a1993ffe6ed8fd0035c985350df8
Tasks: madarch-tzte.21.2
Kind: behavior

## Intent

Decision 0026 makes the fill a set of deterministic stages that read a product's
repositories into the product graph; stage 7 is history. The graph's vocabulary
for it exists (`src/fill/facts.ts`: the `commit`, `task-key` and `coverage`
kinds), the stage contract and registry exist (decisions 0027, madarch-tzte.19.3),
and nothing reads a repository's history into the graph yet.

After this change the fill holds a registered stage `history`. Its units come
from the graph — one per pinned snapshot, named by the repository the product
knows and the commit that snapshot pinned — and a unit writes the pinned commit's
ancestry as `commit` facts (the commit, both of git's times, the subject, the
author, the parents in git's own order and the paths the commit changed as
repository paths), one `task-key` edge per key a commit message names, and a
`coverage` fact saying what the read could not reach. The ancestry is bounded by
the stage's configured depth, 1000 commits where the product says nothing, and
the bound is named in the coverage when it cuts. A second run after one new
commit writes that commit's facts alone: what an earlier run published is read
back from the graph before anything is drafted, and a fact the graph already
holds as this read would write it is not written again. A shallow clone and a
parent whose object is not in the checkout are coverage gaps of the unit, never a
silently shorter history, and a git call that fails for any other reason is
thrown naming the repository, the folder, the command, its exit status and git's
own words.

The stage reads Git directly, at the pinned commit, and never the snapshot
reader: a repository's history is Git's own.

## Out of scope

- The snapshot reader (`src/fill/snapshot.ts`, madarch-tzte.21.1) and the other
  deterministic stages of 0026: nothing here reads a tree or a file's bytes.
- The fact storage and the write path (madarch-tzte.20): the stage's graph reads
  are written in the fill's own vocabulary and proved against a fake graph, and
  the checked write (`checkFact` plus the write path's own checks) is where a
  real storage judges them.
- The orchestrator (madarch-tzte.19.5) and its publication: the stage is proved
  through `plan`, `execute` and `validate` with a fake context.
- The agent stages that read this history (8–13): `commit` and `task-key` facts
  are what they will read, and none of them is here.
- The old fill pipeline under `src/product/fill*.ts` and its own
  `readPinnedGitHistory`, which nothing of this change calls.

## Rationale

Kind `behavior`: the change adds a capability the product did not have — a stage
that reads a repository's Git history into the product graph — and it is the
first code that writes the fill's `commit` kind. Nothing a person sees changes
yet, because no run wires the stage; the orchestrator that does is
madarch-tzte.19.5.

## Changes to requirements

Added capability `fill-history` against an absent baseline, its complete proposed
text in `capabilities/fill-history.md`, with the requirements `stage`,
`ancestry`, `task-keys`, `incremental`, `bound`, `gaps`, `reads` and the quality
requirements above them.

## Preserved contracts

- product-repository/draft: unchanged — the git runs a draft product's creation makes are the same runs with the same environment; the loader variables those runs never inherit are now one exported list, shared with the fill's reader instead of written twice.
- product-repository/manifest: unchanged — reading a product's manifest reads the same file and refuses the same things; nothing of this change reads a manifest.

## Coverage

- fill-history/stage: test
- fill-history/ancestry: test
- fill-history/task-keys: test
- fill-history/incremental: test
- fill-history/bound: test
- fill-history/gaps: test
- fill-history/reads: test
- product-repository/draft: test
- product-repository/manifest: test

## Blocking questions

None.

## Design and decisions

- **The stage reads Git, and the checkout comes from the wiring.**
  `createGitHistoryReader(folderOf)` takes the folder of each repository's
  checkout from the run's caller — the same shape decision 0027 gives a stage's
  inputs — because a checkout's folder is a machine's path and no fact of the
  fill may carry one. The registration (`src/fill/stages/index.ts`) hands that
  reader in, so the module itself names no path; this is the smallest edit
  another stage can sit beside, one line in one function.
- **The ancestry is read with four git calls and no file's bytes.** The pinned
  commit is resolved (`rev-parse --verify <commit>^{commit}`), the ancestry is
  listed with its changed paths (`git log --topo-order --no-renames
  --diff-merges=first-parent --format=… --name-only -z --max-count=<depth+1>`,
  one call whatever the size of the history), the repository's shallow state is
  asked about (a fifth call asks where the shallow file is, only where the
  repository is shallow), and the version that answered is read for the facts'
  source. The commit's parents, times and paths are read from the commit object
  — never from the working tree — so a dirty checkout and a different branch
  change no fact; and every flag is explicit, so a machine's git configuration
  changes none either.
- **One record per commit, read from a format of this module's own.** The log
  format opens each record with a control character and joins its fields with
  another, the message last so a message holding the field separator still
  reads. A record whose first field is no commit — which is what a message
  holding the record separator produces — is refused by name rather than read as
  two records, and the refusal names the repository, the commit and the record:
  a smaller history is never read as a whole one.
- **The changed paths are the commit's own diff.** `--no-renames` makes a rename
  the path it left and the path it took, and `--diff-merges=first-parent` makes a
  merge's paths what it changed against its first parent, which is the one answer
  a reader can compare between two commits. A path list is put through
  `repositoryPath`, so a machine separator or an absolute path can never reach a
  fact, and the list is written in code point order, each path once, which is the
  schema's own rule for the `commit.files` field.
- **The commit kind's value grows the fields the task asks for.** The landed
  `CommitValue` carried the commit, its own time, its subject and its author;
  the DONE WHEN asks for the ancestry's parents and the paths each commit
  changed, and for the author time, and the task key stage 11 will read is the
  one git records (`authoredAt`) where the fact's own time (`committedAt`) is
  git's committer time: a rebase or an amend writes a new committer time over an
  author time that stays. The kind's version stays the schema's own version,
  because no fact of the kind was ever written before this change — nothing
  stores the old shape — and the schema's `commit.parents` is a list in its
  reader's own order (git's first parent first, which is what says which line a
  merge continues) while `commit.files` is the sorted list of paths. A test of
  the schema's own file pins both rules, and both lists are read entry by entry
  by the part's own checker — a changed path is a repository path, a parent is a
  commit — so `PART_LIST_FIELDS` is the one place that says so and a fact's list
  can carry neither a machine's path nor a name the graph cannot join.
- **The graph reads are three, and their row shape is this change's proposal.**
  `PINNED_SNAPSHOTS_QUERY` asks the graph for the pinned snapshots, and
  `commitsHeldQuery` and `coverageHeldQuery` ask for what this repository's
  history already holds. They are SQL against the fact store's rows in the
  fill's own vocabulary of fact kinds, and each selects only what its caller
  needs — a pinned snapshot's repository and commit, a commit fact's commit and
  value, a coverage fact's value — filtering by the kind, the repository and the
  scope it stands on. That shape is the fact storage's to meet or to change:
  that storage is madarch-tzte.20's and is not landed, so the three reads are
  written once, exported, and pinned by a test rather than scattered through the
  stage. The repository and the scope a read
  interpolates are checked against their own forms first.
- **A list in its reader's own order names each entry once, wherever the repeat
  stands.** The sorted lists find a repeat beside its twin, because equal names
  stand next to each other in code point order; an own-order list has no such
  order to lean on, so a commit's parents are matched by name (a map from the
  name to where it was read) rather than by their neighbour. A commit naming the
  same parent twice is refused at the second of them, which is the rule the
  schema states for every list of names.
- **Git's own seconds are read as they are, and a time this machine cannot hold
  is named.** Git counts whole seconds from the epoch and its own count may be
  negative, so a commit dated before 1970 is read rather than refused; an instant
  an ISO 8601 time cannot hold is refused naming the commit and what the read
  made of it, never a bare runtime error. No fixture can make a pre-1970 commit
  with the git of today (it refuses to create or to write such an object), so
  this is read-and-stated, not test-proved: what the tests do prove is the
  refusals around it, through a program standing in for git (a record a message
  broke in two, a time that is no time, a walk that failed, a `PATH` with no git
  in it), which is also how the parse's own no-silent-smaller-result rules are
  exercised.
- **Incrementality is a read of the graph, and the fact's value is what decides.**
  A unit reads back the commit facts of its repository (with the value each
  holds) and its own coverage fact, and writes a commit's facts only where the
  graph holds none or holds another value. Ids cannot decide it: a fact's id is
  the digest of its identity — the repository and the commit — and the ancestry
  or the paths it carries are its value, so a commit whose parents were once
  unreadable (a shallow boundary) is written again when they are there, and one
  the graph holds as this read would write it is left alone. The same rule
  covers the coverage fact, which is why a rerun at the same pin drafts nothing
  at all: the task's "a second run after one new commit writes only that commit's
  facts" holds without a rerun rewriting the history around it.
- **The coverage names every gap, and its `read` list is what was read.**
  `complete` is false exactly when a gap was left; a gap's `what` names what was
  not read — the ancestry a bound cut, the shallow boundary a clone stops at,
  the object git could not read — and its reason is `budget` for the bound,
  `inaccessible` for a boundary or an unreadable object and `error` for a
  shallow file the read cannot open. The list is in code point order, each `what`
  once, which is the schema's own rule, and two causes that would name one `what`
  are two gaps saying two things — the bound's cut names the ancestry, the
  shallow gap names the boundary commit — because a coverage the schema refuses
  for a repeated `what` would report no gap at all and take the unit down with
  it. A shallow clone is found through git's own shallow file rather than by
  reading an empty parent list as a root, and a missing parent is found in the
  call that failed, where git names the object it could not read and, where it
  says so, the commit whose parents it was traversing.
  One thing a gap does not name is a boundary commit's own file list: git has no
  parent in the checkout to diff it against, so it answers the whole tree as the
  paths that commit added, and the next read that can reach the parents writes
  that commit's paths again — the last published read of a commit is what the
  graph holds.
- **The stage consumes its own `commit` capability.** A unit reads what its
  earlier run published, and decision 0027's registry lets a stage that produces
  a capability satisfy itself, so no other producer of `commit` starves it and
  no edge runs from the stage to itself. The pinned snapshot is consumed as
  required: a stage that would read an ancestry with no pin must be refused by
  its own path (`history → snapshot → no producer`) rather than reading nothing
  in silence.
- **`validate` judges the draft, not the unit.** Every write is a fact write of
  a kind this stage produces, every fact passes `checkFact` (so a refusal names
  the path it stands at), and every `task-key` edge names a commit fact the same
  draft writes — an edge to a node the draft does not write is the one way a
  draft of this stage could name a node that does not exist. An empty draft is
  judged whole.

## Acceptance evidence

Owner approval pending (coordinator). Static, test and review receipts are
recorded on task madarch-tzte.21.2; mutation is left to the stage's assembled
mutation run, as the owner decided.
