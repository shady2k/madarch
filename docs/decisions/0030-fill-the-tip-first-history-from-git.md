# 0030. A fill parses the code of the last commit, reads history from git, and reads earlier code only at chosen points

Status: accepted
Date: 2026-10-23

Amends 0028: what the extract driver reads per commit. 0028's Time, Identity, Publication and
Constraints stand; only the sentence "the driver walks every first-parent commit and runs every
extractor over each tree" is replaced. Builds on 0029 (the graph is an index of what the code and
the Markdown say).

## Context and problem

On 2026-10-23 the owner watched the wiki's fill read the training repository's 70 first-parent
commits one by one (about six minutes) and asked, in his words:

«И я вот смотрю, что madarch читает все коммиты. А если их тысячи? Это точно нужно?»

The cost is the extractors, not git: for every commit the driver listed the tree, read and hashed
every file, and ran the code, operations, contracts and data-model extractors over it (a few
seconds each). Thousands of commits would take hours, and almost none of it is read by anyone: a
reader asks what the code is now, and how often and by whom it changed. Only the history
extractor needs the past, and it reads `git log`, not trees.

The coordinator proposed four points; the owner answered «Да» to them.

## Decision

1. **The current state first.** The tree extractors run over the last commit of the default
   branch's first-parent line only. Service, file, symbol and caller records are published at once
   from that tree, so code pages can appear in about a minute and the agent writer starts after it.
2. **History from git, not from parsing.** The history extractor already reads `git log` over the
   whole branch, with `--name-status -M`, and no tree: churn (hotspots), change coupling, authors,
   renames and every commit's raw and effective times. It runs on every fill over every first-parent
   commit, in seconds, and publishes once.
3. **Earlier code structure only at chosen points.** `fillGraph({ points })` also runs the tree
   extractors over each chosen commit: a release tag, a commit, or a date (the last commit at or
   before it). `fillSnapshot` is the same for one point. There is no interface for it yet; the page
   that asks for a date comes later.
4. **Incremental.** A later fill reads the code of the new last commit only. The commits after the
   last filled one are counted (`newCommits` in the report) and their renames are applied to the
   identities; commits in between are never parsed.

The cost the owner accepted: "how a function looked at commit N" is answered only at the chosen
points, or on request. At any other date the graph says nothing about the code's structure; it
never extrapolates (0028: "The graph records the dates its history covers and does not extrapolate
before them").

### Valid time

- **A snapshot's facts are valid from the snapshot commit's effective time** (0028's rule:
  `max(raw, parent effective + 1 µs)`).
- **The last commit's facts** (the tip) stay open-ended. A later fill whose new last commit is the
  next commit of the line ends everything the new tree does not repeat at the new commit's effective
  time and writes nothing for what it repeats (0028's publication, unchanged).
- **A later fill that skips commits** first ends the old tip's facts at the effective time of the
  commit that followed it, as a publication of its own, and then publishes the new tip valid from its
  own effective time. Between those two instants the graph holds no code structure, rather than the
  old tree stated over commits nobody read. Identities continue: the renames git detects in every
  commit after the old tip are applied to the keys before the new tip is published, so a moved file
  keeps one node.
- **A chosen point's facts** are valid from the point's effective time to the effective time of the
  next first-parent commit: that commit's tree, until the next commit changed it. A point never
  overlaps what its producer already believes in that interval; a fill refuses it, naming the
  version it would overlap. A point that is an old tip is already published and writes nothing.
  Identities continue across points by the same rename rule, followed forward from the point.
- **History facts keep their per-commit times.** Every commit record carries its raw `committedAt`
  and `authoredAt` and its `effectiveAt` as properties; a file's churn, authors and coupling are
  properties and edges of the records the history extractor publishes. Their versions are valid
  from the last commit's effective time (a version cannot start before the file it describes).

### Generations

A tree publication of the commit at place `n` of the first-parent line is generation `2n`; the
publication that ends a tip early is `2n + 1`; the history publication at walk length `n` is `2n`
of its own producer. A generation published with another input digest still refuses the fill (0028:
the history changed under a fixed generation number).

### Reporting

The report keeps `commits` (now the last commit's fill alone) and `totalMs`, and adds `points`,
`newCommits`, `historyCommits` and `phases`. The callbacks keep their names: `onStart` as before,
`onCommit` once, when the last commit's code is published (its `index` is the walk's length);
`onPhase` (`code`, `history`, `points`) and `onPoint` are new.

## Consequences

- A fill of the training repository reads one tree instead of 70; a repository of thousands of
  commits costs one `git log`, one tree and the history publication.
- The history extractor still reads the whole log on every fill (a few seconds for thousands of
  commits); making it read only the new commits would mean aggregating over stored state, and is not
  done here.
- Tests that read the structure at a date between the chosen points (the training repository's
  rename, merge and date-anomaly checks) name those commits as points.

## Review

Read-only review by Codex before landing; its findings and their fixes are in the change record.
