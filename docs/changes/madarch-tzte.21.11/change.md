# The deterministic stages fill the current madarch tree inside a 4 GB pod, the embedded store growing in proportion to the facts it holds

Change: madarch-tzte.21.11
Base: b5a232b9
Tasks: madarch-tzte.21.11
Kind: no-behavior

## Intent

The stage madarch-tzte.21 asks the deterministic stages to fill the graph "for any repository size".
madarch-tzte.21.8 walked them over a 194-file madarch checkout and recorded, rather than fixed, the
limit it found: over the current tree (1 101 tracked files, about 2 900 units) the 2 CPU / 4 GB pod
killed the process (`exit 137`). This change measures where that memory goes, names the causes, fixes
them where they are caused, and walks the current tree to the end on the same pod.

**The pod** (SkyPilot, the owner's `recipes:madarch`): the cgroup's `memory.max` is 3 999 997 952 bytes,
`cpu.max` 2 CPUs. Measured with no walk running, the pod's own runtime already holds about 1.3 GB of
anonymous memory in that cgroup (`memory.stat` `anon` 1 357 MB at idle), so a walk has about 2.6 GB
before the kernel kills it. The walk is a shallow clone of madarch at `b5a232b9` plus the product's
`workspace.yaml`, run as the `fill-stages` service with eight workers, with a sampler inside the process
(memory every 2 s, the store's tables, a forced GC with heap statistics every 60 s) and a shell guard
reading the process's RSS and the cgroup's `memory.stat` every second.

**Where the memory went.** The store's tables are not the limit: the process dies while they are flat.
The spike is one unit, the modules stage's repository-wide unit `modules:madarch`, which reads 28 392
symbols, 1 101 files and 42 136 resolved edges, drafts 59 549 facts and publishes them in one
transaction. Probes after each of its steps, with a forced GC before every reading (live memory, not
garbage), named four causes — all of them in how the fill moves large sets through the embedded PGlite,
whose WebAssembly memory grows and never shrinks:

1. **One jsonb value per draft set.** `recordUnitDraft` wrote the unit's whole draft (34 MB of JSON) as
   one `jsonb` parameter. Measured on the pod in isolation (60 000 writes of the modules stage's shape):
   one such statement took PGlite's memory up by **487 MB** for good (`arrayBuffers` 498 → 985 MB); the
   same bytes in parts of 500 writes took it up by **0 MB**. In the walk this was the jump from 365 to
   704 MB of `arrayBuffers` between the unit's draft and its publication.
2. **The draft read back inside the publication.** `publishUnitIn` read the 34 MB set back from the row
   it had just written, to apply it — a second parse of the whole set (+140 MB in the first walk) in the
   middle of the transaction, while the attempt still held the same writes in memory.
3. **Statements answering a whole repository.** PGlite gathers a statement's whole answer in one buffer
   it grows by half again each time it fills and then copies once more before the rows are parsed; the
   modules unit's reads, and the publication's recheck of each of them, each held several copies of
   tens of megabytes (+66 MB and +81 MB of `arrayBuffers` per read in the first walk, every read again
   at the recheck). The rows also carried each fact's whole provenance, of which a row uses only the
   place.
4. **Two statements per published fact.** `applyPublishedFacts` wrote every fact and every holding with
   a statement of its own: 119 000 statements for the modules unit. In isolation, 60 000 facts written
   that way took the process's RSS up by **693 MB** in 25 s; in batches of 500 by **208 MB** in 4 s. In
   the walk this is where the pod finally died (RSS 1 666 → 1 994 MB inside the first 10 000 facts,
   the cgroup at 3 813 MB).

Two smaller causes the previous round found and fixed are kept: the read digest serialized both sides
of every comparison of its sort (Θ(n log n) serializations; 20 000 rows: 9 690 ms → 657 ms, same digest),
and a published draft kept its writes beside the published facts.

## Out of scope

- **The per-fact row size** (`fill_fact` 247.5 MB and `fill_fact_holding` 173.7 MB of the 556.5 MB
  peak). A fact's provenance is stored as JSON in its row and `fill_fact_holding` repeats a 64-hex
  publication digest on every holding; interning both changes the store's schema and needs a migration
  of a landed store, so it is a task of its own.
- **The fact volume** (112 004 occurrences, 33 168 references, 28 392 symbols for the current tree).
  Which facts the graph holds is decision 0026's and the stages' contracts.
- **Dead rows.** PGlite runs single-user with no autovacuum worker, so rows a run deletes or replaces —
  a published draft's parts, a re-ranked fact's old version — stay as dead space until a `VACUUM`;
  `fill_unit_draft_part` ends the walk at 76.9 MB of such space. Reclaiming it during a run needs a
  maintenance step outside the owner's transactions, which the orchestrator does not have today.
- **The WAL during a run.** PGlite reclaims WAL only at a clean close (measured in the first round);
  the store directory reached 1.4 GB on disk, which is disk, not the memory the pod was killed for.
- **Splitting the modules stage's repository-wide unit.** Decision 0026 makes a repository one
  clustering unit: a cluster's boundary depends on every other cluster and a rank on the whole graph's
  edges, and its split rule ("split until a unit's estimate fits") is about agent units' token windows.
  With the causes above fixed, the unit runs in about 1.2 GB of RSS, so nothing asks for a split.

## Preserved contracts

- fill-orchestrator/host: the host, the wiring and the publication's shape are the landed ones; a published generation is still published once, in one transaction, and `fill_publication` still answers a repeated request with the existing record.
- fill-stages/configuration: no stage, no read and no fact kind changes; the modules stage's unit answers the same reads and writes the same facts.

## Coverage

- fill-orchestrator/host: test
- fill-stages/configuration: test

## Rationale

The kind is `no-behavior`: no requirement of this repository changes. Stage madarch-tzte.21's requirement
— "the deterministic stages fill the graph for any repository size" — is the one this change makes hold,
and decision 0027 already says what the store keeps ("one publication per unit generation", a unit's
publication replacing only its own facts). Every read answers the same rows, every draft reads back the
same writes, every publication writes the same facts; what changes is how many statements carry them
and how large each is. No approval is therefore owed.

## Design and decisions

- **A draft set is stored in parts.** `fill_unit_draft` keeps the digest and the times; the writes stand
  in `fill_unit_draft_part`, 500 to a row (`DRAFT_PART_WRITES`), replaced whole when a set is recorded
  again and deleted when it is published. Every reader of a draft's writes — the orchestrator's own
  read, the graph read layer's `drafts` read, a page's drafts — reads them through `withDraftParts`, in
  its own transaction; a row recorded before the parts existed keeps its writes in its own column and
  still reads back whole.
- **A publication applies the writes its attempt holds.** `publishUnitIn` judges the draft by its head
  (digest, times) and, when the caller's `held` set carries the digest the row has, applies that set
  rather than reading the JSON back; any other digest is not trusted and the row's parts are read.
- **A read is asked in pages.** The stage reads of a repository's facts and edges ask in pages of 2 000
  rows by fact id (`READ_PAGE_ROWS`), so a repository-wide read of facts or edges answers a page at a
  time, and each row carries a fact's value and its place (`provenance->'place'`), not its whole
  provenance. The answer is the same rows in the same order. Three statements are not paged, and this
  change did not page them: a scope's coverage facts (`stageCoverageFacts`, one row per file of the
  scope — 1 238 over the current tree), a unit's own holding ids (`SELECT id FROM fill_fact_holding
  WHERE unit_id = $1` — 59 549 for the modules unit, a few megabytes of ids) and the history stage's
  ancestry read (`commitsHeldQuery`, one row per commit of the stage's bound of 1 000). Each answers ids
  or small values rather than the tens of megabytes of provenance a repository-wide read of facts
  answered, and the walk's peak held with them.
- **The publication reads one snapshot.** The recheck of the tracked reads runs inside the publication's
  transaction, and a read is now a page at a time: at the READ COMMITTED level a write transaction opens
  at, a fact another unit committed between two pages of one read would stand outside the recheck's
  answer while the recorded membership still matched — a publication on a graph that moved, which
  fill-orchestrator/staleness refuses. The publication's transaction is opened at REPEATABLE READ
  (`PUBLICATION_SNAPSHOT`, its first statement), so every page is one read of one graph.
- **A publication writes in batches.** Facts are written 500 to a statement (`PUBLICATION_BATCH`), one
  statement per kind of the batch because the measured fields are the kind's, with the same
  `ON CONFLICT` rules as before; holdings 500 to a statement.

## Acceptance evidence

All runs on the pod above; the measuring instruments (an in-process sampler, a memory-guarded walk
script, an isolated PGlite statement benchmark, a store report) were kept out of the product.

| walk over the current tree (`b5a232b9`, 1 101 files) | outcome | process RSS | where |
|---|---|---|---|
| before (landed code) | killed by the guard at 2 640 MB | 2 640 MB | the modules unit's publication, rechecking its reads |
| paged reads and the held draft only | killed by the pod (cgroup 3 813 MB) | ~2 000 MB | the modules unit's per-fact statements |
| **this change**, instrumented | **succeeded** | **peak 1 659 MB** (2 s samples) | — |
| **this change**, `madarch fill-stages` itself, rebased on `a2edc7de` | **succeeded**, exit 0 in 979 s | **peak 1 831 MB** (1 s samples) | — |

The modules unit with this change, live memory after a forced GC at each step: 1 091 MB RSS after its
symbols read, 1 240 MB after building its 59 549 facts, 1 157–1 220 MB through its reads' recheck,
1 207–1 215 MB through the application of its facts; PGlite's `arrayBuffers` stay at 228 MB from the
unit's first read to its commit (before: 365 → 1 036 MB).

The uninstrumented walk — the product's own `madarch fill-stages --workers 8` over the same clone,
sampled from outside the process every second — finished with exit 0 in 979 s (1 826 passes): peak
process RSS 1 831 MB; peak anonymous memory of the whole cgroup 3 135 MB, of which about 1.3 GB is the
pod's own runtime; the store directory at most 1 411 MB on disk, of which 832 MB WAL; the same facts by
kind as below within two of each kind (two more `defines`, `symbol` and `contains`, one more `call`,
one fewer `occurrence` and `reference`).

The instrumented walk: `run succeeded settled=true passes=1826 units=2888`, about 16 minutes of wall time
on the pod; peak process RSS 1 659 MB; the cgroup's anonymous memory at most 2 274 MB (of which about
1.3 GB is the pod's own runtime); peak store tables 556.5 MB (`fill_fact` 247.5, `fill_fact_holding`
173.7, `fill_unit_draft_part` 76.9 of dead space, `fill_page_change` 33.2, `fill_event` 7.7,
`fill_transition` 4.9, `job_common` 3.6, `fill_unit_read` 1.9); the store directory 1.4 GB on disk with
its WAL. Facts by kind: occurrence 112 004, reference 33 168, contains 31 424, defines 28 392, symbol
28 392, comment 13 468, call 9 586, section 6 040, test 2 983, entry-point 2 267, import 1 327, coverage
1 238, file 1 101, directory 549, document 339, module 281, task-key 215, document-link 96, inherits 29,
package 5, commit 2, repository 1, snapshot 1.

Tests: a read larger than two pages answers every fact once, in id order, and no statement answers more
than one page of 2 000 rows (`test/fill-stage-reads.test.ts`); a draft set larger than one part is
recorded in parts of 500, read back whole and in order, and replaced whole, and a row recorded before
the parts existed still reads back whole (`test/fill-orchestrator.test.ts`); a publication writes 1 001
facts in three statements (`test/fill-fact-store.test.ts`); a publication's transaction opens with the
repeatable-read statement, and PostgreSQL answers `repeatable read` for it while refusing the same
statement once a statement has run (`test/fill-orchestrator.test.ts`, "the snapshot a publication
reads"); a publication that loses its snapshot to a concurrent writer is retried, not thrown
(`test/fill-orchestrator.test.ts`); a retraction answers the set's head and reads none of its writes
back (`test/fill-orchestrator.test.ts`); a publication applies the set its attempt holds and reads the row
back only when the digest is not that one, and keeps no second copy of what it published
(`test/fill-checked-writes.test.ts`); the membership digest is the one the earlier implementation
recorded (`test/fill-orchestrator.test.ts`); an agent unit's published coverage is read as the store's
published facts, since a published draft keeps no copy (`test/fill-agent-unit.test.ts`).

 the independent review and its fixes

The stage's own acceptance ran the independent read-only review this change landed without: two rounds
of a fresh `prime-agent` session (`deepseek-v4.1-flash-auto`), the first over `929126d2` and the files as
they stood (verdict `ship`, no blocker, six findings), the second over the fixes (verdict
`fix-before-ship`, one finding on the commit's own split and seven more, all answered here and in the
commit that carries them). What each round found and what this change does with it:

- **A paged recheck at READ COMMITTED** (`src/fill/stage-reads.ts`, `src/fill/orchestrator.ts`): a fact
  another unit committed between two pages of one read stood outside the recheck while the recorded
  membership matched. Fixed: the publication's transaction is opened at REPEATABLE READ
  (`PUBLICATION_SNAPSHOT`), tested in `test/fill-orchestrator.test.ts`.
- **The compatibility path had no test** (`src/fill/orchestrator-store.ts`, `withDraftParts`): a row
  recorded before the parts existed. Fixed: a test inserts such a row and reads it back whole, and holds
  the column empty once the set is recorded again (`test/fill-orchestrator.test.ts`).
- **Three bounds had no test of their own size**: `DRAFT_PART_WRITES` 500, `READ_PAGE_ROWS` 2 000 and
  `PUBLICATION_BATCH` 500 were only read as the tests' own expectation, so a bound of 100 000 — the
  defect itself — passed. Fixed: the tests pin 500 / 2 000 / three statements for 1 001 facts
  (`test/fill-orchestrator.test.ts`, `test/fill-stage-reads.test.ts`, `test/fill-fact-store.test.ts`).
- **"No statement answers more than a page" was not the code's shape**: a coverage fact and a unit's
  holding ids are still answered in one statement. Fixed: the sentence above now says which reads page.
- **A retraction read the whole set back** (`retractUnitDraftIn`): every caller discards it, and a
  repository-wide unit's set is tens of megabytes. Fixed: it answers the set's head
  (`DraftHead`), so a retry or a cancellation reads no writes.
- **The tables an error names left out `fill_unit_draft_part`**, and the PostgreSQL scenario's own DROP
  list did too. Fixed in `orchestrator-store.ts`, `orchestrator.ts`, `graph-reads.ts`, `graph-pages.ts`
  and `test/fill-fact-store-postgres.test.ts`.

The second round, over those fixes:

- **The capability page and its index line belong to another change** (a blocker on the commit's shape):
  `docs/system/capabilities/fill-history.md` and its line in `docs/system/index.md` are
  `madarch-tzte-21-2`'s, not this change's. Fixed: they land in a commit of their own, `Task:
  madarch-tzte.21.2`, and this commit carries no document of another change.
- **Three more table lists still left `fill_unit_draft_part` out** (`src/fill/checked-writes.ts`,
  `src/fill/fact-store.ts`, and the split's own transaction in `src/fill/orchestrator.ts`). Fixed.
- **The statement stood only in the orchestrator's caller**: the store's own `publishUnit` still
  rechecked at READ COMMITTED. Fixed: `publishUnitIn` issues it as its own first statement, so every
  caller's transaction is one snapshot.
- **The second control read's comment claimed a refusal a snapshot cannot give**: inside one snapshot it
  answers what the first read answered, and an intent that comes later waits on the share lock. Fixed:
  the comment says exactly that.
- **A serialization failure had nowhere to go**: at REPEATABLE READ a concurrent writer makes the
  publication fail to serialize rather than wait, and the error came out of the worker. Fixed: the
  publication's transaction is wrapped, and SQLSTATE `40001`/`40P01` sends the attempt into the retry
  path the stale read already takes (`isSerializationFailure`, tested).
- **The retraction's head had no test**: reverting it left every suite green. Fixed: a test holds that a
  retraction answers the head and issues no statement against the parts.
- **The change record's paging claim and its test list were still wrong**: three reads that are not paged
  are now named, the two snapshot tests are cited separately, and the count of round 1's findings is
  right (`test/fill-orchestrator.test.ts` also lost an import the pinned literals made unused).
