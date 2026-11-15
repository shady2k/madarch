# A fill that pulls in a kind as a dependency plans it, instead of refusing on that kind's agent-only field

Change: madarch-64o5.102
Base: 8b3c73cb7bfa96b18c8c6f98e7f3ee2d6590d65c
Tasks: madarch-64o5.102
Kind: no-behavior

## Intent
The owner could not start any fill whose selection pulls in Файлы (for example Домены): the plan was refused with «kind "code.file": the field "state_machines" has no producer in the manifest», with an agent chosen or plugins only. The route handed the plan's expanded kinds to the planner as the person's ask, so a pulled-in dependency counted as asked and its agent-bound field became an error.

The asked set is now the person's requested selection. A pulled-in dependency's agent-bound fields are listed among the unfilled (the plan's skipped) and the run starts; a field bound to a plugin the manifest does not have stays an error, asked or pulled in.

No requirement changes: the selective fill's contract already says a selection runs its kinds and what they need, and that fields nobody fills are named as left unfilled.

## Rationale
A fill the person asked for could not start at all whenever its selection pulled in a kind with an agent-only field; the plan named an error the person could not act on. Planning what was asked and naming what stays unfilled is what the planning contract already promises.

## Preserved contracts
- fill-orchestrator/plan: a run still plans its units from the declared stages; only which kinds count as asked (the person's selection, not the expanded plan) is corrected.
- fill-stages/starvation: a field whose declared plugin is missing is still named as an error, asked or pulled in.

## Coverage
- fill-orchestrator/plan: static, test, mutation, review
- fill-stages/starvation: static, test, mutation, review

## Where it is seen

Kind: request
Place: POST /api/fill-plan (the plan the prepare page shows)

1. A plan of {"selected":["domain"]} (which pulls in Репозитории, Папки, Файлы) answers errors [] and skipped [code.file: state_machines], so the prepare page can start the run; before, the run was refused with «kind "code.file": the field "state_machines" has no producer in the manifest».

## Out of scope
Filling a dependency's agent field when the requested kind reads it (listed instead); the reader's-language text of planning refusals (madarch-64o5.103).
