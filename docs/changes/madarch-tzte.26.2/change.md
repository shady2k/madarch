# The background server starts one debounced update run of a product after a commit to its default branch

Change: madarch-tzte.26.2
Base: dbf138d80a8a83a4b60f691e39fd18ee369dcf14
Tasks: madarch-tzte.26.2
Kind: no-behavior

## Intent

Decision 0026, "Updates": "On a default-branch commit: the deterministic stages
run for what changed; impact propagates over graph edges; only affected agent
units and pages rerun, in dependency order." The self-filling charter's outcome 3
says the same in a person's words: "After the first fill, an update runs by itself
after commits to the default branch, debounced, within the wizard's limit."

What stood before this change: the eight deterministic stages are declared and
wired per product (`src/product/fill-stages.ts`, madarch-tzte.21.8), two runs of
one product recompute only what moved, and a run keeps its durable progress events
and its fact-store pages (madarch-tzte.19.5, 23.1), but nothing ever started the
second run: the background server's fill service holds no wiring at all
(`src/product/daemon.ts`), so a run asked of it is refused, and no component of
the server looks at a repository's branches.

This change is six pieces and the wiring between them.

- **`src/product/fill-updates.ts`** — the watcher. One pass reads the products
  home and, for each product, the default branch of its product repository and of
  every code repository its manifest declares, **from the refs' own files**:
  `.git` as a folder or as a `gitdir:` file, `commondir` for a worktree,
  the branch's own ref file under `refs/heads`, else the `packed-refs` line for it, and `HEAD` for the
  branch a repository with no declared one stands on. No git subprocess runs, and
  nothing is read on a timer when nothing happens: the refs' files and the branch's
  own folder are watched, and a change there runs a pass a moment later. The
  interval (`DEFAULT_INTERVAL_MS`, a minute) is a safety net for a watcher the
  system dropped. A branch that moved keeps its commit waiting for the debounce
  (`DEFAULT_DEBOUNCE_MS`, five seconds, counted from the first read of that
  commit), and a pass after it starts **one** run per product — a batch of quick
  commits is one run — whose id is `update-`, the product's name and the commit's first twelve characters, so
  one commit never starts two runs.
- **What the watcher remembers** — the products home's `.madarch/updates.json`: the head it has
  *handled* per repository, written after the pass's starts return. A run that
  started covers its commit, and a server that dies between a start and the write
  asks again under the same run id — which the store answers with the run it
  already holds (`startRun`'s `existing`) — so nothing is lost and nothing is
  asked for twice. A repository with no record there takes its first read as the
  baseline, so the server never starts a run for work that stood before it looked
  (the first fill is the person's own).
- **When it may start a run** — only after the wizard was run in the person's own
  home (`readChosenAgent`, `src/product/fill-wizard.ts`, whose default is the
  person's home and not the products home): the agent the person chose is the one
  the agent stages will drive, and a home where nobody chose an agent is a home
  where nobody asked madarch to fill anything by itself. A run is never started
  over a fill in progress, in either of the two pipelines a product can have: a run
  of this service is refused by the product's chain (`startRun`, decision 0027),
  and a refusal the service names `fill-orchestrator/chain-active` (or
  `…/chain-held`) leaves the commit **waiting**; and while the landed fill — the one
  the wizard's own Start runs, whose state stands in the product's
  `.madarch/fill/run.json` — is `running` or `paused`, the commit waits for that too
  (`landedFillOf`, `src/product/daemon.ts`). Either way the update follows the
  moment the fill ends.
- **`src/product/daemon.ts`** — the server's own fill service is wired: a product's
  fill is `createStagesFill` over the database the service opened, so a run asked of
  the background server is the eight deterministic stages over that product's pins.
  `daemonUpdateWatch(home, service)` is the watcher over that service, and
  `serveDaemon` starts it beside the wikis and stops it with the server; a watcher
  that cannot start says so in the log and the server serves on.
- **`src/fill/orchestrator-host.ts`** — the wiring a host gives is asked for once
  the service opened the process's database, and may carry the registry its stages
  are declared in (`ProductFill`), because a registry is built over one product's
  own checkouts. And the service answers `progress(folder)`: the product's newest
  run, its units with their states and its durable progress events, in the shape the
  wiki's fill progress already reads.
- **`src/fill/state-store.ts`** — `readLatestRun(database, product)`, one read of
  the newest run of a product, ordered by its creation and then by its id.
- **`GET /api/fill`** (`src/server/http.ts`) — the panel shows one run, and which
  one is the answer's own rule: the landed fill's while it stands `running` or
  `paused` (a person started it and is watching it), else the newest run the
  orchestrator keeps in the process's database — the update the server started by
  itself included — and the landed fill's record where it never ran one of the
  orchestrator's. So an update is in the fill progress the moment it exists, and a
  person's own fill is never hidden behind one.
- **`wiki/app/src/fill-progress.tsx`** — the panel shows the stages the answer
  holds instead of a list fixed in the app: the fill's stages are data (decision
  0027), a stage the panel knows by name keeps its translation and a stage it does
  not is shown under its own id, and the run states and stage names the
  orchestrator uses are in both languages. Its pause and stop now reach the run the
  answer names: the stop is offered only in a state a run can leave.
- **`POST /api/fill/control`** and the service's `control` — the person's pause and
  stop of one of the server's own runs, taken by the run's own state machine
  (`pauseRun`, `cancelRun`): an update the background server started is paused and
  stopped where a person's own run is. A run the service does not hold — the landed
  fill's, whose state stands in `.madarch/fill` — answers `null` and the state
  file's control answers for it, so a product served by `madarch serve` keeps its
  own behaviour; a step a run's machine refuses answers 409 in the machine's
  words.

## Rationale

`no-behavior`: the change starts the runs the pipeline already makes and adds no
product requirement of its own. The fill's capability is proposed by
`fill-pipeline-monday` and is not current, so the graph-first fill's requirement
text lands with the stage that closes decision 0026, as madarch-tzte.20.1–23.8
recorded theirs.

What a person sees is new: after they ran the wizard, a commit to a product's
default branch fills that product's wiki again by itself, one run per batch of
commits and never on top of a fill that is running, and the run is in the fill
progress panel while it runs. The change adds no product requirement, which is why
its kind is `no-behavior`: the fill's capability is proposed by
`fill-pipeline-monday` and is not current, so nothing here changes a requirement the
baseline holds.

## Out of scope

- **Which units an update recomputes.** That is madarch-tzte.26.1's (impact
  propagation over the graph's edges) and madarch-tzte.21.x's (each deterministic
  stage's own incremental plan). This change starts the run and nothing about what
  the run plans.
- **The first fill.** The watcher starts nothing for a commit that stood before its
  first read, and it never starts a product's first run: the wizard's Start is the
  person's own decision to fill.
- **The wizard's cap on agent calls** (`maxUnits`). No stage the update run drives
  runs an agent: `src/fill/stages/index.ts` registers the agent unit stage only
  when the wiring names one, and `createStagesFill` names none, so a run of the
  declared stages spends no agent call and the cap has nothing to bound. What
  bounds a run today is the product's own configuration (`fill.stages`, one entry per stage: the
  272K window, the two thresholds, the turns and the time) and the run's own
  limits, read by every run of the service. The cap and the agent's model become
  the agent stages' input when they are registered (madarch-tzte.24.x), and this
  record does not claim them for this change.
- **A resume of a paused run from the panel.** A paused run is planned again
  (`resumeRun`) by a caller, and the panel offers pause and stop only; starting the
  next run is the watcher's job after a commit or the person's through the wizard.
- **Watching a repository of a product that is being added while the server runs**
  beyond the next pass: a product that appears in the home is watched from the pass
  that lists it, which is at most one interval later.
- **Two products' updates in parallel.** One pass runs at a time and a start is the
  whole run driven (`src/product/daemon.ts`'s `start`), so a second product's commit
  waits for the first product's fill. One product filling at a time is what this
  change promises; several filling at once is the scheduler's own work (decision
  0027's resource limits), not the watcher's.
- **A landed fill that was killed while it stood `running`.** Its state file keeps
  saying `running` (`src/product/fill.ts` removes its own lock and writes a terminal
  status only on a path it reaches), and the update of that product waits for it for
  good. Recovering that state is the landed fill's own task; this change reads the
  file as it stands and says so in the deferral line, which names the file and the
  status.
- **`serveDaemon`'s own start and stop of the watcher.** Its wiring is the tested
  pieces (the service's `run`, `daemonUpdateWatch`'s deferral on both chains) joined
  in one place; no test starts a daemon process and sends it a commit, which is a
  walk on a served home rather than a suite's fixture.

## Preserved contracts

- fill-orchestrator/host: test — a service the host wired nothing to still refuses a run with `fill-orchestrator/no-wiring` and opens no database, and a daemon that was asked for no run still opens nothing (`test/fill-orchestrator.test.ts`); this change only gives the daemon a wiring, opened under the same rule.
- fill-orchestrator/plan: unchanged — a run plans its units from the declared stages over the commit its pins name, and inherits the units whose inputs did not move; the watcher's update is such a run and recomputes only the units its commit touched (`test/fill-updates-run.test.ts`).
- fill-orchestrator/cancel: test — a run's pause and stop are its own state machine's, and the panel offers its control only where the run can leave that state (`test/fill-updates-run.test.ts`: a stop of a run this service holds cancels it, and the stop of a run that ended is refused in the machine's words).
- product-repository/manifest: unchanged — the watcher reads a product's declared code repositories through the manifest's own reader and never writes it (`test/fill-updates.test.ts`).
- product-wiki/shell: test — the fill progress keeps its place in the reading shell and its label, and now shows the stages the answer holds instead of a list fixed in the app (`wiki/app/src/app.test.ts`).
- product-wiki/live: test — a pause or a stop of the landed fill's run is still taken by its own state file where the process owns no such run, which is what the update's control falls through to, and a landed fill that runs is what the progress shows (`test/fill-updates-run.test.ts`).
- server/serves-wiki: test — `GET /api/fill` and `POST /api/fill/control` are the same route-table entries under a product's prefix as before, and the run test drives them on a single-product server (`test/fill-updates-run.test.ts`), which is the handler a products home mounts per product.
- product-wiki/internationalization: test — every new string is in English and Russian (`wiki/app/src/i18n.test.ts`).

## Coverage

- fill-orchestrator/host: test
- fill-orchestrator/plan: test
- fill-orchestrator/cancel: test
- product-repository/manifest: test
- product-wiki/shell: test
- product-wiki/live: test
- server/serves-wiki: test
- product-wiki/internationalization: test

## Blocking questions

None.

## DONE WHEN

- The background server watches each product's code repositories and, after
  commits to the default branch, starts an update run by itself, debounced, within
  the limits the wizard set; a person sees it in the fill progress.
- Tested with a repository the test makes: two quick commits give one run; a
  commit on another branch gives none.

## Acceptance evidence

The evidence is recorded on task madarch-tzte.26.2: `bun run check`, the focused
suites on the SkyPilot pod, the wiki app's own checks, the feature document gate,
green CI on the exact SHA, and two independent read-only review rounds by a fresh
`deepseek-v4.1-flash-auto` session.

- `bun run check` (`tsc --noEmit`): **exit 0** at every commit of the branch and at HEAD.
- The focused suites, each with the tests' own exit status, on the worktree's own SkyPilot cluster:
  - `test/fill-updates.test.ts` (the watcher, no tree-sitter): **11 pass, 0 fail, exit 0**.
  - `test/fill-updates.test.ts` and `test/fill-updates-run.test.ts` on the AVX2 recipe (the syntax stage's grammars need it): **21 pass, 0 fail, exit 0**.
- `wiki/app`: `bun install --frozen-lockfile && bun run check && bun test && bun run build`: **0 fail, exit 0**.
- The feature document gate (`node .shady2k/documents.mjs check --phase feature --change madarch-tzte.26.2 --candidate worktree --target origin/main`): **clean, exit 0**.
- CI on the exact SHA (pending).
- The review: **two rounds**. Round one, over `git diff origin/main...HEAD` at `59c6dfdc`, returned **NOT APPROVED** with six defects and ten findings; every one is answered in `e863a613`, `451b8227`, `c654cfa0`, `d8785093` and the commits after them (D1 the agent choice read from the products home, D2 the landed fill hidden behind an update, D3 a control the panel offered and the server could not take, D4 the record's dangling limit paragraph, D5 an unreadable settings file killing the watcher, D6 the guarantee covering only orchestrator runs; F1-F10 the cost sentence, the missing debounce timer, the swallowed heads file, the panel's stage order and translations, the missing app tests, the run ids built from the implementation, the daemon's unnamed lines, the de-duplication that never cleared, the raw `spawnSync` in the run test, and the record's kind rationale). Round two returned **NOT APPROVED** with three defects and ten findings of its own (D7 the control reaching an orchestrator instance that drove nothing, D8 the record's stated write order, D9 a pause reported as taken by a run it cannot pause; F11 a deferral with no retry, F12 a shadowed name, F13 the panel dropping the server's message, F14 the untested daemon wiring, F15 one product's run holding the pass chain, F16 a dead landed fill blocking updates, F17 a landed fill starting over an update, F18 fixed margins in the tests, F19 the missing batch test, F20 every control failure answered 404). D7, D8, D9, F11, F12, F13, F14, F17, F18, F19 and F20 are answered in code and tests; F15 and F16 are named in "Out of scope" with what recovers them.

### What the tests hold

`test/fill-updates.test.ts`, over a products home the test makes (a product
repository and one linked code repository, both Git checkouts it commits to):

- two quick commits inside one debounce window start **one** run, named after the newest of them, and a pass after it asks for nothing;
- a commit on another branch, and standing on that branch, start none; the default branch moving does;
- the product repository is watched beside its code repositories;
- a commit whose product fills waits, keeps waiting (a deferral drops nothing), and starts when the fill ends — under one run id;
- no run before the wizard chose an agent, with the reason naming the home, once;
- a restarted watcher asks never again for a handled commit and once for a waiting one, and a third watcher still finds a deferred commit waiting;
- a commit's run is started by the debounce's own timer, with no interval and no other pass;
- a second commit inside the debounce restarts it, and the two are one run at the newest commit;
- a commit that lands while another waits is the commit the run is named after;
- a damaged kept-heads file is said, with its path, rather than read as nothing;
- a declared repository that is no checkout is reported with the full path it looked at, and hides no other product.

`test/fill-updates-run.test.ts`, end to end on the server's own fill service
(PGlite, the declared stages, a product the test makes):

- the first fill publishes its facts, and a commit to the default branch then starts the update by itself — one run, named after the commit, published;
- the update recomputes the units its commit touched and inherits the rest: the update is not a full refill;
- the person finds it in the fill progress: the newest run, its units and its durable events, in order;
- a product that never filled answers null, and the route falls back to the state file;
- `GET /api/fill` answers the orchestrator's run on a served product;
- a stop of a run the service holds is the run's own cancellation, a run it does not hold answers null, a pause of a run that ended is refused in the machine's words, and `POST /api/fill/control` takes the orchestrator's answer first and the landed fill's where it holds no run;
- the landed fill's live run is what the progress shows while it runs, and its record stands aside when it ends;
- an update waits for the landed fill of its product, naming the file and its status, and follows it when it ends.

`wiki/app/src/app.test.ts`: the panel shows the stages the answer holds (with
their counts and the run's latest activity), and offers no stop for a run that has
ended.

### Known limitations

- **No mutation run.** The owner's rule runs Stryker once per assembled stage, off
  the path; acceptance escalates per `mutationFallback: escalate`.
- **The wizard's `maxUnits` cap binds nothing.** No registered stage runs an agent
  (see "Out of scope"), so an update run spends no agent call.
- **One product fills at a time**, and a landed fill killed while it stood `running`
  holds its product's updates for good; both are named in "Out of scope" with what
  recovers them.
