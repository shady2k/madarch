# Fill history stage

Capability: fill-history

## Purpose

Reading a repository's history into the product graph. Stage 7 of decision
0026's deterministic stages: the pinned commit's ancestry as `commit` facts,
the task keys the commit messages name as `task-key` edges, and a coverage fact
saying what the read could not reach. The stage is one module plus its
registration (decision 0027), it reads Git directly at the commit the run
pinned, and it reads what its earlier runs published so that one run after a new
commit writes the new commit alone.

## Requirement: stage — The history stage is a registered stage with a plan, an execute and a validate

The fill shall hold a stage with the id `history` that declares the fact kinds
it produces (`commit`, `task-key` and `coverage`, each at the schema's own
version and scoped to a repository), the capabilities it consumes — the pinned
snapshot of stage 0, since an ancestry is read at the commit a snapshot pinned,
and its own `commit` capability, since a unit reads what its earlier run
published, which starves nothing — its configuration schema with the stage's own
default configuration, and its own version, bumped when the behaviour it
declares changes. Its `plan` shall name its units from the graph and run no
read of Git; its `execute` shall run one unit and draft its facts through the
context; its `validate` shall judge a draft before publication.

### Scenario: registered
- Given: a registry and a wiring naming the checkout folder of each repository
- When: the deterministic stages are registered on it
- Then: the stage `history` is in the registry with version 1 and its own declaration

### Scenario: plan-from-snapshots
- Given: a graph answering the pinned snapshots `orders-api` at `c3` and `wiki` at `b1`
- When: the stage plans
- Then: the units are `orders-api@c3` and `wiki@b1`, each with the scope `repository:orders-api@c3` and `repository:wiki@b1`

### Scenario: nothing-found
- Given: a graph holding no pinned snapshot
- When: the stage plans
- Then: the plan holds no unit and answers `nothing-found`, never an empty plan of a stage whose input is not there yet

### Scenario: sorted-units
- Given: a graph answering `wiki` before `orders-api`, and `orders-api` at `a1` twice
- When: the stage plans
- Then: the units are `orders-api@a1` and `wiki@b1`, each once, in code point order of what they read

### Scenario: refuse-unreadable-row
- Given: a graph whose first row pins `orders-api` at `HEAD`
- When: the stage plans
- Then: the plan is refused, naming the query that answered, the row `0` and that a pinned commit is 40 lower-case hexadecimal digits

### Scenario: empty-draft
- Given: a unit whose commits and coverage the graph already holds as this read would write them
- When: the stage validates its empty draft
- Then: the draft is whole: a rerun that changed nothing writes nothing

### Scenario: error-names-where
- Given: a draft holding a commit fact whose changed path is `/opt/madarch-checkout/a.txt`, and a task-key edge whose commit no write of the draft names
- When: the stage validates it
- Then: both refusals are returned, the first naming `value.files[0]` and that a changed path is a repository path, the second that an edge names a node that exists

### Scenario: value-types-are-the-writers
- Given: a commit fact whose committer time is `yesterday` or the number `12345`
- When: the fact is checked
- Then: the schema does not read the field's own type at all — it reads the value's keys, its paths, its closed forms, its lists and its identity parts, and the digest of the identity — and does not refuse it: a value field's own type is the write path's check, and the stage reads a time from git's own seconds and refuses anything else before it writes one

### Scenario: rows-selected
- Given: the three reads
- When: they are read
- Then: the plan's read selects the repository and the commit a pinned snapshot names, the execute's read selects the commit and the value a commit fact holds, the coverage read selects the value of one scope's coverage fact, and each filters by the kind, the repository and the scope it stands on

## Requirement: ancestry — A unit writes the pinned commit's ancestry as commit facts

A unit shall write one `commit` fact per commit of the pinned commit's ancestry
it read: the repository by the product's own name for it, the commit (40
lower-case hexadecimal digits), the committer time and the author time as git
recorded them (ISO 8601 with `Z`), the subject, the author's name, the commit's
parents in git's own order (the first parent first, and not sorted) and the
paths the commit changed as repository paths, in code point order, each once (a
merge's against its first parent, a rename's as the path it left and the path it
took). A list of names names each entry once wherever the repeat stands: a
parent that stands twice is refused at the second of them, though the two stand
apart, and a changed path named twice is refused where the sorted list meets its
twin. The facts shall be drafted oldest first, so a parent's fact always stands
before its children's, and each fact shall be built by the schema's own
constructor, whose id digests the fact's identity and never the commit, the
reader's version or the run. No machine path shall reach any fact.

### Scenario: three-commits
- Given: a repository of three commits (`a.txt`; then `src/b.ts`; then `c.md` and `src/b.ts`), pinned at the third
- When: the unit runs
- Then: three commit facts are written, in parent order, whose parents are `[]`, `[first]`, `[second]` and whose files are `['a.txt']`, `['src/b.ts']`, `['c.md', 'src/b.ts']`

### Scenario: two-times
- Given: a commit authored at 01:00 and committed at 02:00
- When: its fact is written
- Then: `authoredAt` is `2026-10-01T01:00:00Z` and `committedAt` is `2026-10-01T02:00:00Z`

### Scenario: a-parent-twice
- Given: a commit fact whose parents name one commit at its first and its third entry
- When: the fact is checked
- Then: it is refused at `value.parents[2]`, since a list of names names each entry once however far apart the repeats stand

### Scenario: merge
- Given: a merge commit whose first parent is `main`'s tip and whose second is `side`'s, changing `side.txt` against its first parent
- When: its fact is written
- Then: its parents are `[main-tip, side]` in that order and its files are `['side.txt']`

### Scenario: empty-commit
- Given: a commit that changed no file
- When: its fact is written
- Then: its files are empty and the fact is one the schema reads

### Scenario: no-machine-path
- Given: a checkout in a temporary folder, read at its pinned commit
- When: the unit drafts its facts
- Then: no drafted fact holds that folder's path, and every path it holds is a repository path

### Scenario: list-entries-are-parts
- Given: a commit fact whose changed path is `/opt/madarch-checkout/src/order.ts`, or whose parent is `HEAD`
- When: the fact is checked
- Then: it is refused at `value.files[0]` or `value.parents[0]`, since the schema reads a changed path as a repository path and a parent as a commit, whoever wrote the fact

### Scenario: id-is-the-fact
- Given: the same commit read twice
- When: both facts are built
- Then: one id, the digest of the fact's own value and provenance, and never of the commit's reader version or of the run

## Requirement: task-keys — A commit's message names the task keys its edges carry

A unit shall write one `task-key` edge per key a commit message names, read by
the tracker's own rule (one or more lines beginning `Task:` and naming one key or several, separated by commas or spaces, read
case-insensitively, keys split on commas and whitespace, the case of each key
kept as the commit wrote it), each key once, in code point order, directly after
the commit fact it belongs to, and naming that commit fact as the edge's `from`.

### Scenario: one-line-several-keys
- Given: a commit whose message holds `Task: madarch-xyz.7, madarch-abc.1`
- When: the unit drafts it
- Then: two edges are written, for `madarch-abc.1` then `madarch-xyz.7`, each naming the commit fact's id

### Scenario: repeat-once
- Given: a message naming `madarch-abc.1` on two lines
- When: the unit drafts it
- Then: one edge names it: a key is named once per commit

### Scenario: case-kept
- Given: a message whose line reads `task: MADARCH-ABC.1`
- When: the key is read
- Then: the key is `MADARCH-ABC.1`, as the commit wrote it

### Scenario: no-task-line
- Given: a message with no `Task:` line
- When: the unit drafts it
- Then: the commit fact carries no task-key edge

## Requirement: incremental — A unit writes only what the graph does not hold as it would be written

Before drafting, a unit shall read back the commit facts its repository's
history holds, and shall write one only where the graph holds no fact for that
commit or holds a value other than the one this read would write. The unit's
coverage fact shall be written on the same rule: a coverage the graph already
holds as it would be written is not drafted again. So a second run after one new
commit writes that commit's facts alone, a rerun at the same pin writes nothing
at all, and a commit whose facts were read where its parents were not in the
checkout is written again once they are.

### Scenario: one-new-commit
- Given: a run that wrote the three commits of a repository, and one more commit made since
- When: a second unit runs at the new pin, reading back what the graph holds
- Then: one commit fact is written, the new commit's, with its task keys

### Scenario: rerun-writes-nothing
- Given: a run and the graph holding every fact it wrote
- When: the same unit runs again at the same pin
- Then: nothing is drafted, and the empty draft is judged whole

### Scenario: changed-value
- Given: a commit's fact read under a shallow boundary, whose recorded parents are empty
- When: the same unit runs where that commit's parents are readable
- Then: its fact is written again, with its parents

### Scenario: last-read-wins
- Given: a commit fact whose value differs from what this read would write
- When: the unit drafts
- Then: the value this read found is what is written, so what the graph holds of a commit is always the last published read of it, with the coverage that read wrote beside it

## Requirement: bound — A read is bounded by a configured depth and says so when it cuts

A unit shall read at most the stage's configured depth of the pinned commit's
ancestry (`fill.stages.history.config.depth`, `1000` where the product says
nothing, a whole number of 1 or more), and where more ancestry stands behind
what it read, its coverage shall name the bound it cut at rather than ending the
history in silence. The fact writes shall be the newest commits within the
bound, still in parent order.

### Scenario: default-depth
- Given: a stage whose product configures no depth
- When: a run resolves the stage
- Then: the depth is 1000, the number the stage declares as its own default, and the value its own schema accepts

### Scenario: configured-depth
- Given: a run whose stage configuration says `depth: 2`
- When: a unit reads a repository of three commits
- Then: the two newest commits are written, in parent order, and the oldest is not

### Scenario: cut-named
- Given: a run with `depth: 2` over a repository of three commits
- When: the unit drafts its coverage
- Then: it reads `complete: false` with the gap `the ancestry before c2` and the reason `budget`, naming the commit the bound stopped at

### Scenario: one-gap-per-what
- Given: a shallow clone whose boundary commit is also where the configured depth cut the read
- When: the unit drafts its coverage
- Then: the two causes stand as two gaps — the bound's cut names the ancestry, the shallow one names the boundary commit — and no `what` stands twice, since a coverage names each once and a coverage the schema refuses would report no gap at all

### Scenario: refuse-bad-depth
- Given: a stage configuration whose `depth` is `0`, `1.5` or missing
- When: the unit reads it
- Then: the run is refused, naming `config.depth`

## Requirement: gaps — A shallow clone and an unreadable parent are coverage, never a silent shorter history

A read that could not follow the ancestry shall report each gap it left, with
its reason, in the unit's coverage fact: the configured bound's cut as `budget`,
a shallow clone's boundary and a parent whose object is not in the checkout as
`inaccessible`, and a shallow boundary file this read cannot open where git
could — a file that went away between git's own read and this one's — as
`error`. A checkout whose shallow file the process cannot read at all is git's
own failure, and it arrives as the `inaccessible` gap naming the object the
boundary hid. A git call that fails for any other reason shall be thrown, naming
the repository, the checkout folder, the command, git's exit status and git's own
words, so no smaller history is ever read as the whole of one.

### Scenario: shallow-file-unreadable
- Given: a clone whose shallow file the process cannot open
- When: the unit runs
- Then: git fails over the object the boundary hid, the coverage names that object with the reason `inaccessible`, and the unit still drafts its coverage rather than losing the read

### Scenario: shallow-clone
- Given: a one-commit-deep clone of a repository of three commits, pinned at its tip
- When: the unit runs
- Then: one commit fact is written and the coverage reads `complete: false` with `the shallow boundary c3` (the clone's own boundary commit) and the reason `inaccessible`

### Scenario: missing-parent
- Given: a checkout whose root commit's own object was removed, pinned at the tip
- When: the unit runs
- Then: no commit fact is written for a history this read could not walk, and the coverage reads `complete: false` with `the commit c1` (the object git could not read) and the reason `inaccessible`

### Scenario: gap-and-published-commits
- Given: a read whose gaps were named and whose commits were written
- When: the unit drafts
- Then: the coverage stands beside the commit facts and names every gap once, in code point order

### Scenario: coverage-read-list
- Given: any unit's coverage fact
- When: it is read
- Then: its `read` list names the two questions the read answered — `the pinned commit and its ancestry` and `the task keys the commit messages name` — so a reader of the graph can tell what the reader read, and the same read of the same scope answers the same list

### Scenario: failed-read
- Given: a unit pinned at a commit the checkout does not hold
- When: the unit runs
- Then: the run is refused with the repository, the checkout folder, the `rev-parse --verify` command and git's own words, and nothing is drafted

### Scenario: cancelled
- Given: a unit whose signal is already aborted
- When: the unit runs
- Then: the run is refused as cancelled and nothing is drafted

## Requirement: reads — What the stage reads, and where its Git stands

The stage shall name its units from the graph through the read
`SELECT repository, commit FROM fact WHERE kind = 'snapshot'`, and shall read
the commits it already wrote and its own coverage through one read each, in the
fill's own vocabulary of fact kinds. Those three reads, and the row shape they
ask for — the fact's kind, repository, scope and commit beside its value — are
this stage's proposal for the fact storage of madarch-tzte.20, which is not
landed: they are the stage's contract with that storage, written once and pinned
by a test, and the storage may meet them or change them knowingly. The folder a
repository's Git stands in shall come from the run's wiring, by the product's
own name for the repository, since a checkout's folder is a machine's path and
no fact may carry one.

### Scenario: pinned-read
- Given: a plan
- When: it reads the graph
- Then: it made the one read naming the `snapshot` kind, and no other

### Scenario: held-reads
- Given: a unit of `orders-api` at `c3`
- When: it reads what it already wrote
- Then: it reads the `commit` facts of `orders-api` with the value each holds, and the `coverage` fact of its own scope

### Scenario: refused-held-row
- Given: a graph answering a commit held twice, or a row that is no record
- When: the unit reads it
- Then: the run is refused, naming the query that answered and the row

### Scenario: checkout-from-wiring
- Given: a run whose wiring names the folder of each repository
- When: a unit reads Git
- Then: the reader ran git in that folder, and the stage itself named no path

## Quality requirements

- **Performance and scale:** one unit reads one repository: four git calls whatever the size of the history — the pinned commit resolved, the ancestry listed with its paths, the shallow state asked about, the version read — and a fifth where the repository is shallow, asking where its shallow file is. The ancestry is bounded by the configured depth, no file's bytes are read one by one, and no fact holds a file's content.
- **Reliability and recovery:** the stage writes nothing outside its draft set, so a unit that fails leaves no fact behind; every fact is built by the schema's own constructor and judged by `checkFact` before publication; a rerun after a crash reads back what the graph holds and writes only what is missing or changed.
- **Security and data protection:** the stage runs git as a program, never through a shell; git's own loader variables (`GIT_DIR` and its companions) are kept out of every call, so a call in another checkout's worktree cannot write into it; the checkout folder reaches no fact.
- **Data:** the facts are the graph's own; the commit's parents, times and changed paths are read from the commit object, never from the working tree, so a dirty checkout or a different branch changes nothing.
- **Usability and accessibility:** every failure names the repository, the folder and the command; every gap is named in the coverage with its reason, so a reader of the graph can tell a shorter history from a whole one.
- **Compatibility and operation:** the reader asks git for its own version and cites it as the facts' source version, and the ancestry is read with explicit flags (`--topo-order`, `--no-renames`, `--diff-merges=first-parent`), so a machine's git configuration changes no fact.

## Context

Decision 0026 makes the fill's history one of the deterministic stages that read
a repository into the product graph, and decision 0027 gives a stage its
declaration, its plan, its execute and its validate over a context of tracked
reads and private draft writes. The facts' schema is the fill's own
(`src/fill/facts.ts`), whose `commit` kind carries the ancestry's own fields and
whose `coverage` kind carries what a reader could not reach (0004's coverage).

## Coverage limits

- The fact storage the stage's reads answer from lands under madarch-tzte.20
  (checked writes, bounded reads, unit-scoped publication): this change writes
  the reads in the fill's own vocabulary and proves them against a fake graph,
  and no real storage answers them yet.
- The orchestrator that plans, admits and publishes a unit (madarch-tzte.19.5)
  is not wired here: the stage is proved through `plan`, `execute` and `validate`
  with a fake context.
- The stage reads Git, not the snapshot reader of madarch-tzte.21.1: nothing of
  a repository's tree is needed to read its ancestry.
- A shallow boundary commit's `files` are what git answers for a commit with no
  parent in the checkout: the whole tree, as the paths that commit added, since
  there is no parent to diff it against. The coverage names the boundary, the
  commit's own diff stands as git gave it, and a later read that can reach the
  parents writes that commit's paths again. A boundary commit whose parents are
  readable but whose diff is empty is not this case.
- The stage's own capability names the pinned snapshot as `snapshot`, the fact
  kind stage 0 writes: the snapshot stage (madarch-tzte.21.1) declares that
  capability when its own change lands.
