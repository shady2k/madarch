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
  *handled* per repository, written before the run is asked for. A repository with
  no record there takes its first read as the baseline, so the server never starts
  a run for work that stood before it looked (the first fill is the person's own),
  and a restarted server neither loses a commit that waited nor asks twice for one
  a run covers.
- **When it may start a run** — only after the wizard was run in this home
  (`readChosenAgent`, `src/product/fill-wizard.ts`): the agent the person chose is
  what a run spends, and a server that invented an agent nobody chose would spend
  their money without their decision. A run is never started over a fill in
  progress: the product's chain of runs refuses it (`startRun`, decision 0027), and
  a refusal the service names `fill-orchestrator/chain-active` (or `…/chain-held`)
  leaves the commit **waiting** rather than dropped, so the update follows the
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
- **`GET /api/fill`** (`src/server/http.ts`) — the orchestrator's own answer comes
  first where the process owns a fill service, and the `.madarch/fill` state file
  answers where it answers none (a product that never filled there). So the update
  the server started by itself is in the fill progress the moment it exists.
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
progress panel while it runs.

## Out of scope

- **Which units an update recomputes.** That is madarch-tzte.26.1's (impact
  propagation over the graph's edges) and madarch-tzte.21.x's (each deterministic
  stage's own incremental plan). This change starts the run and nothing about what
  the run plans.
- **The first fill.** The watcher starts nothing for a commit that stood before its
  first read, and it never starts a product's first run: the wizard's Start is the
  person's own decision to fill.
- **The agent-call cap the wizard sets** (`maxUnits`): see the limitations below.
- **A resume of a paused run from the panel.** A paused run is planned again
  (`resumeRun`) by a caller, and the panel offers pause and stop only; starting the
  next run is the watcher's job after a commit or the person's through the wizard.
- **Watching a repository of a product that is being added while the server runs**
  beyond the next pass: a product that appears in the home is watched from the pass
  that lists it, which is at most one interval later.

## Preserved contracts

- fill-orchestrator/host: test — a service the host wired nothing to still refuses a run with `fill-orchestrator/no-wiring` and opens no database, and a daemon that was asked for no run still opens nothing (`test/fill-orchestrator.test.ts`); this change only gives the daemon a wiring, opened under the same rule.
- fill-orchestrator/plan: unchanged — a run plans its units from the declared stages over the commit its pins name, and inherits the units whose inputs did not move; the watcher's update is such a run and recomputes only the units its commit touched (`test/fill-updates-run.test.ts`).
- fill-orchestrator/cancel: unchanged — a run's pause and stop are its own state machine's, and the panel offers its control only where the run can leave that state.
- product-repository/manifest: unchanged — the watcher reads a product's declared code repositories through the manifest's own reader and never writes it (`test/fill-updates.test.ts`).
- product-wiki/shell: test — the fill progress keeps its place in the reading shell and its label, and now shows the stages the answer holds instead of a list fixed in the app (`wiki/app/src/app.test.ts`).
- product-wiki/live: unchanged — a pause or a stop of the landed fill's run is still taken by its own state file where the process owns no such run, which is what the update's control falls through to (`test/fill-updates-run.test.ts`).
- server/serves-wiki: test — `GET /api/fill` answers under a product's prefix as before, now from the process's own runs where it owns a fill service (`test/fill-updates-run.test.ts`).
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
