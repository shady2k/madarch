# 0026. The fill builds the product graph first, in bounded agent units that read and write it through checked tools

Status: accepted
Date: 2026-10-18

Supersedes the stage design of docs/changes/fill-pipeline-monday (the Monday slice of the
self-filling milestone). Builds on 0004 (atomic facts with evidence), 0005 (layers and acceptance),
0009 and 0024 (the bitemporal fact log and graph queries in PostgreSQL/PGlite), 0017 and 0023 (git is
the truth for what people and agents write; derived indexes are rebuilt where needed) and 0018
(madarch's own wiki app with its diagram renderers).

## Context and problem

The first fill pipeline landed in October 2026 passed two checkpoints on a ~50 KB training repository
and then failed on madarch itself (943 files): its claims stage put the full text of every file into
one agent call (10.7 MB, refused by the OS with E2BIG, and ~3M tokens, beyond any context window);
its "code map" was deterministic and the agent-built bottom-up module understanding the design had
promised did not exist; its ids carried the run id. The owner judged it wrong at the root: «То что
работает нельзя показывать, это в корне неверно. Нужно сделать как положено.»

The question: how does madarch gather knowledge about a product of any size so that each pass builds
on the previous ones, from the general to the particular, within an agent's real limits?

## Decision drivers

- From the general to the particular; every later pass relies on what earlier passes found (owner:
  «Мы сначала собираем общую картину, от общего к частному. Каждый следующий проход опирается на
  результаты предыдущего.»).
- Repositories may be very large; work must be divided; a unit never relies on a 1M window (owner:
  «Рассчитывать на миллион контекста нельзя, я бы ограничивался 272K. Нужно ограничивать количество
  ходов, время, заполнение контекста.»).
- The person watches the wiki fill (owner: «хочется чтобы человек видел как вики наполняется на его
  глазах»), with diagrams, not walls of text (owner: «Наглядная страница гораздо лучше стены текста»).
- Every statement traceable to evidence; agent interpretation stays proposed (0005).
- Practice of the field (2025–2026): Google Code Wiki (regenerated on merge, every section linked to
  code), DeepWiki (plan, then one page per focused task), CodeWiki (dependency graph clustered
  recursively into modules, one agent per leaf module reading code through tools, parents from
  children; $0.34 per update vs $21.48 per full build), RepoDoc (code + concept + document graph,
  LLM-guided module clustering, impact propagation over graph edges on a commit diff: −77% tokens,
  97% update recall), GraphRAG (bottom-up community summaries, global-then-local drill-down), Aider
  (tree-sitter reference graph ranked by PageRank), GitHub stack graphs (file-incremental indexing),
  Claude Code and Cursor (agentic tool search over vector retrieval), architecture recovery
  (ACDC, Bunch; SemArc and ArchAgent: LLM semantics improve component boundaries), reflexion models
  (intended model, source model and the mapping between them). None of them reconciles intent with
  code across a product's repositories; madarch does.

## Considered options

1. Keep the landed pipeline and chunk its claims call by size. Rejected: still sends code into
   prompts, still has no agent understanding of modules, still no graph between passes.
2. Pure agentic exploration per page (each page's agent greps the repository). Rejected: no shared
   knowledge, repeated reading, no coverage, cost grows with pages × repository size.
3. Vector retrieval over chunks. Rejected: weaker than agentic tool search for code in the field's
   experience; loses structure; staleness.
4. **Graph first: deterministic extraction into the product graph, then bounded agent units that read
   and write the graph through checked tools, then pages rendered from the graph.**

## Decision

Option 4, agreed with the owner on 2026-10-18 point by point («Да»).

- **Stages.** Deterministic, complete on any size, incremental per commit: 0 snapshot (code
  repositories and the product repository), 1 inventory, 2 build and configuration, 3 syntax
  (tree-sitter, per file), 4 semantic resolution (SCIP/compiler where available, syntactic fallback
  with its precision), 5 modules by recursive clustering of the dependency graph (packages and build
  targets as seeds, a size threshold) and importance by PageRank, 6 document index, 7 history. Agent:
  8 overview hypothesis, 9 module-boundary refinement, 10 intent from documents, 11 intent from
  comments and commits, 12 module understanding bottom-up (leaves first, parents from children's
  summaries), 13 system recovery and reconciliation (recovered architecture beside the intended one
  with the mapping between them). Every stage writes facts into the graph and reads its context from
  it.
- **Units and limits.** Every agent unit has a 272K-token window: planned size ~50%, a wrap-up signal
  at 70%, a hard stop at 80% (the rest is reserved for reasoning and the answer); at most ~30 turns,
  ~10 minutes, 16K output; a starting packet of at most 20K tokens; tool answers at most 8K tokens,
  marked when truncated; code read through bounded spans (~200 lines). A unit at a limit returns what
  it has with its coverage; the scheduler splits the scope and runs the parts. Run budgets (calls,
  time, tokens) are what the owner authorizes; within them, important scopes go first and the rest is
  shown as not covered.
- **Scale.** Units form a hierarchy: product → repository → package/build target → cluster →
  sub-cluster, split until a unit's estimate (computed from the graph) fits. Summaries are bounded
  (~2K tokens) and fan-in is bounded (~50 children, else an intermediate grouping level), so every
  level, the product overview included, fits a unit.
- **Agent input.** A fixed part (role, rules, limits, answer schema with an example, tool
  descriptions), a per-unit packet assembled from the graph without an agent (scope, place, ranked
  symbols without bodies, entry points, edges, data, history, intent so far, children's summaries,
  expected registry kinds, open questions, the task), and tools. No file content is pasted.
- **Agents and tools.** madarch drives agents over the Agent Client Protocol (ACP); for each unit it
  starts an MCP server bound to the snapshot, the unit's scope and its limits and passes it into the
  ACP session. The agent's own file tools are off: it reads code only through the server's
  evidence spans, and every call is logged as the unit's dependency. madarch counts tokens from the
  session and the server and enforces the 70%/80% thresholds by message and cancellation.
- **Writing.** The agent writes to the graph through the same server (assert a fact, propose an
  entity, link, raise a question). Every write is checked at once (schema, the cited bytes exist and
  are read by madarch at the pinned commit, referenced nodes exist, the write is inside the unit's
  scope) and lands in the unit's draft set, visible to other units as draft. A unit that ends well is
  published in one transaction; a failed or rerun unit's set is retracted. Proposing an entity answers
  with similar existing ones. The background server owns the database and is its only writer; the
  units' MCP servers are thin proxies to it. Agent statements are proposed, inferred (0005); anchors
  existing, anchors supporting the statement and a person's acceptance are three separate checks.
- **Pages.** Every graph node of a page-worthy kind has a live page at once, rendered from the graph
  without an agent (facts with code links, relations, diagrams, intent, questions, coverage) and
  updated in the browser as facts arrive; it is a view, not a file in git. Narrative text is a second
  layer written by agent units in order of importance, each sentence tied to fact or claim ids,
  stored as Markdown in the product's git with status proposed; a person's edits and answers are git
  as well.
- **Diagrams.** madarch draws them from the graph; an agent only chooses what to show (a view
  specification: type, nodes, scenario, level), which madarch checks against the graph. Types: C4
  context, container and component, module dependencies, sequence, state, activity, class/ER,
  deployment, use case. Every diagram carries a switcher over every renderer that supports its type:
  archify and Mermaid wherever they do, LikeC4 for C4 and deployment; the first tab is a setting
  (MADARCH_WIKI_DIAGRAM). Solid lines are facts, dashed are assumptions or unresolved; elements link to
  their pages and code; a diagram stays readable by size and collapses to the level above with
  drill-down.
- **Updates.** On a default-branch commit: the deterministic stages run for what changed; impact
  propagates over graph edges; only affected agent units and pages rerun, in dependency order. A
  unit's cache key is its queries with their result membership (empty results included), the spans it
  read, and the prompt, schema and model versions; ids are stable and never contain a run id.

## Consequences

- The landed fill is rebuilt, not patched; its runtime, ACP-replaceable agent adapters, wizard, panel,
  questions and next-step rules are reused where they fit.
- madarch needs: the deterministic extractors and their fact schema (a separate namespace from the
  registry's kinds, with explicit mappings between them), the clustering and ranking, the per-unit MCP
  server with read and write tools, an ACP client, the scheduler with limits and splitting, live
  graph-rendered pages and graph-rendered diagrams.
- The PostgreSQL move (madarch-24sy) becomes a prerequisite of the agent stages; until it lands, the
  deterministic stages may write behind the same storage interface.
- The Monday 2026-10-19 date of the self-filling charter does not hold; a new date follows from the
  task breakdown.
- Revisit if bounded units cannot reach useful coverage on very large repositories within the budgets
  the owner sets, or if ACP adapters cannot expose session usage for the limits.

## Sources

Google Code Wiki: https://developers.googleblog.com/introducing-code-wiki-accelerating-your-code-understanding/ ·
DeepWiki: https://cognitionai.mintlify.app/work-with-devin/deepwiki ·
CodeWiki: https://github.com/FSoft-AI4Code/CodeWiki, https://arxiv.org/abs/2510.24428 ·
RepoDoc: https://arxiv.org/html/2604.26523v1 · RepoAgent: https://arxiv.org/abs/2402.16667 ·
GraphRAG: https://arxiv.org/html/2404.16130v2 · Aider repo map: https://anishgandhi.com/aider-pagerank-codebase-ranking/ ·
stack graphs: https://github.blog/open-source/introducing-stack-graphs ·
agentic search: https://vadim.blog/claude-code-no-indexing/ ·
ArchAgent: https://arxiv.org/abs/2601.13007 · reflexion models: https://www.cs.ubc.ca/sites/default/files/tr/1997/TR-97-15_0.pdf ·
SCIP: https://github.com/scip-code/scip/blob/main/docs/scip.md
