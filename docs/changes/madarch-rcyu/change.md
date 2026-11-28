# The run page states the tokens a live fill turn spent

Change: madarch-rcyu
Base: b1b9ceb27238dd19806e74929bff643878966f99
Tasks: madarch-rcyu
Kind: no-behavior

## Intent
The owner's walk of ALX-1936 on the packaged wiki read the fill run page at 9 of
12 units and 0 tokens while the Codex session was spending (2 119 426 tokens, of
which 1 922 176 cached input, when it stopped). The run page's token figure is
read from the run's trace: `src/knowledge/product.ts` (`runViewOf`) hands the
trace's summary to `readFillRunDetail`, and `agentUsageOf` in
`src/obs/trace-report.ts` sums the `agent.usage` spans. A turn whose answer
carries no token report charges the streamed text's estimate to the unit's row
and to the run's token cap (`src/fill/agent-meter.ts`, owner's decision
2026-11-15: the cap is held live), but its span stated only the answer's numbers
— zeros — so the page, the row and the cap disagreed, and a fill whose adapter
reports usage only at the end, or not at all, read 0 tokens for its whole life.

The span now states what the turn added to the row: the answer's increment, or,
for a turn that reported none, the estimate the stream charged, which the row
keeps. The page, the row and the cap then keep one figure, before the fill ends.

The correction pass after the independent review (ALX-2032) closed the two gaps
the first version left. A first turn that is still open states nothing until it
answers, so the page read 0 for the whole of a long first turn: every charge the
stream makes is now a provisional `agent.usage` span of its turn
(`agent.estimate: true`, `agent.turn` naming it, no turn counted), and the
turn's own span answers that turn, so the reader counts the estimate once and
reconciles it by the report. A retried unit spends in two attempts, and each
attempt wrote its own row: the row kept the second attempt's spend while the
trace and the run's cap held both. A meter now adopts the rows its unit already
has in the store (`readAgentUsageRows`), so one row states the unit's whole
spend across attempts.

## Out of scope
The ACP session's own token accounting (`src/fill/acp.ts` is unchanged): an
agent that reports none still reads "not reported" as the session's figure, and
nothing is invented there. The kind's page, which reads the store's `agent_usage`
rows, was already right. The paths a live agent sees under `code.module` and its
output are ALX-1937's. A session reused across turns: the production bridge opens
one ACP session per request (`src/plugin/agent.ts`, `src/fill/acp.ts`), so a
cumulative report that spans a turn charged by estimate and a later turn is not
this path — the meter's difference would subtract only the later turn's estimate
and state the earlier turn's report as new spend (review ALX-2032's mixed
observation). No adapter madarch starts reports that way today; a session
reused by another adapter would need the meter to keep per-turn reports, which
this change does not add.

## Rationale
A counter that reads 0 while the run spends is worse than a counter that reads
"not reported": it states a fact that is not true, and the run's own cap was
already counting the same tokens, so one fill had two answers to one question.
The trace is the page's evidence, so the trace must state what the meter
charged.

## Preserved contracts
- product-wiki/acp-agent: the session still keeps the agent's latest report as its own figure and reads "not reported" for an agent that reports none; the meter's charged estimate is the unit's row and the run's cap, as the owner's decision of 2026-11-15 already made it, and it is marked `reported: false` wherever it is read.

## Coverage
- product-wiki/acp-agent: test

## Where it is seen
Kind: screen
Place: The fill run page of a live fill, its run card's "Tokens:" line
Mockup: docs/prototypes/madarch-rcyu/tokens.html
1. Open a fill's run page while its agent works — before its first turn answers too.
2. The Tokens line names input, output, cache write, cache read and total for the turns that ended and for the turn in flight, instead of reading 0 for an agent that reports no usage of its own.

## Blocking questions
None.

## Design and decisions
`AgentMeter.endTurn` writes the turn's increment into one `agent.usage` span.
When the answer reported no usage, the increment is `#estimated` — the estimate
the stream charged and the row kept — instead of the answer's zeros; when the
answer reported usage, the estimate was already taken back out of the row and
the answer's increment is the span, as before. Both cases keep the invariant the
bounded reader relies on: the spans of a run add up to the rows, so
`agentUsageOf`'s totals are the meter's spend and the cap's.

`AgentMeter.meterSessionUpdate` writes every charge it makes as a provisional
span of the turn: one `agent.usage` span per charge, `agent.estimate: true`, the
turn named by `agent.turn`, `agent.turns: 0`, and no bound attribute (a bound is
named where the turn ends). `agentUsageOf` groups the spans of a line by that
turn and counts it once: the answering span when the turn answered — the
estimate that stood for it stops standing, which is what the row and the cap did
— and the provisional spans only while it has not. A turn that has not answered
spends, so it states tokens and counts no turn yet. The trace's cost keeps the
publication it had before this change — one span per turn: a provisional span
states the turn's token charge and never a cost, and the span that answers the
turn states the cost the adapter reported during it, the row's increment since
the previous settled span. Only that settled span advances `#incrementCosts`'s
baseline; a provisional span that advanced it left the answering span with no
cost to state, and `agentUsageOf` replaces a provisional turn by its answer, so
the completed run stated no cost at all (madarch-rcyu regression, reproduced on
`0ecabc6`). The trace file still flushes as it grows (`src/obs/trace.ts`), so the
api role reads it while the fill runs.

`pluginUnitMeter` reads the rows the unit already holds (`readAgentUsageRows`)
and hands them to the meter as `adopted`: the meter's row is the unit's whole
spend, its save replaces that row (never adds), and its first span states only
what this attempt added, so the trace, the row, the kind's totals and the run's
cap keep one figure over both attempts. The checks that read the page over HTTP
are the two cases of `test/live-agent-usage.test.ts` (a fixture ACP peer that
streams a known text, writes its readiness file only once it stands at the
barrier, and waits for that unit's release file, which the case writes after its
assertion and in its cleanup); the rendered Tokens line is covered by
`wiki/app/src/components/command-pages.test.tsx`; the focused cases are in
`test/agent-meter.test.ts`, among them the turn that reports its cost before it
answers: its row and the completed trace each state the one USD 0.50 charge, and
the case is red on `0ecabc6`, where the trace's cost list is empty.
The read runs only for the turn that has an agent to meter, which is the
eligibility the turn itself states (`wiring.agent` and the plugin's agent part):
a unit with no agent part, and every unit of a fill without an agent, writes no
row, so reading what an earlier attempt left would be a read no row can answer —
and each such read was two transactions of the fill's own query budget (CI run
46097904262: 531 transactions against the limit of 510 over
`test/source-follows-fill.test.ts`'s 12 deterministic units, 507 on the base).
The retry case of `test/agent-meter.test.ts` reads the run's completed trace
after the trace's own close, not before it: the trace batches its appends
(`src/obs/trace.ts`), so a read taken first sees only the batch whose timer
already fired.

## Acceptance evidence
Pending the stage acceptance of ALX-1936: the run above is the one-time walk,
and its record is the acceptance record of that stage, not this change.

## DONE WHEN
A fill whose adapter reports no token usage states, on its run page and in the
product's own run read, the tokens the meter charged for the turn in flight and
for every turn that ended, an adapter's own report stands once in that figure
with its cache categories, and the figure equals the unit's row, the kind's
totals and the run's cap over every attempt of a retried unit; and a cost the
adapter reports during a turn stands once in the unit's row, the kind's totals
and the completed run's trace.
