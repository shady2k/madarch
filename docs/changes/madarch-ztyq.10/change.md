# A person's own agent asks the repository's graph the seven questions of decision 0032, over the Model Context Protocol, and hears the working tree's answers

Change: madarch-ztyq.10
Base: 6f07d86e6f7e24bb1d18e49791ffdeb19e12f0b8
Tasks: madarch-ztyq.10
Kind: behavior

## Intent

Decision 0032 gives the agent stage seven questions a person can ask of a repository — what a symbol
says, what it is a part of and what calls it, which functions it reaches, which sections of a document
answer a question, which pages hold words, one page as written, and which questions are open — and gives
them to the fill's units only, inside the fill that writes a product's wiki. A person reading their own
checkout with their own agent cannot ask them: the tools answer over a graph the fill built, and the
agent's client speaks the Model Context Protocol, which madarch has no server for.

This change adds `madarch mcp`: the same seven tools, served read-only over the Model Context Protocol on
standard input and output, over a graph of the repository's own commit at `HEAD`. The graph is built by
the extraction the wiki and the writer already use and is kept in the repository's state folder, so the
next start reads it; the working tree's uncommitted changes are read again before an answer that touches
them, so no answer is stale; every answer names the revision it was read at and the files that differ
from it, and marks what came from an uncommitted file; and every call is journaled with the files it read
again and an estimate of the file reads it saved. The server writes nothing.

## Out of scope

- The tools of decision 0032 themselves: their bodies, bounds, refusals and answer shapes are the
  writer's, and this change serves them as they are, calling `src/writer/answers.ts` rather than restating
  it. No answer gains or loses a field.
- The fill's own unit server (`mcp-unit`) and its tools: the writer's server keeps its tools, its session
  and its answers. The one change it sees is the message a client gets for a method it does not serve,
  which now names the tools it was given instead of the units' tools.
- History extraction: none of the seven tools reads the repository's history, so the served graph does
  not extract it.
- Write access of any kind: no tool that writes a page, a question or a file is served, and the page
  writer of the fill is refused.
- The official TypeScript SDK as a dependency: the protocol half is the project's own, hand-written
  `answerUnitMcpMessage` (`src/fill/unit-mcp.ts`), already carried for the units' server, so this change
  adds no dependency and no second reading of the protocol.
- A client's own UI, its transcripts and its prompts: the server answers protocol messages and says
  nothing about how a client shows them.

## Rationale

The graph a person's repository deserves is the graph madarch already knows how to build, and the
questions decision 0032 already settled are the questions their agent should be able to ask. Serving the
writer's own tools, rather than a second set written for the command, is what keeps the two from drifting:
a bound that changes in the fill changes here, and a refusal that names a key in the fill names it here.

Freshness is the reason this is a server and not a one-shot query: a person edits a file, asks their
agent, and reads the answer. The layer over the working tree is exact rather than eventual — a file git
reports as different from `HEAD` is extracted again before an answer that touches it, and the nodes it
produces hide the commit's nodes for the same keys — so an answer that names a file names what the file
says now, and says that it does. The journal answers the question a person asks after a week of use:
what did this server save me?

## Changes to requirements

- mcp-server/served-tools (new): the seven read-only tools of decision 0032 are served from the writer's
  own tools, and no tool that writes is served. Scenarios: `the-seven-tools-are-listed`,
  `a-writing-tool-is-not-served`.
- mcp-server/stdio-protocol (new): the Model Context Protocol is spoken over standard input and output,
  JSON-RPC 2.0 one message per line, standard output carrying nothing but messages, logs on standard
  error, and the process exiting 0 at the end of its input. Scenarios: `a-client-initializes-and-calls`,
  `an-unserved-method-is-refused-on-standard-output`.
- mcp-server/working-tree-freshness (new): the base graph is the graph of `HEAD`, a file the working tree
  changed is read again before an answer that touches it, nodes of uncommitted files are marked, a
  deleted file is gone, and every answer names its revision and the changed files. Scenarios:
  `an-uncommitted-edit-is-answered-from-the-working-tree`, `a-deleted-file-is-gone`,
  `an-answer-names-its-revision`.
- mcp-server/call-journal (new): every call is journaled with the tool, its arguments, the answer's size,
  the files read again and an estimate of the file reads saved, and `--journal` prints the summary.
  Scenarios: `every-call-is-recorded`, `the-journal-is-printed`.
- mcp-server/command-and-registration (new): the command serves the current folder or `--repo` with a path,
  refuses a folder that is not a checkout with exit 2, and the administrator guide says how a client
  registers it. Scenarios: `the-command-serves-the-current-folder`,
  `a-path-that-is-not-a-checkout-is-refused`.

Complete proposed capability text: `capabilities/mcp-server.md`. It is the whole capability, not a
hand-written delta.

## Preserved contracts

- product-wiki/acp-agent: the fill's unit server keeps its tools, its session, its answers and its bounds; the only change it sees is that the error for a method it does not serve lists the tools it was given, which for the unit server are the same tools as before.
- graph-queries/as-of: the reads an answer stands on are the graph's own, at the one time the served commit names; no query, index or stored fact changes.

## Coverage

- mcp-server/served-tools: test, static
- mcp-server/stdio-protocol: test, static
- mcp-server/working-tree-freshness: test, static
- mcp-server/call-journal: test, static
- mcp-server/command-and-registration: test, static
- product-wiki/acp-agent: test, static
- graph-queries/as-of: test, static

## Where it is seen

Kind: command
Place: a terminal in a checkout, the `madarch mcp` command, and the tool list of the MCP client the person registered it with

1. Register the server with a client (`claude mcp add madarch -- madarch mcp --repo /home/you/library`), and start the client.
2. Ask the client for a symbol of the checkout: the answer is the symbol's declaration and code, and it says which commit and branch it was read at.
3. Edit a file without committing, and ask again for a symbol the edit added: the answer holds what the file says now, names the file among the changed files, and marks the symbol uncommitted.
4. Run `madarch mcp --journal --repo /home/you/library`: it prints the calls, the files read again and the file reads saved, and no server starts.

## Blocking questions

None.

## Design and decisions

The protocol half is `src/fill/unit-mcp.ts`, which the unit server already stands on: `answerUnitMcpMessage`
handles `initialize`, `ping`, `tools/list`, `tools/call` and the protocol's errors, and takes the tool list
and a call forwarder. `src/mcp/server.ts` gives it `REPO_TOOLS` and `callRepoTool` through an open
`RepositorySession`. The alternative — the official TypeScript SDK — was not taken: it brings a transport
and a validation stack (13 or more transitive packages, among them express, hono, ajv and jose) for a
protocol half the project already has, and the two servers would then read the protocol in two ways. The
one generic defect the reuse exposed is fixed in the protocol layer itself: the error for a method the
server does not serve listed the units' tool names from a constant; it now lists the names of the tools it
was handed.

The state is one folder per checkout, under `${XDG_STATE_HOME:-~/.local/state}/madarch/mcp/`, named by
the checkout's own name and a digest of its absolute path. Two checkouts of one name never share a graph,
and a lock file keeps two processes from writing one PGlite folder. The base graph is filled by
`fillGraph` over `TREE_EXTRACTORS` at `HEAD` and its text ingested by `ingestContent`, so an answer quotes
the graph's content nodes rather than the disk (decision 0026); a table, `mcp_base`, records the commit
the folder holds, and a folder whose row names another commit, or whose graph cannot be opened, is filled
again, which reads only the commits since its tip.

The working tree is a layer, not a rebuild: `git status --porcelain -z` names what differs from `HEAD`,
and `git ls-files --cached --others --exclude-standard` names what the layer serves; each dirty path whose
content digest changed is extracted again by `extractCodeWithFacts`, and only nodes and edges whose span
is a dirty path are kept. The base rows for those paths are hidden rather than deleted, so the commit's
graph survives a checkout of the file, and the layer's entities carry `uncommitted: true`. Reads merge the
two: an entity is the layer's when it has one, is absent when the path is dirty and the layer has none,
and is the base's otherwise; lists drop the hidden rows and add the layer's, recounting their totals;
edges keep the base's incoming rows from unchanged files and drop the rows whose site is dirty. The layer
is refreshed on every call and is a no-op when the set of dirty paths and their digests are unchanged.

The journal is one JSON line per call, in the state folder beside the graph, so a person can read it with
`jq`; `--journal` summarizes it without opening PGlite, which is what makes it usable while a server holds
the folder's lock. The estimate of saved file reads counts the distinct files whose text the answer
carried or named as evidence: a document the answer quotes, a page it returns, and the file of every
entity key it names. It is an estimate and is named one.

## Acceptance evidence

Filled at the push: `bun run check`, the new `test/mcp-server.test.ts`, the writer's and the unit server's
suites, the wiki walk's ratchet, and the measurements on madarch's own checkout, with the digest of the
document gate.

## DONE WHEN

`madarch mcp` serves the seven tools of decision 0032 over the Model Context Protocol from a checkout's own
graph, read-only; an uncommitted edit is answered from the working tree in the next call and a deleted file
is gone; every answer names its commit, its branch and the files that differ from it, and marks what came
from an uncommitted file; every call is journaled with the files it read again and the file reads it saved,
and `--journal` prints the summary; the tests drive the server over standard input and output as a client
does; and the administrator guide says how to register it.
