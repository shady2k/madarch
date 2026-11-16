# Development questions through the product MCP graph

Change: madarch-64o5.147
Base: 02db7117ea2b0fb0507b7c68eb78d022628a1ba6
Tasks: madarch-64o5.147
Kind: behavior

## Intent
Expose impact, owner, dependencies, dependants and search through the existing product MCP session. Derive closed selector schemas and the required contract revision from the published catalogue. Read active edges and effective typed assertions in one snapshot; return kind labels, source identities and recorded times.

## Out of scope
- Filling a real product or starting an agent.
- Inferring ownership or dependency semantics from names.
- New tables, durable files, or alternative assertion storage.
- Completing the remaining decision 0039 foundation tasks.

## Preserved contracts
None.

## Coverage
- graph-queries/development-mcp: test

## Where it is seen
Kind: command
Place: madarch mcp --product ./example-product, tools/list and tools/call
1. Read tools/list to obtain the installed contractVersion and allowed edge/kind selectors.
2. Call search with a name or synonym. Read each separate hit's kind label and assertion lineage.
3. Call a traversal tool with an entity UID and catalogue edge directions. For owner, select relations toward folders, modules, components and domains. For impact and dependants, select reverse dependency directions.
4. Read kind groups, traversed edges, assertion sources and recorded times. Check cut.depth and cut.count before treating the result as complete.

## Blocking questions
None.

## Design and decisions
- Decision 0039 items 1 and 30: active edges only, in one published-contract snapshot.
- Items 6 and 14: synonyms and homonyms, kind labels, source vertices and recorded time for entity and edge assertions.
- Items 7 and 30: generated closed schemas, required contractVersion, structured SCHEMA_INVALID, CONTRACT_CONFLICT and TARGET_MISSING refusals.
- Items 25 and 30: the existing readKindAssertions selects effective values; this tool adds no truth-selection rule.
- Item 22: the read path is traced.
- Limits introduced here: default 100 entities, maximum 1000; depth default 1 for dependencies/dependants and 8 for owner/impact, maximum 32. Limits bound returned entities; the current reader still materialises selected kinds/relations before traversal.
- Owner returns kind groups and path edges rather than pretending there is exactly one component or domain. Callers supply semantic relation selectors. The same engine performs all four traversals.

## Acceptance evidence
- Final focused run: 7 passed, 0 failed, 119 assertions. Fixture writes use the checked scripted graph writer. Seven tests cover all five tools, synonym homonyms, lineage, cycles, depth/count cuts, malformed inputs, revision mismatch, missing targets, retracted edges and MCP dispatch.
- Bounded manual mutation sample: disabling synonym matching and suppressing search count-cut disclosure each caused the search test to fail. Both mutations were restored.
- Wiki check and tests: 124 passed, 0 failed, 587 assertions.
- Architecture gate: 874 existing violations, all listed; no additions or removals to the debt inventory.
- A bounded full root test attempt was stopped after more than 300 seconds: 30 pass and 7 fail markers, no completed-suite summary. Failures included graph-records REQUIRED_PARENT and plugin-turn failures outside this change. The test process and its PostgreSQL server were explicitly stopped. Memory and disk were available (about 6.4 GB available RAM, 17 GB free disk). This is not a green full suite.
- Document gate: only untracked-change and missing-approval remain, expected without the coordinator tracker.
- Full root check is blocked by the base's test/graphql-executor.test.ts:340 type error (allDemoFile indexed on an inferred empty object). No unrelated fixture was changed to hide it.
- No screen changes; no screenshots apply. No fill or real agent ran.

### Remaining acceptance
Coordinator tracker approval and receipts, integration with the completed cutover, full-stage checks, and owner acceptance remain pending. This record is not a claim of stage acceptance. A full Stryker campaign and independent review have not been performed.
