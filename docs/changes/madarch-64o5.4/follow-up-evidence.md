# Follow-up evidence: original test bounds and sandbox-off runs

Task: madarch-64o5.4
Parent implementation: bac99166fc360aa3eebef9d88936bd4ffd1bd3e6

## Bound correction

The coordinator rejected the two test-bound increases. Both explicit 30-second
bounds are removed, restoring main's unchanged default (10 seconds in this
single-file run). No production code or timeout changed. The earlier evidence
records the superseded run, not permission to raise these bounds.

## Main versus branch timing

Main is the original base 0e27a75f8b7a99dc9d77f9f29f12e953ee669298 in a
separate detached worktree. Both run as user box with the same Bun 1.4.2,
dependencies, git identity, scratch product homes and ready wiki app fixture.
Measurements were serial and alternated between main and branch. Main uses
its original `new`; branch uses the replacement `init` outside Git.
No test bounds were raised for these measurements.

Exact existing tests under their original bounds:

| Test | Main | Branch |
| --- | ---: | ---: |
| JSON retained port facts | 10.203 s, timeout | 10.193 s, timeout |
| Focused help matches parser | 9.783 s, pass | 9.704 s, pass |

A standalone scratch measurement repeated the same commands without a test
runner deadline to measure each span fully (five runs each). It changed no
retained test. Median spans in milliseconds:

| Span | Main | Branch |
| --- | ---: | ---: |
| JSON first creation and daemon start | 4974 | 5437 |
| JSON second creation, daemon reuse | 2438 | 2833 |
| JSON third creation, no requested port | 2372 | 2201 |
| Stop daemon | 331 | 330 |
| JSON total | 10106 | 10917 |
| Help: start --help | 2170 | 2227 |
| Help: start --no-open refusal | 2275 | 2174 |
| Help: serve --help | 2233 | 2145 |
| Help: demo --help | 2341 | 2185 |
| Help total | 8683 | 8616 |

JSON totals ranged 9.602–12.434 s on main and 9.464–14.851 s on branch;
help totals ranged 8.550–13.050 s on main and 8.272–10.081 s on branch.
The branch JSON aggregate median was 0.811 s higher, but this was not a
repeatable creation regression: a direct 12-iteration comparison of main's
createDraft against branch's initLife (including its Git probe) measured
48.4 ms versus 46.2 ms median. The seconds in these tests are process startup
and daemon startup, shared by both versions; the four unchanged help paths
also show this variance. The exact tests reproduce the same JSON timeout on
main. No production optimization or test-bound increase is justified by this
measurement; the pre-existing deadline failure is reported, not hidden.

## Plugin-using tests with sandbox explicitly off

The coordinator explicitly authorized MADARCH_PLUGIN_SANDBOX=off. Both runs
used that value as ordinary user box, under outer timeout 900. This deliberately
runs plugins with the host account's filesystem and network access. It was
not made a source default and no bound was raised.

- Relative --product CLI fill: 0 passed, 1 failed, 105 filtered, 7 assertions;
  case 32.846 s, run 35.84 s. The fill completed; the assertion of empty stderr
  rejected the intentional one-time unconfined warning. No cgroup refusal.
- Two existing serve fill cases: 1 passed, 1 failed, 27 filtered, 1 unhandled
  error, 7 assertions; run 57.26 s. The set-made product case passed in
  23.639 s. The served-product case hit its unchanged 30-second bound at
  30.174 s; its continued poll then reported ConnectionRefused after cleanup.
  No cgroup refusal. These runs are not claimed green.

Full span, exact-test and plugin logs are delivered under
/work/out/madarch-64o5.4-2-*.log. Measurement scripts are delivered alongside
them for reproduction; none is a committed production or test change.
