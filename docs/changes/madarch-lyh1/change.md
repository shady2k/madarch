# A start waits 60 s for its own server's port answer, so a slow machine no longer kills a server that is coming up

Change: madarch-lyh1
Base: ec810f1f4dabec929c88b93e20a94d3eafc0ef50
Tasks: madarch-lyh1
Kind: no-behavior

## Intent

A start of the products-home server waits for its child's listener to answer, and the wait ended after 8 s. On a slow
machine the child is alive, is this record's daemon, and has not opened its port yet: ALX-1624 measured about 7.0 and
7.4 s with the CPU busy, and the red runs of ALX-1530 were past 8 s. The start then read a healthy server as failed,
ended the process and left `madarch init` with exit 1.

The bound is now 60 s. It stays a hang guard: readiness is still read only from the answer the child alone can give, an
HMAC of a fresh nonce with the token the state record holds (madarch-64o5.80), and a child that ended or turned out to
be another program still ends the wait at once, so nothing waits 60 s for a failure that is already visible. No
requirement changes: the server still has to answer before a start reports it, and `test/daemon-ready-timeout.test.ts`
holds a live child that opens its port at 9.5 s as the case the old bound failed.

## Rationale

`no-behavior`. `fill-orchestrator/host` requires the background server the process builds; it says nothing about how
long a start may wait for it, and the 8 s was a constant of the product with no requirement behind it (ALX-1683): no
requirement asked for 8 s, so the number bounded nothing but itself. A loaded
machine was measured opening the port at about 7.4 s (ALX-1624), so 8 s killed exactly the healthy runs the
requirement asks to serve.

## Out of scope

- **`test/init-language.test.ts`.** The slow-start publication of S1 changes it; this change does not touch it.
- **Ready-port proof, child readings and stop.** The failures a start can see early — an ended child, a foreign
  program, a missed token — keep their own reads and messages; only the guard's value and its wording change.
- **Faster daemon startup.** The startup phase timings recorded beside this change answer why a start is slow; making
  it faster is not part of the guard fix.

## Preserved contracts

- fill-orchestrator/host: the background server is still built and owned by the process that serves it; the change only raises how long its start waits for that server's port answer.

## Coverage

- fill-orchestrator/host: static, test

## Where it is seen

Kind: internal
Place: `madarch init`, `madarch start` and `madarch status` on a machine whose server takes longer than 8 s to open its port
Reason: the change adds no screen, route, string or command. It only changes how long an existing start waits for the
  answer of the server it already starts, so the case a person reaches is the same one `madarch init` already
  reports; the regression test and the timing record are its evidence, not a new surface.

1. Run `madarch init ~/idea --home ~/products --template everything --json --no-open --port 0` on a loaded machine.
2. The command reports the running server and its address instead of ending the healthy child at 8 s, and
   `madarch status --home ~/products` names the same process.

## Blocking questions

None.
