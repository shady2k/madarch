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
- release-binary/installers: the build smoke and installed walks read the
  address `madarch new` prints, the smoke runs the binary from outside the
  checkout, and each of them stops the server it started before it ends.
  Complete proposed text in `capabilities/release-binary.md`, with the added
  scenario `the-smoke-leaves-no-server`.

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
  port the caller named, absent when it named none) and `portNote` (the same
  sentence) — a machine consumer is told exactly what a person is.
- **A command that names no port is told nothing.** The default (4180) is not
  a wish: `new` with no `--port`, or `--port 0`, gets no note, and `requestedPort`
  stays out of its facts.
- **The daemon child is the running program.** A compiled binary's
  `import.meta.url` is the bundle's own virtual path (`/$bunfs/root/` and the
  binary's name, measured), so the path it derived named no file on disk and the child failed
  wherever the working folder was not the checkout; `Bun.main` tells the two
  apart (`/$bunfs/root/…` in a binary, a real path in a checkout), and a binary
  starts its own executable with `daemon-serve` instead. The build smoke now
  runs every command from outside the checkout, which is what an installed
  binary sees and what would have caught this.
- **Liveness where the platform allows it.** Linux and macOS let a process read
  another's command line and environment, so the daemon of a record is the
  process whose command line is `daemon-serve` for this home and port and whose
  environment carries the record's token. Windows exposes no other process's
  environment to a plain program: there the command line — the subcommand, this
  home and this port — is the whole check, read through the system's own
  process list (`Get-CimInstance Win32_Process`), and no `ps` is looked for.
- **What the smoke proves.** The port it names is one it found free itself (so
  the assertion `facts.port === the port it passed` says the flag reached the
  server), the command's own `--json` line is the address it then reads, the
  product's API answers the draft's id, the home lists the draft, and the stop
  is proved twice: `madarch status` says `not running` and the process the state
  file recorded is gone. Every step happens with the working folder outside the
  checkout, and the stop runs in a `finally`, so a failure still stops the
  server and still reports a stop that did not take.
- **The walk scripts follow the same shape** (`scripts/clean-install-walk.ts`,
  `scripts/clean-homebrew-walk.sh`, the `published-linux-homebrew` job's own
  walk): the address comes from the printed facts, the server is stopped with
  `madarch stop` on the same home before the foreground `serve` step, and the
  port each of them names is checked against the address the command answered.

## Acceptance evidence

Recorded on madarch-zcti.4 as the checks pass; the task's own evidence section
below holds what was run and what it answered.

## DONE WHEN
`bun scripts/build-binary.ts` proves the compiled binary creates a draft, opens
the graph store and serves it, reading the address `new` prints, and stops the
server it started whether it passed or failed; `new --port` is honoured where
it starts the server and reported where it does not apply, with a test for the
chosen behaviour; and the clean install walks workflow is green on all its jobs.
