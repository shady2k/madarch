# The agent's task is the kind, its reads are the graph, and its answer is kept

Change: madarch-64o5.112
Base: 1460a3b7dfeb14756a5cda0c017eab599b2837da
Tasks: madarch-64o5.112
Kind: no-behavior

## Intent
The owner's decision of 2026-11-15: the agent's only way to learn the product is the graph, and a
produced result is never thrown away. A fill's agent unit is now given the kind it fills, what that kind
means and its fields' meanings in English, and madarch's own graph server; nothing of the graph stands in
the prompt. A unit lives under its own time bound, a token cap counts input, output and cache writes and
is enforced live, and an answer that is partial or malformed is kept entry by entry.

## Out of scope
- The model or the agent a run chooses, and the run page that shows the choice.
- The product's catalogue kinds, which madarch-64o5.109 settles.
- A review of the agent's answers beyond the contract and the graph.

## Rationale
The owner's real fill (2026-11-15) died at 60 s with the 3 156 paths of the code list in the prompt, then
counted 1 000 639 tokens of cache reads against a 200 000 cap, kept nothing the agent had produced and
retried the unit the cap stopped. His words: «Только токены без кэша», and a produced result is never
discarded even if incomplete. The agent must read the graph as a person does — through madarch's server —
and a bound that stops a unit ends it once, with the bound's reason.

## Changes to requirements
None. The change realizes the existing `product-wiki` acp-agent requirement — the unit's session carries
the MCP servers it reads and writes through — and the fill's plan, attempt and admission requirements, whose
text already holds one unit per kind, one lease, one draft and the run's limits.

## Preserved contracts
- product-wiki/acp-agent: an agent unit still starts over the Agent Client Protocol, version 1, one session per unit carrying the MCP servers the unit reads through, one prompt per turn and a cancellable turn
- fill-orchestrator/attempt: one unit still follows a lease, a draft and a validation, and a stopped attempt still fails with its reason instead of retrying into the same wall
- fill-orchestrator/admit: admission still stays within the run's limits, and a spent bound still ends the unit before the next prompt
- fill-stages/configuration: a product's manifest still enables, disables and limits a stage, now including the agent's own bound in whole minutes

## Coverage
- product-wiki/acp-agent: static test
- fill-orchestrator/attempt: static test
- fill-orchestrator/admit: static test
- fill-stages/configuration: static test

## Where it is seen
Kind: command
Place: `madarch fill` with an agent and a token cap, and the run's page that shows its units

1. Run a fill of a product with an agent and a token cap: the agent's session answers the kind's task, and its reads of folders, files and a file's text come through the graph server.
2. Read the run's page: each unit's line names the tokens it spent, with cache reads shown and not capped, and a unit that went over the cap says so and keeps what it published.
3. Stop the agent's turn at the cap, or let its own bound run out: the unit fails once with the bound's reason, and the next unit is not asked under the spent bound.
4. Let an agent answer a vertex the contract cannot take: the entry is left out and named, the entries beside it are published, and the run states the partial answer.

## Blocking questions
None.

## Design and decisions
The session's tool set is the graph server: the schema, one GraphQL operation, and one text field of one
entity in a line range, all over the owner the fill writes with, so a read sees the same graph and prepares
nothing. The task is JSON in the prompt: the kind, its description, its key and each field's meaning; no
file list and no contract dump. Bounds: a plugin with an agent part runs its units under `agentUnitMs`
(thirty minutes), the product may set `bounds.minutes`, and every ACP event, refused tool call and file
read is a sign of life beside the SDK's heartbeat. The cap counts input, output and cache writes; at four
fifths of the nearest bound the agent is told to finish with what it has, in its next prompt and in every
tool answer, and a spent bound asks no further prompt. The bridge holds every vertex and edge against the
contract and the graph one by one; an entry it cannot take is left out and named, the entries beside it
stand, and only an answer that holds nothing abstains.

## Acceptance evidence
Static: `bun run check` passed with the catalogue branch's merge (tsc, architecture, UI, catalog,
workflows, quarantine).
Test: `test/agent-fill-graph-mcp.test.ts` (2 cases) proves the task is the kind, that the agent reads
folders, files and a file's text through the server, and that a million reported cache reads spend only
input, output and cache writes while a result past the cap is kept; `test/fill-updates-run.test.ts` and the
bounded-unit cases beside the host prove the bound and the salvage.
Mutation: not made; filed per the stage rule.
Review: pending; this record is for the review.

## DONE WHEN
A fill of a real product runs the agent under its own bound, the agent learns the product only through the
graph server, a token cap counts input, output and cache writes and never discards a produced answer, and a
partial answer's entries are published with the rest named.
