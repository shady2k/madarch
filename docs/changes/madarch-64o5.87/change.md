# One state machine gives a run a final state, and its units final words

Change: madarch-64o5.87
Base: ef989dae1b707459a69421ca1d4bdee54cd6904b
Tasks: madarch-64o5.87
Kind: request

## Rationale

The owner met a fill that ended in 14 seconds but still read as hung: four units stayed `blocked`, the progress line was
empty, «Осталось: пока неизвестно» stayed on the page, and the final state was a small word in the date line. A later
fully successful fill still showed «Осталось примерно 0 с» after the end. The run and its units now have one public
machine, every final run leaves every unit final, and the run page says once, at the top, that the run ended, with its
end time and duration. The same owner walk found that a unit line could end in the machine key `done`; every unit and
group row now uses the reader's words.

A run whose process died was left `running` until a five-minute age fallback. The owner's server restarted three times;
recovery now follows a lease the running process renews, claims that lease under the same lock planning uses, and never
reads process identity from `/proc`.

## Preserved contracts

- product-wiki/fill-state: a run still walks its persisted planning, running, pause, cancel and terminal steps; the
  public phase is the one every reader maps through, and a final run never leaves a unit waiting, blocked or planned.
- product-wiki/run-page: pause and stop remain available while the run is live; a failed or partial run still names its
  cause and the retry action, while a successful or stopped run carries no failure alert.
- product-wiki/internationalization: all new run, unit and status words exist in English and Russian.

## Coverage

- static: `bun run check` — clean (36 known architecture entries, 0 UI violations).
- test: affected fill suites — 247 pass, 0 fail; wiki app — 96 pass, 0 fail.
- mutation: not run, filed per the stage rule.
- review: coordinator review of PR #318 and the owner's successful and failed run screenshots; fresh run-page evidence at
  1440 and 390 CSS pixels.

## Where it is seen

Kind: screen
Place: the run page `/p/run` and the runs list `/p/runs` of a product

1. Finish a successful fill; `/p/run` shows the top badge «Завершён», one end line such as «15 нояб., 02:21 · 60 с», and
   no «Осталось» line or retry action.
2. End a run partially or with a failure; the badge reads «Частично» or «Ошибка», the alert names the cause and offers
   «Повторить заполнение», and every unit row reads a reader word rather than `done` or another machine key.
3. Restart the server after its process has gone; the next start ends the old run from its expired lease, and the run
   page shows that final state with every unit final.
