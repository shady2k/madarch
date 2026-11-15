# One state machine gives a run a final state, and its units final words

Change: madarch-64o5.87
Base: ef989dae1b707459a69421ca1d4bdee54cd6904b
Tasks: madarch-64o5.87
Kind: no-behavior

## Intent

The owner met a fill that ended in 14 seconds but still read as hung: four units stayed `blocked`, the progress line was
empty, «Осталось: пока неизвестно» stayed on the page, and the final state was a small word in the date line. A later
fully successful fill still showed «Осталось примерно 0 с» after the end. The run and its units now have one public
machine, every final run leaves every unit final, and the run page says once, at the top, that the run ended, with its
end time and duration. The same owner walk found that a unit line could end in the machine key `done`; every unit and
group row now uses the reader's words.

A run whose process died was left `running` until a five-minute age fallback. The owner's server restarted three times;
recovery now follows a lease the running process renews, claims that lease under the same lock planning uses, and never
reads process identity from `/proc`.

## Out of scope

A stage that blocks the event loop longer than the lease bound (madarch-64o5.116); the Logs page and the run's detailed journal (madarch-64o5.88).

## Rationale

One public machine for a run and its units, read by the store, the API and the page alike, so no reader can show a run as live after it ended; a lease the owner renews replaces reading process identity, which failed on Linux tokens set at runtime and on macOS. Checks: `bun run check` clean; fill and plugin suites 614 pass, 0 fail; wiki app 111 pass; mutation not run, filed per the stage rule; Codex review of PR #318 and its re-check; run-page shots at 1440 and 390.

## Preserved contracts
- fill-orchestrator/cancel: pause and stop still revoke authority before a run settles; only the final state words change.
- fill-orchestrator/completion: a run still finishes with what it covered; every unit of a final run is now final too.
- fill-orchestrator/recovery: what an attempt left unpublished is still worked again; recovery now follows the run lease.

## Coverage
- fill-orchestrator/cancel: static, test, mutation, review
- fill-orchestrator/completion: static, test, mutation, review
- fill-orchestrator/recovery: static, test, mutation, review

## Where it is seen

Kind: screen
Place: the run page `/p/run` and the runs list `/p/runs` of a product
Mockup: docs/changes/madarch-64o5.87/failed-partial-1440.png

1. Finish a successful fill; `/p/run` shows the top badge «Завершён», one end line such as «15 нояб., 02:21 · 60 с», and
   no «Осталось» line or retry action.
2. End a run partially or with a failure; the badge reads «Частично» or «Ошибка», the alert names the cause and offers
   «Повторить заполнение», and every unit row reads a reader word rather than `done` or another machine key.
3. Restart the server after its process has gone; the next start ends the old run from its expired lease, and the run
   page shows that final state with every unit final.
