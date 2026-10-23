# A fill reads the current code first and history from git: thousands of commits fill in minutes, earlier structure only at chosen points

Change: madarch-m38l.5
Base: dfdaba6612be29db7e6b779ee8a86a1692478f8d
Tasks: madarch-m38l.5
Kind: no-behavior

## Intent
The extract driver (`src/extract/driver`) walked every first-parent commit and ran every tree
extractor over each (70 commits of the training repository took about six minutes; thousands would
take hours). Decision 0030 (`docs/decisions/0030-fill-the-tip-first-history-from-git.md`, amending
0028 with the owner's words) replaces that: the code of the last commit is parsed once, the history
facts are read from `git log` over all first-parent commits without parsing code, earlier code
structure is read only at chosen points (`points`, `fillSnapshot`), and a later fill reads the code
of the new last commit only, applying the renames of the commits in between.

## Rationale
`no-behavior`: no current capability describes the driver; the fill's capability is proposed by
`fill-pipeline-monday` and is not current, so the requirement text lands with the stage that closes
decision 0026. What a person sees changes: the code pages appear after one tree is read, not
seventy.

What the new strategy changes in the graph, and what it does not:
- The tree extractors' records are valid from the last commit's effective time (open-ended), or, for
  a chosen point, from the point's effective time to the next first-parent commit's.
- The history extractor's records and their per-commit times are unchanged.
- Generations: `2n` for the tree publication at place `n`, `2n + 1` for the publication that ends an
  old tip early; the history producer publishes at `2 * walk length`.

## Out of scope
- The reader's on-request historical snapshot page: the mechanism is built (`fillSnapshot`), the page
  that asks for a date comes later.
- Reading only the new commits in the history extractor (it re-reads `git log`, seconds).
- The server-side move of the fill off the request path (madarch-m38l.4): the driver's public entry
  `fillGraph` and its callbacks keep their names; `onCommit` now fires once, at the last commit, and
  `onPhase` and `onPoint` are new.

## Preserved contracts

- graph-queries/as-of: the store's reads are untouched; an answer at a date still comes from the versions' valid times, and the driver now writes fewer versions for them.
- graph-queries/rebuild: the graph is still derived from git alone and a rebuild gives the same identities for the same history.

## Coverage

- graph-queries/as-of: test
- graph-queries/rebuild: test

## Where it is seen

Kind: internal
Place: `fillGraph` in src/extract/driver, which the wiki's fill calls
Reason: the fill's callers and the pages keep their entry and their names; only how long the fill takes and which commits it parses change, so nothing a person reaches changes beyond the time to the first code page.

1. A person presses the fill on the training repository's wiki and sees the code pages appear after the last commit's code is read, not after seventy commits.

## Blocking questions
None.

## Design and decisions
Decision 0030. The existing driver, extract-code and writer tests that read the structure of commits
between the answer key's snapshots (the rename identity, the merge's dates, the date anomaly) now name
those commits as chosen points; the "fill time per commit" measure reports the last commit and the
points.

## Acceptance evidence
Measured on the SkyPilot pod (2 CPU, `madarch-sky-test`, 2026-10-23):
- training repository (70 first-parent commits): the last commit's code read and published in 17.2 s
  (one tree; before: about 6 minutes for 70); the history over all 70 commits 4.6 s; the answer key's
  hotspot (28), change coupling (6), provider authorship, rename, effective dates and merge hold in the
  graph (`test/extract-driver-suite.ts`);
- 3 000-commit synthetic repository (`test/extract-driver-tip.test.ts`): code 1.7 s, history 50.9 s,
  total 52.7 s;
- a second fill after one new commit: `newCommits` 1, one tree parsed, the tip's file version moves
  (old ends, new opens at the new commit's effective time); 17.9 s, of which 17.5 s is the history
  extractor re-reading the log and re-checking its records (limit below);
- a chosen point costs about one tree (3-20 s on the training repository, growing with the tree).

Review: read-only Codex review found two defects, both fixed with tests: (1) the driver's "commit
read" record ignored which extractors took part, so a fill with a new extractor skipped the commit (now
keyed by the extractor set); (2) a point lost a file's identity across a rename between two points
when the file was gone at the tip (keys are now carried forward through the later renames on both
sides).

Limit: the history extractor reads the whole log and re-checks its records on every fill that moves
the tip; it is seconds per thousand commits, not incremental.

## DONE WHEN
- the training repository's code pages are complete within 90 s of the start, measured on the pod;
- the answer key's history facts (hotspot, change coupling, authorship, renames, effective dates, the
  merge) hold in the graph;
- a synthetic repository of 3 000 commits fills its history in under two minutes;
- a second fill after one new commit reads one commit and the tip snapshot moves;
- the existing driver, extract, knowledge and writer tests stay green.
