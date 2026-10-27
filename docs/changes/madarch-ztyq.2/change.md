# The writer's agent asks the graph instead of reading files, is handed its subgraph, and its journal counts what a call did

Change: madarch-ztyq.2
Base: 5313627c026bbe3df903ed7f116ffc02fdfd5159
Tasks: madarch-ztyq.2
Kind: behavior

## Intent
The owner's walk of 0.2.4 and the coordinator's walk of the pages found the writer's agent navigating the graph like a file system: the payments domain unit made 35 calls, 21 of them `read_file` of whole files, 12 `find_nodes` by path text, no `get_node` and no `neighbors`, and it paraphrased code because it had no way to ask for one function. The owner asked «Почему мы не даем агенту возможность получить сразу нужную функцию?» and «может быть ему какого-нибудь инструмента не хватает». This change gives a unit tools that answer its questions — a symbol by name with its code, callers and callees; an entity's context in one call; a flow from a route to its tables and events; document sections by meaning; the pages and the questions already written — hands it the subgraph it works in before it asks anything, moves the shared prompt's unit-specific retry instruction into the unit that needs it, and makes the journal count what a call read, resolved and produced rather than how often it was called.

## Rationale
The change adds externally visible behavior to the knowledge writer's agent stage, so it is a behavior change. No capability describes that stage yet: the capability `agent-stage` is new, and the complete proposed text is in `capabilities/agent-stage.md`. The baseline is `5313627c026bbe3df903ed7f116ffc02fdfd5159`, the commit the branch is cut from.

## Out of scope
- A real agent run and the walk of a page it writes: the tools, the prepared context and the counters are proven with the unit's own tools over a stub of the pinned snapshot reader, and the recorded real-agent journal is the acceptance walk of the stage.
- The writer's page format and its checks (`write_page`, grounds, links), which are the format's own capability.
- The writer as a graph of units, documents read by meaning, validation and Liquid templates: decision 0032's sections 1, 3, 4 and 8 are later tasks of the same stage.
- The wiki's journal page: the counters are served in the journal's API but not drawn.
- `madarch mcp`, which serves the same answers over a repository.

## Changes to requirements
- agent-stage/graph-tools (new): seven tools answer a unit's questions over the pinned graph, each answer naming its repository, revision, evidence and cuts, and a flow reports depth and order and never a sequence. Scenarios: `symbol-by-name`, `symbol-candidates`, `flow-is-not-a-sequence`, `sections-by-intent`, `answer-names-its-basis`.
- agent-stage/prepared-context (new): a product unit and a domain unit are handed the subgraph they work in before they ask anything, in code point order and with the key to continue from where it was cut. Scenarios: `subgraph-in-the-prompt`, `subgraph-says-where-it-cut`.
- agent-stage/unit-prompts (new): the shared prompt holds no unit's own instructions, and the failure comparison of neighbouring operations is told to the domain unit. Scenarios: `retry-instruction-is-the-domain-units`.
- agent-stage/journal-counters (new): a journal record counts the source bytes served and served again, the evidence inspected, the joins unresolved and what the unit produced, and a page's journal adds up its run. Scenarios: `repeated-source-bytes`, `produced-output`, `journal-totals`.

Complete proposed capability text: `capabilities/agent-stage.md`. It is the whole capability, not a hand-written delta, and no capability file of `docs/system/capabilities/` is changed by this record.

## Preserved contracts
None.

## Coverage
- agent-stage/graph-tools: test
- agent-stage/prepared-context: test
- agent-stage/unit-prompts: test
- agent-stage/journal-counters: test

## Where it is seen

Kind: log
Place: the journal of a page the writer's agent wrote, under the product's machine-local store

1. A fill of a product with one code repository runs its writer; each unit writes one page and the run's journal file is written in the store's `journal` folder.
2. A person opens that run's jsonl file and takes the lines of one unit.
3. A line of `read_file` names the file and counts `counters.sourceBytes.served`; the line that reads the same lines again counts them under `repeated`.
4. A line of `get_symbol` counts the evidence it showed under `counters.evidence` and any join it could not make under `counters.unresolvedJoins`.
5. The line of `write_page` counts the page, its statements, their grounds and its links under `counters.produced`.
