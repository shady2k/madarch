# Every test run in its own scratch home and temporary folder

Change: madarch-1xq
Base: 82d5edbb1e716df722497d0ccc1ef5a2724448ed
Tasks: madarch-1xq
Kind: no-behavior

## Intent

The suites left the machine's own temporary folder and home behind them. On
2026-09-30 about 87 000 `madarch-*` folders stood in the system temporary
folder (63 490 of them `madarch-model-check-*`); on 2026-10-18 there were
14 454 of them, 71 GB, while the shared disk reached 98% and an overnight
worker wave stopped. A run of `madarch new` with no scratch home of its own
left 377 drafts in the owner's real `~/madarch/products`. A plain `rm -rf`
could not remove several hundred of the leftovers: tests make folders they
created unwritable and never restore them (`docs/hypotheses` and
`docs/repositories/library/stories`, `docs/private`, `dark-draft`).

Cleanliness that depends on each test remembering to redirect its own paths
fails again, so the run as a whole is isolated now. A preload declared in
`bunfig.toml` (the owner's choice, 2026-10-09) makes one scratch folder per
`bun test` run before any test file loads, points `HOME`, `MADARCH_HOME`,
`TMPDIR` and `MADARCH_WIKI_CACHE` inside it — every path madarch derives from
the account's home or the system temporary folder — and removes it when the
run ends, pass or fail. A file a test leaves behind, a folder it locked, and a
child it spawned all die with the run. The wiki app's own `bun test` is covered
the same way.

## Rationale

What a person or a command sees does not change: every assertion of every test
stays as it was, the wiki is built with the same pinned LikeC4, and the
wizard's settings file sits in the same place under the user's home. What
changes is where a run writes — the run's scratch folder instead of the
machine's own home and temporary folder — and, in a few places, that the write
survives a run that ends badly. Two source files move with it, neither of them
a behaviour a reader or a caller can see:

- the fill wizard's settings file reads `HOME` instead of `os.homedir()`, which
  is the same path for a person (the environment's home is what `homedir()`
  reports when a process starts) and is the only one a test run can redirect;
  without it the wizard tests deleted and rewrote the owner's real file, and
  two runs on one machine fought over it, so this is the path
  "any other home-derived path madarch reads" the task names;
- the pinned `likec4` a wiki build generates its view bundle with gains the
  bound the other tool calls already carry, so a hung generator cannot hold a
  build, a server rebuild or a test run open, or outlive it by more than the
  bound (`src/wiki/build.ts`). The generated bundle is unchanged.

The preserved references below are the capabilities whose code or tests this
change edits: the stage index's unreadable-folder cases, the page walk's
unreadable `docs/` and `docs/private` cases, the draft's cleanup that reports a
folder it could not remove, the list cases whose products home the shared guard
judges, and the wiki's two engines and their LikeC4 diagrams.

## Out of scope

- Runs started from a folder other than the package that holds `bunfig.toml`
  (Bun reads no `bunfig.toml` above the working directory: measured on 1.4.2).
- Changing what any test asserts. The tests that remove write permission now
  restore it in a `finally`, and nothing else about them moves.
- Keeping the wiki's content-keyed caches between runs: the run gets its own.
- A container, which the owner considered and set aside (tests spawn git, bun
  and Chromium, and CI would differ from local runs).
- The `~/madarch/products` tripwire and the home guard the product tests
  already carry: they stay as the backstop for what no redirection can see.
- `bun test --watch`: Bun offers no way to tell a watch run from a finished one
  (measured on 1.4.2: no flag in `process.argv`, no variable in the
  environment), so the first pass removes the scratch and a later pass writes
  into a folder that is gone, naming it.
- The package manager's own download cache: a suite that installs the wiki
  engine's template shares the person's `~/.bun` cache instead of downloading
  it again on every run (measured: 1.6 s with the cache, 10.4 s without, and
  two tests crossed their 5-second deadline). It is the tool's cache, not a
  path madarch derives, and the leftovers check does not watch it.

## Changes to requirements

None. This changes where a suite writes, not what the product does or what any
test checks.

## Preserved contracts

- product-wiki/stages: an unreadable kind folder and an unreadable repository subtree are still problems naming the folder, never a silently empty stage; only the permission the test removed is restored in a `finally` now.
- product-wiki/pages: an unreadable `docs/private` and an unreadable `docs/` are still refusals naming the folder, never a smaller wiki; both folders are made readable again whatever the read did.
- product-repository/draft: a draft whose framing commit fails is still reported with the folder it could not remove; the stub's locked folders are unlocked in a `finally`, and the home guard accepts the run's own scratch home as a scratch home.
- product-repository/list: a products home the run computes is still judged before the command reads it; the guard now also accepts the run's scratch root, which is where the preload puts `MADARCH_HOME`.
- wiki/diagrams: each page still carries the LikeC4 web component generated from the same workspace by the same pinned likec4, byte for byte; only a hung generator is now killed at the bound the other tool calls carry.
- wiki/engine: the two engines still build the same sites from the same documents; the bound touches only how long one step may take.

## Coverage

- product-wiki/stages: test
- product-wiki/pages: test
- product-repository/draft: test
- product-repository/list: test
- wiki/diagrams: test
- wiki/engine: test

## Blocking questions

None.

## Design and decisions

- `bunfig.toml` declares `[test] preload = ["./test/run-scratch.ts"]`. The
  preload makes `<system temp>/madarch-test-run-XXXXXX` with `home/`,
  `madarch/`, `tmp/` (and `wiki-cache/` created private on first use) and
  points `HOME`, `MADARCH_HOME`, `TMPDIR` and `MADARCH_WIKI_CACHE` at them, so
  `productsHome()` and `wikiCacheRoot()` — the two paths madarch derives from a
  home — resolve inside the scratch without a test naming anything.
- Removal is by the preload, not by the tests. Bun's test runner has no
  end-of-run hook and `process.on('exit')` alone never fires at the end of a
  `bun test` (measured on 1.4.2), so the preload's own `afterAll` is the end of
  the run; `exit`, `beforeExit`, `SIGINT` and `SIGTERM` cover a test that exits
  the process and a run stopped by a signal. Removal walks the tree making each
  folder writable again and removes a link without following it, so a folder a
  test left unwritable cannot stop it.
- A run that crashes never removes its own folder. The next run sweeps folders
  named `madarch-test-run-*` whose `owner.json` names a process that is gone; a
  folder that names no readable identity is swept only when it is six hours old,
  so a live run's folder is never taken — its own modification time does not
  move while it writes below it, and a run may last hours.
- The whole-run check (`.shady2k/run-scratch-check.mjs` with its test) is what
  CI runs around the shards and the checks: a snapshot of the home and the
  temporary folder before, the same after, and every entry that appeared or
  disappeared named with its full path. The package manager's caches, `.cache`
  and the three home folders whose contents it watches under their own labels
  are not reported by name alone.
- Measured limit: `os.homedir()` is resolved once when a process starts, so a
  preload cannot move it inside the run's own process (a child started with the
  scratch `HOME` resolves it there). Every path madarch derives from a home
  therefore reads the environment first: `productsHome()` takes
  `MADARCH_HOME`, `wikiCacheRoot()` takes `MADARCH_WIKI_CACHE`, and the fill
  wizard's settings file takes `HOME` — the last one changed here, because with
  its old `homedir()` default the wizard tests deleted and rewrote the owner's
  real `~/.config/madarch/fill-agent.json`, and two runs on one machine fought
  over it. Puppeteer's downloaded browser is read from the account's cache
  through `PUPPETEER_CACHE_DIR`, so the isolation does not take it away.
- Two test-side details the run's home exposed: the wiki build test compares the
  cache roots a fallback would write into (the account's, and the one the run's
  own home names), and the LikeC4 scratch test compares the machine's real
  temporary folder, which the preload records in `MADARCH_TEST_REAL_TMPDIR`.
- A child that a build test killed took its own children with it now: the child
  is started detached, and a child that was killed rather than finished is
  killed with its process group (measured on 1.4.2: `spawnSync` returns the pid
  and honours `detached` through a typed spread even though its option type
  omits it, and the group's members die with it). The pinned `likec4` a build
  generates with is bounded in `src/wiki/build.ts` besides, so a hung generator
  cannot hold a build or outlive it by more than the bound.
- The wiki app keeps its own `bunfig.toml` whose preload re-exports the engine's
  file: the app is a separate package with its own lockfile but runs inside this
  checkout, and one implementation cannot drift from itself. Its proof test
  stands in `wiki/app/src/`, not under a `test/` folder: `bun test test/` at the
  root treats its argument as a filter over every path holding `test/`, so a
  test file there would be collected by the root suite and by a shard, and the
  shard check counts only `test/` in git (measured: the manifest gained
  `wiki/app/test/run-scratch.test.ts`, which the check refuses).
- `test/scratch-home.ts` now accepts the run's scratch root as a scratch home
  besides the system temporary folder, because `MADARCH_HOME` points at
  `<scratch>/madarch` while `TMPDIR` points at `<scratch>/tmp`.

## Acceptance evidence

Recorded with the task after local checks and independent review.

Independent review of the first commit (`b47f1ee7`) by a fresh
`prime-agent --provider shady2k-gateway --model deepseek-v4.1-flash-auto`
session over `git diff origin/main...HEAD`, five findings, each fixed:

1. blocker — the app's proof test under `wiki/app/test/` was collected by the
   root `bun test test/` (Bun filters paths, it does not walk a tree), which the
   shard check refuses as an unknown test file; moved to `wiki/app/src/`.
2. major — the fill wizard's settings file still resolved through `homedir()`,
   so the wizard tests deleted and rewrote the owner's real file; its default
   now reads `HOME`, with a test that fails on the old default.
3. major — the "machine cache root untouched" test compared the run's own cache
   with itself; it compares the account's root and the run's home root again.
4. minor — the sweep took an old folder of a live run; a folder that names its
   process is now judged by that process alone, with a test for it.
5. minor — the LikeC4 scratch test read the run's temporary folder instead of
   the machine's; the machine-wide promise moved to the CI check, where it can
   fail, and the test keeps the positive half.

A second round over those fixes found seven more, each fixed:

1. major — the group kill fired for every *finished* child too (Bun reports
   `signal: null`, never `undefined`), so a pid reused a moment later could be
   killed; only a child a signal ended is signalled now, and a test proves a
   finished child's group is left alone. This is what made the whole-file run
   fail on the SkyPilot pod (26 of 44): there, pids are reused fast enough that
   the stray kill hit the next build's own processes.
2. minor — the server's LikeC4 generation (`src/product-wiki/likec4-webcomponent.ts`)
   was still unbounded; it takes the same bound.
3. minor — a timed-out generator was reported with an empty message; the
   failure now names the signal and the bound.
4. minor — the new real-temp assertion could not fail on the regression it
   guarded and could fail on leftovers the run did not make; it is gone, with
   the machine-wide check named in its place.
5. minor — the preload's own comment still claimed a home path was left
   unredirected; it says what is now true.
6. minor — the sweep trusted any number as a pid, so a file naming `0` or `1`
   kept a folder for ever; a pid below 2 is no identity, and such a folder falls
   to the age rule like one with no file.
7. minor — the comments above the wiki test's spawn helper were stacked out of
   order; each sits above what it documents.

## DONE WHEN

After a `bun test` run — a focused file, a shard or the full suite — the system
temporary folder holds no new `madarch-*` entry and the owner's home holds no
new entry; the run's own scratch folder is gone, pass or fail, even when a test
left a folder it made unwritable; a committed test proves the preload is active
(`HOME` and `MADARCH_HOME` point inside the run's scratch folder) and that a
child run removes its scratch when it passes, when it fails and when it leaves a
folder locked; the same holds for the wiki app's own `bun test`.
