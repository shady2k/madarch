# An agent's task is in English only

Change: madarch-64o5.107
Base: 39bf4ae12863dc42f0808cf0641d042f1e8d71b9
Tasks: madarch-64o5.107
Kind: no-behavior

## Intent

The owner read the task his first agent fill sent and found every kind's definition and field text as a map of two languages, English and Russian: «И зачем мы отдаем агенту два языка? Это странно. Должен быть один английский. Всегда. … это же дублирование.» Before the task and its output contract are built, madarch now resolves every locale map to its English text, recursively; a map with no English entry is left out, never sent in another language. The reader's language matters only for what people read.

## Out of scope

The publication of content in other languages by a translation stage (madarch-64o5.108); the language of human-facing text an agent writes, which a field states explicitly where it needs one.

## Rationale

One canonical language for everything an agent reads keeps its task short and unambiguous: on a scripted domain task the task fell from 1 610 to 1 164 characters (about 403 to 291 tokens) and the whole prompt from 1 805 to 1 359 characters. Checks: `bun run check` green; locale resolution unit tests; an end-to-end scripted ACP fill over a manifest with Russian labels finds no Russian text in the prompt the peer received. Mutation not run, filed per the stage rule; no real agent ran.

## Preserved contracts
- fill-stages/configuration: the manifest's declarations are read as before; only what is sent to the agent is resolved to English.
- fill-orchestrator/attempt: a unit's attempt, draft and validation run as before against the declared contract.

## Coverage
- fill-stages/configuration: static, test, mutation, review
- fill-orchestrator/attempt: static, test, mutation, review

## Where it is seen

Kind: internal
Place: the task an agent receives in a fill
Reason: nothing a person reaches changes; the agent's prompt holds English text only.

1. A person who opens an agent unit's «Подробно» on the run page sees the task in English only.
