# A disabled press says why, and the catalogue never judges what the agent the next page chooses can fill

Change: madarch-64o5.123
Base: 1460a3b7dfeb14756a5cda0c017eab599b2837da
Tasks: madarch-64o5.123
Kind: no-behavior

## Intent
The owner selected History → Commits/Repository landmarks and `code.cycle` in his product's catalogue and
asked «А почему кнопка не активна?»: «К настройке запуска» stayed disabled, and nothing said why. The
catalogue had planned the set with no agent — the agent is chosen on the next page — so `code.module`, a
prerequisite only the agent fills, was «no producer in the manifest», the plan held errors, and the press
was off: a loop, because the page where the agent is chosen could not be reached. Now no disabled press
stands without its reason beside it and as its accessible description, the catalogue marks such a kind
«заполнит агент» and goes on, and the preparation page decides once the agent is chosen.

## Out of scope
- The kit's one button, icon button and toggle and their gate: that is madarch-64o5.127, on the same branch.
- The planner's rule that a pulled-in dependency's own agent gaps wait for a fill that asks for it
  (madarch-64o5.63): unchanged; the catalogue now asks for the agent-only prerequisite it needs.
- The plugins-only wording of which fields a kind leaves empty (madarch-64o5.102): kept as it stood.

## Rationale
The owner asked for the reason twice in the same task: «Нужно не просто дизеблить кнопку, а объяснять
почему.» A disabled press that explains itself is the kit's job, by construction: the Button type takes
`disabled` only together with `disabledReason`, and the kit shows the words beside the press and names them
as its accessible description — so a page cannot disable a press quietly, and the UI gate refuses one that
tries. The catalogue's judgement was the wrong place for the agent's work: whether the plan can run is
decided where the agent is chosen, and the kinds the agent alone fills are marked, not refused.

## Changes to requirements
None. The plan still names every kind nothing produces; the catalogue and the preparation page now carry
the selection the plan needs and say why a press is off.

## Preserved contracts
- product-wiki/shell: the catalogue's selection mode, its marks and its bottom bar keep their places, words and test ids, and «К настройке запуска» now reaches the preparation page with the kinds the plan needs: `bun test src/components/command-pages.test.tsx` and the browser walk
- fill-stages/configuration: the plan's producer rule is unchanged — a kind no enabled producer fills is still an error or a skip named by the plan, and an asked kind the agent alone fills is planned by the agent with its fields: `bun test test/plugin-fill-declarations.test.ts`
- product-wiki/internationalization: every new reason is in both English and Russian: `bun test src/i18n.test.ts`

## Coverage
- product-wiki/shell: test
- fill-stages/configuration: test
- product-wiki/internationalization: test

## Where it is seen
Kind: screen
Place: the catalogue's selection mode and the preparation page `/p/prepare` of a product that holds the agent plugin
Mockup: docs/prototypes/madarch-64o5.123/buttons.md
1. Open `/p/catalogue?select=1` with nothing chosen: «К настройке запуска» is disabled and says «Выберите хотя бы один вид» beside it.
2. Choose `code.cycle`: the row says «Заполнит агент: …», its prerequisite `code.module` is marked the same way, and the press is on.
3. Press it: the preparation page opens with `code.cycle` and `code.module`; with «Только плагины» it names the kinds that stay empty and the run goes on, and choosing an agent makes the agent's kinds the run's own work.
4. Open `/p/settings` with the link away: every disabled press says why, beside it.

## Blocking questions
None.

## Design and decisions
The kit's `Button`, `IconButton` and `Toggle` take a discriminated union: `disabled?: false` or `disabled:
boolean` together with `disabledReason: string`. A disabled press renders its reason as a sibling span and
points at it with `aria-describedby`, so the words are visible and are the accessible description. The
catalogue drops the plan's errors from its disabled condition, marks a kind with no plugin producer and
agent fields, and carries such a prerequisite in the prepare address: the plan the preparation page asks
for then has it as a requested kind and runs. No server rule changed; `test/plugin-fill-declarations.test.ts`
pins that asking for the kind with its dependant plans the agent for both.

Every press that can be disabled now names why, from the connection's words to the catalogue's,
preparation's and settings' own.

## Acceptance evidence
Static: `bun run check` passed (tsc, architecture, UI, catalog, workflows, quarantine); `cd wiki/app && bun
run check` passed (tsc and the UI gate).
Test: `cd wiki/app && bun test` — 122 passed, 1 pre-existing failure (`src/compose.test.ts`, the same one
at the base commit 5b5aa649). `bun test src/components/command-pages.test.tsx` — 16 passed, including the
two new cases: the catalogue marks `code.cycle` and `code.module` «Заполнит агент» and its press goes on
to `/p/prepare?kinds=demo.cycle,demo.module`; the preparation page stands with no plan error, names the two
kinds that stay empty under «Только плагины», and its run press is on before and after an agent is chosen.
`bun test test/plugin-fill-declarations.test.ts` — 36 passed, including the new case that a kind only the
agent fills is an error when asked alone and is planned by the agent when asked with its dependant.
Walk: `MADARCH_WIKI_E2E=1 bun test test/wiki-buttons-e2e.test.ts` over a starter product read a real
server: `/api/fill-plan` for `['code.cycle']` returns the two errors of the owner's report, and for
`['code.cycle','code.module']` runs `disk`, `git` and `agent-fill` with no error; the catalogue's press
carries `code.cycle,code.module` to the preparation page, where no plan error stands. The same walk reads
every disabled press on every page and finds a reason with a resolving `aria-describedby` for each.
Mutation: not made; the stage's mutation run is at the milestone end.
Review: pending; this record is for the review.

## DONE WHEN
Selecting `code.cycle` with no agent saved reaches the preparation page, choosing an agent there makes the
plan runnable, «Только плагины» names the kinds that stay empty, a test stands for each, and no disabled
press on the catalogue and preparation pages stands without its reason.
