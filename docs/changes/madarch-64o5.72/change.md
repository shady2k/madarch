# A product made by madarch init carries its starter plugins' sources and lock, and the packages they import stand in the machine store

Change: madarch-64o5.72
Base: c97952c854b88332398c0d65d0de3f227059e249
Tasks: madarch-64o5.72
Kind: no-behavior

## Intent

`madarch init` wrote every file of the starter plugins, the packages their
sources import included, into the product's repository: 420 files of
`@babel/parser`, `libpg-query` and `@pgsql/types` under
`plugins/db-schema/node_modules` and `plugins/imports/node_modules`, committed by
the product's first commit. A product's git carried third-party library code the
product never chose, and a clean re-initialisation of madarch's own product had
to carry it too (the last of the ten blockers of the wiki-for-engine cutover).

After this change a product made by `madarch init` holds its starter plugins'
own files — the code, `plugin.json`, the contract and `package.json` — and
`madarch/plugins.lock`, which names each plugin's exact version and the hash of
its closure; the packages the closure declares are restored, when a plugin runs,
into the machine store, in a folder the closure's hash names under
`plugin-dependencies/`, and the lock's hash is what holds them: a file of the
restored closure that somebody changed is refused before the plugin process
starts. A plugin folder that carries its own `node_modules` is left alone, so a
product that vendors its libraries keeps them.

## Out of scope

- A product whose repository already carries a plugin's own `node_modules` folder (made by
  an earlier release): it keeps those bytes and runs them, exactly as before.
- Migrating or pruning such a product's git history; the packages it already
  committed stay in that history.
- Where the machine store's folder is named and cleaned: the product's store is
  the one it already keeps its database, traces and snapshots under.
- A package manager for products: a product does not install its plugins'
  packages, madarch restores the ones its own release carries and the lock names.
- Which packages a starter plugin declares: unchanged here.

## Rationale

No written requirement says a product's repository holds its starter plugins'
packages: `product-repository`'s `draft` requirement names the skeleton it
writes and never `plugins/`, and `fill-orchestrator/attempt` holds a plugin to
the closure it declares and the lock names, wherever those bytes stand. So the
420 package files were an unintended consequence of writing the plugin folder
whole, not a promise to a person, and fixing it keeps every written requirement:
what changes is where the same bytes stand when the plugin runs. A promise that
a product's git carries no third-party code, if the owner wants one, is a
requirements change of its own and belongs to whoever holds the spec.

## Preserved contracts

- product-repository/draft: `madarch new`'s skeleton and the starter set's manifest, catalogue and templates are written as before; only the plugin folders lose their `node_modules`.
- product-repository/manifest: the manifest's plugin `closure` list still names every file of the closure, the declared packages included, and the lock's row per plugin is read as before.
- fill-orchestrator/attempt: a plugin whose folder carries its own `node_modules` still runs those bytes, and an import is still resolved against exactly the files the run will carry.

## Coverage

- product-repository/draft: test
- product-repository/manifest: test
- fill-orchestrator/attempt: test

## Where it is seen

Kind: command
Place: the product folder `madarch init` printed, its `madarch/plugins.lock`, and the machine store of the products home
1. Run `madarch init --template everything` in a code repository, then `git ls-files` in the product it printed: the starter plugins' sources and `madarch/plugins.lock` answer, and no path inside the plugins' `node_modules` folder does.
2. Clone that product somewhere else and run `madarch plugin check plugins/db-schema`: the packages stand in the store's `plugin-dependencies/` folder named by the closure's hash, the plugin answers, and the clone's tree holds no `node_modules`.
3. Change a file of the restored closure and run the same command again: it refuses, naming the plugin, its folder, the store folder and both hashes, before any plugin process starts.

## Blocking questions

None.

## Design and decisions

- **The release carries the packages, the product carries the sources.** The
  binary already embeds every file of each plugin folder as its own bytes
  (decision 0035, items 3 and 4), so the packages were written into the product
  only because the plugin folder was written whole. `BundledPlugin` now separates
  `files` (the plugin's own, written by `madarch init`) from `dependencies` (the
  `node_modules` the closure declares), and one hash covers both with the SDK's
  files — the same hash `closureOf` computes, so `madarch/plugins.lock` is
  unchanged in kind and every product records the same value as before.
- **The store folder is named by the closure's hash.** A restoration stands at
  `plugin-dependencies/` of the product's store, in a folder the hash names, and
  is written once, built beside itself
  and moved into place, so a concurrent run either finds the finished copy or
  builds its own beside it; a newer release whose packages changed restores its
  own folder instead of overwriting a copy a run has already verified. Nothing
  is trusted because it stands there: `closureOf` hashes the restored files
  together with the plugin's own and `lockedClosureOf` refuses a mismatch, so a
  copy somebody changed is a refusal, never a quiet overwrite.
- **The plugin's `package.json` goes into the restoration**, beside the
  `node_modules` the packages stand in: it is what declares them, so the closure
  reads the packages the release shipped through the same declaration it reads
  in a vendored folder, and a plugin's own file resolves a bare import from the
  store exactly as it did from its folder's `node_modules`.
- **The products' own packages win.** `closureOf` takes a folder's own
  `node_modules` when it has one, so the file class of madarch-64o5.66 (a product
  that vendors its libraries) is untouched; the store is read only for a folder
  that carries none.
- **Every path that runs a locked plugin goes through one function.**
  `lockedClosureOf` is what a fill's turn (`src/fill/plugin-turns.ts`), a file's
  read through a plugin (`src/plugin/file-reads.ts`) and the plugin host
  (`src/plugin/host.ts`, when no closure was read for it) call, and `madarch
  plugin check` restores into its own scratch folder so a product's folder is
  checked exactly as a fill would run it. The product's store reaches them
  through the wiring a fill already builds (`runFill` passes the run's store,
  `createStagesFill` passes it to the plugin turns), and the file-text role
  passes its own store to the reads it answers.
- **Snapshots copy from where the bytes are.** A closure file carries the file
  its bytes are read from, so a plugin's sandbox snapshot holds the plugin
  folder's files and the store's packages at the paths the plugin resolves — the
  restored folder itself is never bound into the sandbox.

## Acceptance evidence

- `bun run check` exit 0 on the final tree in box `alx1716-d` (tsc --noEmit, the
  architecture check, UI, catalogue, workflows, slow tests, quarantine and test
  conventions; `/work/reports/madarch-64o5.72-check3.log`), and on the tree before
  the last two edits (`-check.log`, `-check2.log`). `node
  .shady2k/checks/check-product.mjs` and the document gate (`--phase feature
  --change madarch-64o5.72`) are clean.
- `test/plugin-dependency-store.test.ts` (new): 3 cases, 20 expectations, 1.72 s
  and 1.64 s in two consecutive single-file runs under
  `scripts/plugin-sandbox-cgroup.sh` (an earlier pair measured 1.70 s and 1.74 s);
  the single-file evidence command recorded 2 838 ms. The cases are the three
  criteria: `git ls-files` of a product `createDraft` made holds the plugin
  sources and the lock and no `node_modules` path (and neither the product's tree
  nor a clone holds such a folder); a fresh clone restores the locked closure
  into an empty machine store and refuses a changed package file, naming the
  store and both hashes, and the file-read guard refuses the same bytes; and a
  confined `db-schema` unit over that clone parses TypeScript and SQL with no
  `node_modules` anywhere in the product.
- The product's whole vertical over the same change:
  `test/madarch-init-e2e.test.ts` — a clean products home, `madarch init`, the
  wiki, the reader's press and the real plugin turns over the product the
  command made — 3 pass, 0 fail, 15.5 s; its fill resolves `db-schema`'s and
  `imports`' packages from the machine store, since the product's repository
  carries none.
- The affected files together: 73 pass, 0 fail across ten files (plugin lock,
  closure dependencies, bundled agent fill, protocol, file-text guard, seeded
  plugins, db-schema path, imports path, turn pattern, dependency store);
  `test/draft-starter-copy.test.ts` 4 pass, 0 fail, 112 s;
  `test/plugin-file-read.test.ts` 2 pass, 0 fail.
- `MADARCH_SKIP_PERF=1 bun run test` in the box: 2 903 pass, 13 fail — 12 of them
  `test/test-database-timing-failure.test.ts` ("a case failure at … leaves no
  case database") and one `test/scheduler-snapshot.test.ts`; both files pass
  alone (14 pass, 7 pass). The same suite on the unmodified base
  (`c97952c85`, a separate worktree) fails 19 cases across shards 2–5, the same
  `test-database-timing-failure.test.ts` 13 among them, so this is the box's
  flakiness, not this change.
- Five shards on this tree: 497+721+750+509+432 pass, 7 fail, all in the
  graph-publication and retry substrate (`MISSING_ENDPOINT`, `unit not
  replaceable`, `required unit … is missing`, `RUN_NOT_WRITABLE`) and each green
  when its file runs alone; the base's own shards fail 19 in the same areas.
- `test/plugin-fill-scenarios.test.ts` failed its two-branch case once ("required
  unit plugin-turns/scenarios:Y/1 is missing") and passed 6/6 on the rerun; the
  unmodified base fails the same case intermittently the same way (1 fail then
  6 pass). `test/plugin-host.test.ts` fails in the cases its own `slow-files.json`
  entry names, with no closure or dependency error among them.
- The real command on a fresh clone: `madarch init --template everything` in a
  scratch repository, then `git ls-files` → 587 tracked files, `madarch/plugins.lock`
  and `plugins/db-schema/{main.ts,package.json}` among them, no `node_modules`
  path; `git clone` of the product holds no `node_modules` folder; `madarch
  plugin check plugins/db-schema` under `scripts/plugin-sandbox-cgroup.sh`
  conforms (introduction, contract, one unit, pause, stop) from the restored
  store.
- Mutation, three throwaway changes restored in the same turn: `files: all` in
  `bundledPlugin.ts` (the old behaviour) is killed by the `git ls-files` case
  (622 `node_modules` paths); `closureOptionsFor` returning no options is killed
  by the restore case; `lockedClosureOf` without its hash comparison is killed by
  the changed-dependency case ("the call was expected to refuse, and it did not").
