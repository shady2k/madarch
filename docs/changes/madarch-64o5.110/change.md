# Core plugins: a declared tier, the one gate to each outside source, and no environment for the rest

Change: madarch-64o5.110
Base: 2535d187abbb
Tasks: madarch-64o5.110
Kind: behavior

## Intent
The owner's rule (2026-11-15, madarch-64o5.109 and .110): the agent reads only the graph, and reading files, git or the
network is the job of specialised plugins that put what they read into the graph. His words: «Нужно иметь какие-то
плагины уровня ядра … Этот плагин создан специально для чтения файловой системы. Вот этот — для взаимодействия с Git. Вот
этот используется для доступа по сети», and «в атрибуты плагинов можно писать, нужна ли ему вообще песочница или нет …
тогда ему вообще никакого доступа, никакой среды вообще не должно быть для исполнения, для чтения или еще чего-то».
Decision 0038 records it.

Implemented: `plugin.json` declares `tier: core | ordinary` and the `capabilities` a plugin holds. The host grants
exactly that: a core plugin is bound its one source read-only, an ordinary plugin's sandbox root is an empty file system
with no repository, no tool and no network, and its `file.read` is routed to the git plugin — the one read a page and an
agent make (decision 0037), not a second one. Every undeclared access is refused with the plugin, the access and the
file, line and path. The agent session runs in an empty folder with no write tool and no terminal, and its one file read
is a blob the graph names. The starter plugins carry their declarations: `git` (core, `repository`), `disk` (core,
`filesystem`), `agent-fill` (ordinary, `agents`), and `imports`, `glossary`, `db-schema`, `test-quarantine` (ordinary,
`repository`). `madarch.plugins/3` gains the plugin's `file.read` request; the four ordinary plugins read file text by the
blob id the graph names instead of a graph-held `content`.

## Out of scope
The `network` gate (no plugin is bundled yet; the capability, the grant and the refusal exist), state machines and
translation plugins (madarch-64o5.108), and the code-search index for agents (filed apart).

## Rationale
One gate per source is auditable, cacheable and bounded, and it makes «the agent reads only the graph» hold by
construction: an ordinary plugin cannot reach the disk, so its agent cannot either, except through a blob the graph
already names. A plugin that declares nothing is granted nothing.

## Changes to requirements
- plugin-environment/environment: added — a plugin declares its tier and capabilities, and the host grants exactly that.

## Preserved contracts
- fill-stages/registry: a stage is a module and its registration; unchanged.
- fill-stages/graph: the stage graph is derived from what the stages declare; unchanged.

## Coverage
- plugin-environment/environment: static, test
- fill-stages/registry: static
- fill-stages/graph: static

## Where it is seen

Kind: command
Place: the wiki's fill page and madarch fill, on a product whose code repository is connected

1. The fill runs the code kinds and then the agent: the agent reads a file only by asking madarch's MCP server or the host
   for a blob the graph names, and a path outside the graph, a write or a terminal is refused.
2. A plugin that declares no source is shown in its log as refused: "the ordinary plugin … names the tool …", or
   "declares an agent part and declares no agents capability".

## Blocking questions

None.
