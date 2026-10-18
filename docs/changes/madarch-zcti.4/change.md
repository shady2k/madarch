# The released binary starts and stops its own server, and `new --port` is honoured or reported

Change: madarch-zcti.4
Base: 06784e61693c8c5fd6f8d037c9703e5099a40e74
Tasks: madarch-zcti.4
Kind: behavior

## Intent

Since madarch-zcti.1 `madarch new --no-open` returns at once and the products
home's background server serves the wiki, on the port it was started on. The release's
build smoke still waited for a foreground on the port it passed, so it never
saw the product; the "clean install walks" workflow has failed on every push
to main since `ea42ed10` (PR #65), in `bun scripts/build-binary.ts` on
build-linux-fixture, macos-arm64 and windows-x64. The binary also could not
start that server the way an installed program must: it ran the daemon child
as `bun /scripts/madarch.ts …`, a path that exists only while the checkout is
the working folder (measured 2026-10-18 on a machine with no such file: the
child answered `error: Module not found`), so a release installed anywhere
else could not serve at all. And the daemon's liveness check read
the command line kept under `/proc`, which Windows has not, so the released Windows binary
reported that its own server never came up (run 39131966606, job
117688793645).

After this change the compiled binary starts its own server — the executable
run again, which carries the command inside it — the smoke reads the address
`new` printed, asks the product's API for the draft (which opens the graph
store), lists the home, and stops the server it started whether it passed or
failed, so no madarch process outlives a build. A port named to `new`, `init`
or `start` belongs to the home's one server: while no server runs it is the
port the server takes, and while one runs on another the command reuses it and
says plainly — in its lines and in its `--json` facts — that the port it was
given does not apply, naming both ports and the command that moves the server
there, instead of ignoring the flag.

## Out of scope

- The daemon's foreground `madarch serve`, its product routing and its state
  file: they are madarch-zcti.1's and unchanged here.
- Signature and checksum handling of the release, the installers and the
  platform matrix tables of `release-binary`: only the smoke's own run and the
  walks' reading of the address change.
- A second server per products home, or a way to move a running server's port:
  `madarch stop` then `madarch start --port` is the way, as the report says.
- The Windows liveness check still cannot read another process's environment:
  the process's own command line (the daemon's subcommand, this home and this
  port) is what identifies it there, and the token remains the check on the
  platforms that expose an environment. Widening that belongs to a task that
  needs it.

## Changes to requirements

- product-repository/daemon (absent on the target: proposed by the open change
  madarch-zcti, whose text this change extends): the home holds one server, its
  port is named when it starts, and a command that names another port says that
  it does not apply — naming both ports and the way to move the server — rather
  than ignoring it. Complete proposed text in
  `capabilities/product-repository.md`, with the added scenarios
  `new-port-belongs-to-the-server` and `the-port-a-start-names-is-the-one-served`.
- release-binary/installers: the build smoke and this repository's installed
  walks read the address `madarch new` prints, the smoke runs the binary from
  outside the checkout, and each of them stops the server it started before it
  ends; the walk of the published tap formula stays the published release's own
  while that release serves in the foreground. Complete proposed text in
  `capabilities/release-binary.md`, with the added scenario
  `the-smoke-leaves-no-server`.

## Preserved contracts

None.

## Coverage

- product-repository/daemon: test
- release-binary/installers: test

## Blocking questions

None.

## Design and decisions

- **The port belongs to the home's server.** madarch-zcti.1's design is one
  detached server for every product of the home, with its pid, port and token
  in the home's state file. A `new --port` cannot therefore be honoured once
  the server runs on another port without starting a second server for the same
  home, which the design does not have; the decision is that the command
  reports it instead. Refusing would leave the product uncreated (or created
  and unserved) for a wish about a port, while reporting keeps the product
  served at once and names the two commands that move the server. The report is
  a line on standard output and, in `--json`, the facts `requestedPort` (the
  port the caller named; absent when it named none, `0` when it asked for a free
  one) and `portNote` (the same sentence) — a machine consumer is told exactly
  what a person is, and a caller that named nothing particular reads
  `requestedPort: 0` with no note, since no port of its own was passed over.
  The help's own `--port` lines say the same: a home whose server runs names
  its port, and the command reports a port that server does not keep.
- **The daemon child is a script where one stands, and the running program
  otherwise.** A compiled binary carries the command in its own bundle, and the
  path its module URL derives answers no file a checkout holds: the release's
  own words were `error: Module not found "/scripts/madarch.ts"` on Linux and
  macOS and `error: Module not found "B:\scripts\madarch.ts"` on Windows (runs
  39134773495 and 39135836826), while a `bun` that happened to stand in the
  checkout served by accident and an installed binary could not serve at all.
  Three measured facts say "this is a bundle", and any one is enough: the
  embedded files the release carries (an empty list in every source and test
  run), the bundle marker in this module's own URL — `$bunfs` on Linux and macOS
  (`file:///$bunfs/root/<binary>`) and `~BUN` on Windows
  (`B:/~BUN/root/<binary>.exe`, read out of a `--target=bun-windows-x64` build
  on 2026-10-18) — and a derived script path answering no file. `Bun.main` is
  deliberately none of them: in `bun test` it names the test file rather than
  the running module (measured on the pod), and trusting it in CI run
  39137149685's shard started `bun daemon-serve …` inside a test process and the
  daemon never came up — the defect that run caught before it reached main. Two
  rules that were tried and dropped, with the measurement that dropped each:
  the module URL is never asked whether it names a file, because the bundle's
  own filesystem answers its own paths as existing (`existsSync` on the bundle's
  path is true inside the binary), and the marker alone is not trusted either,
  since a path the system cannot resolve is what every platform agrees on. The
  build smoke runs every command from outside the checkout, which is what an
  installed binary sees and what would have caught this.
- **Liveness where the platform allows it.** Linux and macOS let a process read
  another's command line and environment, so the daemon of a record is the
  process whose command line is `daemon-serve` for this home and port and whose
  environment carries the record's token. Windows exposes no other process's
  environment to a plain program: there the command line — the subcommand, this
  home and this port — is the whole check, read through the system's own
  process list (`Get-CimInstance Win32_Process`), and no `ps` is looked for.
- **A child that has not exec'd yet is still starting.** A start records the
  child's pid and waits for the port it must answer on; the liveness check runs
  beside that wait, and the kernel answers the *parent's* argv for a pid whose
  child has not exec'd yet, so the first pass of a start could read the starting
  command's own line and fail the start on it as if the pid belonged to a
  foreign process — main CI run on 46865274, shard 2, failed exactly so, reading
  `bun test test/ --shard=2/5 …` (the test runner's own line) out of the pid
  `madarch new` had just spawned. The read is now judged before it is acted on,
  into four cases: the daemon's own command line for this home and port
  (`daemon`); a command line that is still this process's own, which is the
  fork's copy of it, or one that reads empty — the 0 bytes the exec itself gives
  for the microseconds it takes over the child's address space (measured on the
  pod: 15 of 40 spawns), and the same shape a platform answers for a process its
  list has not reached yet — or none at all (`starting`); another program
  (`foreign`); and a pid no process holds (`ended`). Only `ended` and `foreign`
  end the wait early; `starting` keeps it, so a start never fails on the read of
  a child the kernel has not let exec yet, and a pid that is not this record's
  daemon is still refused at once with what was read. The wait is the one it
  always had (8 s), so nothing is left unchecked: a child that never becomes the
  daemon still fails the start, and the message is built from the reading the
  wait actually saw — ended, another program (naming the line), answered and then
  ended, a daemon's line without this record's token (a claim made only where the
  token was read), this record's daemon never answering, or still starting when
  the wait ran out. The earlier wording could only say "was not the daemon of
  this record" for a daemon that had answered and then died, and could call a
  child that never exec'd the same thing. The check order matters and is
  deliberate: a command line equal to this process's own is `starting` *before*
  the daemon's shape is asked, so a parent that is itself a daemon cannot make
  its child's pre-exec read look like its own daemon. The pause between the
  wait's passes awaits a timer instead of blocking the thread, because only the
  runtime can reap the child the wait is watching: a `pause` loop left the child
  that had ended a zombie for its whole 3 s (its `/proc` state stayed `Z`, so no
  existence check ever answered), where awaiting a timer lets the platform reap
  it in 40 ms and the end be read as one. `madarch status` reads a record another
  process wrote: a daemon that has not exec'd yet reads as its *starter's* own
  command line, which is `foreign` to the status process — `starting` is only
  ever answered for the process that spawned the child — and that is
  indistinguishable from a recycled pid holding something else, so the record is
  deleted only when no process holds it at all. A live pid keeps its record, or a
  status would take a starting server's record away and nothing would then find
  it; `stop` and the next `start` replace what is stale.
- **What the smoke proves.** The port it names is one it found free itself (so
  the assertion `facts.port === the port it passed` says the flag reached the
  server), the command's own `--json` line is the address it then reads, the
  product's API answers the draft's id, the home lists the draft, and the stop
  is proved twice: `madarch status` says `not running` and the process the state
  file recorded is gone. Every step happens with the working folder outside the
  checkout, and the stop runs in a `finally`, so a failure still stops the
  server and still reports a stop that did not take.
- **The walk scripts follow the same shape** (`scripts/clean-install-walk.ts`
  and `scripts/clean-homebrew-walk.sh`, which walk this repository's own
  binary): the address comes from the printed facts, the port each of them names
  is checked against the address the command answered, and the server is
  stopped with `madarch stop` on the same home — in a `finally` in the one, in
  the exit trap of the other — so a walk that fails still stops it. The
  `published-linux-homebrew` job's own walk stays the published release's:
  that release serves `new` in the foreground, and the walk takes this form
  once a release carrying the background server is published.

## Acceptance evidence
- Checks, each command's own exit status: `bun run check` (tsc --noEmit) exit 0 at 1490659a; the same command's exit 0 on every earlier head of this branch. The scripts this change edits stand outside the project's `tsconfig` include, so they were also type-checked with the project's own options (`tsc --ignoreConfig ... scripts/build-binary.ts scripts/clean-install-walk.ts`) exit 0, and `sh -n scripts/clean-homebrew-walk.sh` exit 0.
- Focused tests on the SkyPilot pod, where this machine is not allowed to run the suite: `madarch-sky-test <worktree> test/product-daemon.test.ts test/product-cli.test.ts` exit 0, 110 pass 0 fail, on a worktree whose `wiki/app/dist` was absent (the state a CI shard is in — the pod's staging excludes `dist`); earlier runs of the same tree with `test/product-cli-script.test.ts` and `test/product-serve.test.ts` exit 0 with three failures that were fixed in this branch (two `spawnSync(CLI, …)` tests the pod's lost executable bit fails whatever the branch — see the queue entry — and one assertion the change then corrected).
- The compiled binary itself, on the pod: `bun scripts/build-binary.ts --version 0.0.1 --os linux --arch x64 --out dist` exit 0 ("graph-store smoke ok"), with the smoke running every command from a folder outside the checkout, reading the address `madarch new` printed, asking the product's API for the draft, listing the home, and stopping the daemon it started; the daemon child's command line read from `/proc` was the binary itself.
- The clean install walks workflow, run 39139319609 on 1490659a: every job green — build-linux-fixture, linux-supported, linux-homebrew, macos-arm64, windows-x64 (the platform the liveness and bundle rules exist for; its walk reads "npx madarch stop ended that server") and published-linux-homebrew.
- CI on the exact head 1490659a: run 39139313486 success (checks and test shards 1-5 with the aggregate `test` job), Product documents run 39139313672 success.
- Independent review: a fresh `prime-agent --provider shady2k-gateway --model deepseek-v4.1-flash-auto` session over `git diff origin/main...HEAD`, verdict "fixes needed" with one blocking, one medium and three low findings; every one answered (the record's own bullets say how), its cross-compiled Windows probe supplying the `~BUN` marker spelling, and its note on `src/fill/fsm-core.ts` filed as madarch-ntth.
- Mutation: not run (owner's rule: Stryker once per assembled stage); acceptance therefore escalates per `mutationFallback: escalate`.

## DONE WHEN
`bun scripts/build-binary.ts` proves the compiled binary creates a draft, opens
the graph store and serves it, reading the address `new` prints, and stops the
server it started whether it passed or failed; `new --port` is honoured where
it starts the server and reported where it does not apply, with a test for the
chosen behaviour; and the clean install walks workflow is green on all its jobs.
