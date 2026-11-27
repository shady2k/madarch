# A run's own result counts each entity once, however many producers wrote it

Change: madarch-stm0.12
Base: 898838c8755a5341923ecf16e24d022bde4e662f
Tasks: madarch-stm0.12
Kind: no-behavior

## Intent

The compiled starter's first Files fill in Plugins only mode (898838c875) wrote 740 entities, and its run page read
«Создано 1330 сущностей»: the files plugin and the Git plugin each asserted the same 588 files and 2 repositories, so the
page added two producer rows that name one vertex each. The run's title and every per-kind line now count the run's own
entities, each once, and the producer breakdown keeps naming what each producer asserted. For that starter run the title
reads «Создано 740 сущностей» where the producer rows still say 588 files for the files plugin and 588 for Git.

## Out of scope

- What a producer row itself means: a group's line still states what that producer asserted of its kind, which is the
  breakdown a reader opens the run to see, never a share of the run's total.
- Any other count on the page — the run's facts, its units and its token usage — and the runs list, which reads the run's
  own records and is unchanged.
- The storage of a run's result: the counts are still derived from the run's own lineage and creation classification at
  read time, so no record, schema or ownership moves.

## Rationale

A vertex is one entity of the run whichever producers asserted it. `readRunEntityCounts` already reads one row per
producer and kind, because a group's line must state what that producer wrote; those rows overlap by construction — the
files plugin and the Git plugin both write a file — so their sum is a count of assertions, not of entities. The read now
returns both shapes from one statement: the producer rows it returned before, and one row per kind counting the distinct
vertices, taken by grouping the same lineage rows a second time. One statement still reads the run, and its cost is still
the assertions the run's units wrote. The page takes its title from the per-kind rows and leaves each group's line on its
producer's row, so a reader reads one number for what the run wrote and the breakdown that explains it. Every count is
derived at read time from the graph's own lineage, so a run recorded before this change reads the same way as one
recorded after it, and a run that wrote nothing keeps the words it stated.

## Preserved contracts

- product-wiki/pages: the run's page is still one read of the run's durable state, worded for the reader, with no engine trace, machine path or internal id, and a run that wrote nothing still says so with its producer's cause (test).
- fill-orchestrator/publish: a unit's publication is still the run's durable result, and the entities a run's page names are still what its units' own assertions brought into the graph, never a count of publications (test).

## Coverage

- product-wiki/pages: test
- fill-orchestrator/publish: test

## Blocking questions

None.
