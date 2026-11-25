# The delegated scope writes the daemon's real pid where systemd's expansion used to eat it

Change: madarch-4ag1
Base: c8f7dade5071af4e7ea0fc75ea0b785223d1f045
Tasks: madarch-4ag1
Kind: no-behavior

## Intent
A start that puts the daemon in a transient delegated user scope (`systemd-run --user --scope`, when the user manager
delegates cpu, memory and pids) writes the daemon's own pid into a receipt file, and the state file, the command-line
check and `stop` all name that process rather than `systemd-run`. On systemd 262 that receipt held a single `$`: the
argument `echo $$ > "$1"; shift; exec "$@"` was handed to `systemd-run`, which expands the words it is given —
`--expand-environment` is on by default there, `--scope` included — so `$$` arrived at the shell as `$`, the receipt
was not a decimal pid, and the start fell back to the pid of the process it spawned. After this change the words
`systemd-run` is given carry no `$` and no `%` at all: the receipt's path, the daemon's command and its arguments reach
the wrapper as that wrapper's positional parameters, and the wrapper's own two lines live in a file beside the receipt
that `systemd-run` never looks into.

## Out of scope
- `--expand-environment=no`: older systemd (< 254) has no such switch, so the fix carries the words instead of the
  switch, and both systemd 255 and 262 read the same command.
- `src/product/daemon.ts`, its start and ready checks, the state file's shape, and every other caller of
  `delegatedScopeCommand`: the words this function answers are the whole change.
- A run under a real systemd 262 user manager, which needs a host this box does not have; the Team Lead runs the same
  probe there. This box's user manager is systemd 255, and the probe ran under it.

## Rationale
The scope's shell has to learn two things: the receipt's path and the daemon's command line. `sh` reads those from its
positional parameters, and every way of naming a positional parameter in `sh` uses `$` — which systemd 262 rewrites
before the shell ever sees it. The one place `systemd-run` does not rewrite is the body of a file: it expands the words
of an `ExecStart`, never the contents of a script the words name. So the two-line script stands in a file beside the
receipt, written whole (a temporary name, then a rename, so a concurrent start never reads half of one), and the words
handed to `systemd-run` are a path, a receipt path and the daemon's own command. The pid the script writes is `$$` of
the shell that then `exec`s the daemon, so it is the pid of the process that becomes the daemon, on 255 and on 262.

## Changes to requirements
None. The start behaves as its requirements already state; only the receipt it writes stops being mangled.

## Preserved contracts
- product-wiki/serve: the daemon still starts in the same delegated scope and serves at the same address; only the words that write its pid receipt change
- product-wiki/result: a start that cannot be made is still refused and a started one still answers as before, and the receipt names the same process it always started

## Coverage
- product-wiki/serve: test
- product-wiki/result: test

## Where it is seen

Kind: internal
Place: the words `delegatedScopeCommand` answers and the script it leaves beside a start's pid receipt, in a madarch home
Reason: the words a start hands to `systemd-run` and the file it leaves beside the receipt; a person reaches neither, and what they reach — the served wiki and a start's refusal — reads the same.

1. A developer runs `bun run test --only test/sandbox-probe.test.ts` and reads the receipt case: the scoped shell's pid
   is written, the target runs with its arguments whole, and the receipt is that same decimal pid.

## Blocking questions
None.

## Design and decisions
`delegatedScopeCommand` answers `systemd-run --user --scope --quiet --unit <unit> -p Delegate=yes -- /bin/sh <script>
<pidFile> <command> <args…>`. `<script>` is `<pidFile>'s folder>/.madarch-daemon-scope.sh`, holding
`echo "$$" > "$1" || exit 1`, `shift`, `exec "$@"` — the receipt write fails the start rather than letting it carry on
without a pid. Nothing in the answer's own words names `$` or `%`, so systemd 262's expansion finds nothing to rewrite;
the caller's forwarded `command` and `args` are passed through exactly as given, spaces and all. The file is written
before the words are answered, under a temporary name and renamed into place, so a second start in the same home never
reads a partial script, inside the change's own span as every file this module reaches is. A failed write surfaces as a
start error rather than a scope that cannot name its pid.

## Acceptance evidence
Static: `bun run check` on the branch (tsc, architecture, UI, catalog, workflows, quarantine, tests/slow files) —
exit 0; the log is `/work/evidence/ALX-1087-4ag1/chk-check.log`.
Test: `test/sandbox-probe.test.ts` 8 passed, 0 failed, on the branch tip — the receipt case writes the scoped shell's
decimal pid (equal to the target's own `process.pid`, never the caller's) and the target sees its arguments whole
(`a b`, `"quoted"`, `кириллица`, a tab); the expansion case holds the helper's words to no `$` and no `%`; the log is
`/work/evidence/ALX-1087-4ag1/chk-sandbox-probe.log`.
Real user manager: the exact words were run through this box's `systemd-run --user --scope` (systemd 255) with a target
that prints its own pid — exit 0, receipt `8800` decimal, the target printed `8800`, and the caller was `8793`; the
transcript with `systemctl --version` is `/work/evidence/ALX-1087-4ag1/systemd-255-probe.log`. The Team Lead runs the
same probe on a systemd 262 host.
Mutation: not run here, per the task's rule; filed with the stage.
Review: pending; this record is for the review.

## DONE WHEN
The words `delegatedScopeCommand` hands `systemd-run` carry no `$` and no `%` on any systemd, and the receipt a
delegated start writes is a decimal integer equal to the pid of the process that becomes the daemon — on systemd 255,
and on systemd 262 where the old `$$` argument arrived as `$`.
