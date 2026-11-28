# The run page states the tokens a live fill turn spent

Change: madarch-rcyu
Base: 898838c8755a5341923ecf16e24d022bde4e662f
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

## Out of scope
The ACP session's own token accounting (`src/fill/acp.ts` is unchanged): an
agent that reports none still reads "not reported" as the session's figure, and
nothing is invented there. The kind's page, which reads the store's `agent_usage`
rows, was already right. A figure inside a turn that has not ended yet: the
estimate is charged as the text arrives, but the trace states it when the turn
ends, and this change does not write spans per streamed chunk. The paths a live
agent sees under `code.module` and its output are ALX-1937's.

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
1. Open a fill's run page while its agent works, once one of its turns has ended.
2. The Tokens line names input, output, cache write, cache read and total for the turns that ended, instead of reading 0 for an agent that reports no usage of its own.

## Blocking questions
None.

## Design and decisions
`AgentMeter.endTurn` writes the turn's increment into one `agent.usage` span.
When the answer reported no usage, the increment is `#estimated` — the estimate
the stream charged and the row kept — instead of the answer's zeros; when the
answer reported usage, the estimate was already taken back out of the row and
the answer's increment is the span, as before. Both cases keep the invariant the
bounded reader relies on: the spans of a run add up to the rows, so
`agentUsageOf`'s totals are the meter's spend and the cap's. The check that
reads the page is `test/live-agent-usage.test.ts` (a fixture ACP peer that
streams a known text, reports nothing and holds its next turn until the case
releases it); the focused case is in `test/agent-meter.test.ts`.

## Acceptance evidence
Pending the stage acceptance of ALX-1936: the run above is the one-time walk,
and its record is the acceptance record of that stage, not this change.

## DONE WHEN
A fill whose adapter reports no token usage states, on its run page and in the
product's own run read, the tokens the meter charged for every turn that ended,
and that figure equals the unit's row and the run's cap.
