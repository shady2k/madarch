# Model Context Protocol server

Capability: mcp-server

## Purpose
A person's own agent reaches a repository's graph from the editor they already use: `madarch mcp` serves
the seven read-only tools of decision 0032 — what a symbol says, what it is a part of and what calls it,
which functions it reaches, which sections of a document answer a question, which pages hold words, one
page as it is written, and which questions are open — over the Model Context Protocol on standard input
and output. The answers are the writer's own, read from a graph the repository's own extraction built at
`HEAD` and kept in the repository's state folder, with the working tree's uncommitted changes read before
an answer that touches them. The server writes nothing: no file of the checkout, no page and no question.
Every answer names the revision it was read at and the files that differ from it, and every call is
journaled with what it cost and what it saved.

## Requirement: served-tools — The seven read-only tools of decision 0032 are served, and no tool that writes
A server shall serve exactly the tools of decision 0032's agent stage: `get_symbol`, `get_context`,
`trace_flow`, `get_document_sections`, `search_pages`, `get_page` and `search_questions`. Each answer
shall be the shape the writer's own tool answers — the same body fields, the same refusals with their
codes, and the same bounds on steps, pages, questions and evidence — because the server calls those
tools rather than restating them. A tool that writes shall not be served: the page writer of the fill is
absent from the listing, a call for it is refused naming the tools the server does serve, and nothing of
the checkout is written.

### Scenario: the-seven-tools-are-listed
- Given: a checkout of a repository with a commit, and a server serving it
- When: a client sends `tools/list`
- Then: the answer names the seven tools in the order of decision 0032, each with the writer's own description and input schema, and names no tool that writes

### Scenario: a-writing-tool-is-not-served
- Given: a server serving a checkout
- When: a client calls `write_page` with a page body
- Then: the call is refused with an error that names the tools the server serves, and no file of the checkout is written

## Requirement: stdio-protocol — The protocol is spoken over standard input and output, and standard output carries nothing else
The server shall read JSON-RPC 2.0 messages from standard input, one per line, and answer `initialize`,
`ping`, `tools/list` and `tools/call` on standard output, one message per line and each with the id of
the request it answers. `initialize` shall answer the protocol version and the server's own name and
version, and each listed tool shall carry its input schema. Every line of standard output shall be a
message a client can parse; what the server says to a person — the folder it builds, the revision it
serves, the reason it refuses — is written to standard error. A message the server cannot answer shall be
answered with the protocol's error for it, naming what was wrong and, for a method it does not serve, the
tools it does. The process shall exit 0 when its input ends, and 2 when it cannot serve at all, saying why
on standard error.

### Scenario: a-client-initializes-and-calls
- Given: a client that starts `madarch mcp --repo` with a path and writes one `initialize` line
- When: it sends `tools/list` and then `tools/call` for `get_symbol`, and closes its input
- Then: each answer is one line of standard output carrying the request's id, the call's content is the tool's answer as text, and the process exits 0

### Scenario: an-unserved-method-is-refused-on-standard-output
- Given: a server on a checkout
- When: a client sends a method the server does not serve
- Then: the answer is a JSON-RPC error on standard output that names the served tools, and the process keeps serving

## Requirement: working-tree-freshness — The graph is the graph of the commit at HEAD, and a file the working tree changed is read again before an answer that touches it
The base graph shall be the graph of the commit at `HEAD`, built by the repository's own extraction and
kept in the repository's state folder, so a start whose kept graph is that commit reads it instead of
building it, and a start that finds another commit moves the graph to it. The working tree's files that
differ from `HEAD` — modified, added, deleted and renamed, as git reports them — shall be read again
before an answer that touches them: a symbol added by an uncommitted edit shall be found, an edited
declaration's own text shall be the working tree's text, a file deleted without a commit shall be gone
from the answers of its symbols, and a document edited without a commit shall be searched and read as
edited. Nodes read from uncommitted files shall be marked uncommitted wherever an answer names them.
Every answer shall name the repository, the commit, the branch, the date of the commit and the files that
differ from it, and a file read again for that answer shall be named there too.

### Scenario: an-uncommitted-edit-is-answered-from-the-working-tree
- Given: a server serving a checkout at `HEAD`, and a file the working tree edits without a commit
- When: a client asks for a symbol the edit added and for one whose declaration the edit changed
- Then: both answers come from the working tree's text, they name the edited file in the answer's source and as read again, and the node they name is marked uncommitted

### Scenario: a-deleted-file-is-gone
- Given: a server serving a checkout whose working tree deletes a file that `HEAD` holds
- When: a client asks for a symbol of that file
- Then: the answer is the tool's no-such-symbol refusal, and the answer's source names the deleted file

### Scenario: an-answer-names-its-revision
- Given: a checkout whose `HEAD` is a commit of branch `main` and whose working tree has changed one file
- When: any tool answers
- Then: the answer's source carries the commit, the branch, the commit's date and the changed file with its status

## Requirement: call-journal — Every call is journaled with what it cost and what it saved
The server shall record one row per call in a journal kept beside the graph: the time, the tool, the
arguments, the size of the answer in bytes, the files it read again, an estimate of the file reads the
answer saved — the files whose text the answer carried or named as its evidence — the time it took and
the revision it was read at. `madarch mcp --journal` shall print that journal's summary without starting
a server: per tool the number of calls, the files read again, the answer bytes and the file reads saved;
the totals; and the last call.

### Scenario: every-call-is-recorded
- Given: a server serving a checkout
- When: a call is answered
- Then: the journal holds one more row carrying that tool, its arguments, the answer's bytes, the files read again and the file reads the answer saved

### Scenario: the-journal-is-printed
- Given: a state folder whose journal holds calls of more than one tool
- When: `madarch mcp --journal --repo` with a path is run
- Then: it prints one line per tool with its calls, files read again, answer bytes and reads saved, the totals and the last call, and no server starts

## Requirement: command-and-registration — The command serves a checkout by path, and the guide says how a client registers it
`madarch mcp` shall serve the checkout of the current folder, and `--repo` with a path the checkout it names;
`--store` with a path shall keep the graph and the journal in a folder of the caller's choosing, and
`--journal` shall print the summary instead of serving. A path that is not a checkout shall be refused
with exit 2, naming the folder and what git said. The administrator guide shall say how to register the
command with an MCP client: the command line a client runs, the path it serves, and that the server is
read-only.

### Scenario: the-command-serves-the-current-folder
- Given: a checkout, and a shell whose working folder is inside it
- When: `madarch mcp` starts and a client asks for one of its tools
- Then: the answer comes from that checkout, and its source names the checkout's absolute path

### Scenario: a-path-that-is-not-a-checkout-is-refused
- Given: a folder that git does not know
- When: `madarch mcp --repo` with a folder git does not know is run
- Then: the command exits 2 with a message naming the folder and what git said, and no server starts

## Requirement: refresh-resolution — A changed file is read again with what it imports and by every producer the fill runs
The files a refresh reads shall be the files git reports as changed, the import closure of the changed code
files — the unchanged files whose declarations a call in a changed file is resolved against — and the
manifests that name a file's module. Every extractor the fill runs shall read that set, not the code pass
alone: a SQL migration or an OpenAPI document changed without a commit shall be read again, and the table
or operation it adds or drops shall answer or stop answering in the next call. Only facts whose span is a
changed file shall be kept; the closure is read to resolve, never to answer.

### Scenario: an-edited-caller-keeps-its-unchanged-callee
- Given: a server serving a checkout, and an uncommitted edit that adds a function to a file which calls a function of another file
- When: a client asks for the added function and traces its flow
- Then: the answer names the added declaration, the trace reaches the unchanged callee, and the call the file made before the edit is still its call

### Scenario: a-migration-changed-without-a-commit-is-read
- Given: a server serving a checkout, a migration that `HEAD` does not hold and one whose table it drops
- When: a client asks `get_context` for the added table and then for the dropped one
- Then: the added table answers, and the dropped table is the tool's no-such-entity refusal, both naming the changed file in their source

## Requirement: source-provenance — A fact is hidden because the base graph read it from a changed file, not because its key looks like a path
The base graph's facts shall be hidden by their provenance — the span the base graph recorded for the fact
— so a table, an operation or a section whose file changed is hidden though its key names no path, and a
fact read from an unchanged file is kept. Both ends of an edge shall be resolved through the working-tree
layer: an edge whose site is a changed file is the working tree's, and an edge whose other end stands in a
changed file that no longer declares it is no edge, so a deleted symbol is never named as a callee.

### Scenario: an-operation-removed-from-a-contract-stops-answering
- Given: a server serving a checkout whose OpenAPI document `HEAD` holds, rewritten without a commit
- When: a client asks for the operation the rewrite removed
- Then: the answer is the tool's refusal, and the operation the rewrite kept still answers

### Scenario: a-deleted-callee-is-no-callee
- Given: a server serving a checkout whose working tree deletes a file that `HEAD` holds
- When: a client asks for a function of the unchanged caller and traces its flow
- Then: neither answer names a declaration of the deleted file, and the caller answers from the working tree's text

## Requirement: cold-start — A start answers at once, reuses a graph that exists, and builds a cold graph within a stated memory bound
The server shall answer `initialize`, `ping` and `tools/list` as soon as it reads them, without waiting for
a graph, and a tool call made while the graph is building shall be answered with a `graph building` answer
whose source says it is building rather than by making the client wait. A start whose madarch home holds a
product fill's graph for the same repository and commit shall serve that graph, copying it into the state
folder and saying that it reused it, without extracting the repository again. A cold build shall be
bounded: it streams the tree file by file, holds one file's facts at a time, and reads at most 700 code
files, which this machine measures at 2 668 MB for 898 files and killed at 3 164 MB for the checkout's
1 041; a tree beyond the bound shall be refused with the count, the bound, the measurement and what to
serve instead, never built until the machine kills it.

### Scenario: a-product-graph-is-reused
- Given: a madarch home whose product knowledge store holds the graph of a repository at its `HEAD`
- When: `madarch mcp` serves a folder that holds no graph
- Then: it says it reused the graph, the state folder holds the copied graph, and a tool answers from it without extracting the repository again

### Scenario: the-handshake-answers-before-the-graph-is-built
- Given: a server whose graph is still building
- When: a client sends `initialize`, `tools/list` and then `tools/call`
- Then: the first two answer at once, and the call's answer says `graph building` and names the repository as building in its source

### Scenario: a-tree-beyond-the-bound-is-refused-with-what-to-serve
- Given: a checkout whose code files exceed the cold build's bound
- When: `madarch mcp` serves it with no graph in its state folder
- Then: the command exits 2 with a message naming the count, the bound, the measurement and the store to serve instead, and no extraction starts

## Requirement: source-on-every-answer — Every result names its revision, refusals and failures included
Every tool result shall carry the source — the repository, the commit, the branch, the commit's date, the
files that differ from `HEAD` and the files read again — stamped in one place for the whole call, so a
refusal, a bad argument and a failed refresh name the same revision an answered call does. A failure of the
refresh shall be answered as that call's own error, with its file, line and full path, and the server shall
keep serving: the next call reads the working tree again and answers.

### Scenario: a-refusal-names-its-revision
- Given: a server serving a checkout at a commit whose working tree is clean
- When: a client asks for a symbol the graph does not hold and then calls a tool with no argument
- Then: both results are errors and both carry the repository, the commit and an empty list of changed files

### Scenario: a-failing-refresh-keeps-the-stream
- Given: a server serving a checkout whose working tree holds a file the reader cannot read
- When: a client calls a tool, and after the file is removed calls it again
- Then: the first call is answered with an error naming the file and its full path, the process keeps serving, and the second call answers

## Requirement: journal-accounting — The journal keeps measured reads, answered questions and estimated evidence apart
The journal shall record, per call, the reads the tools measured they avoided, whether the call answered
its question, and an estimate of the files the answer stands on; `--journal` shall print the three apart,
per tool and in total. Two identical calls shall be counted as two calls and one saving: a saving is
counted once it is new, so no repeated call reports a read nobody avoided.

### Scenario: repeated-calls-are-counted-once
- Given: a state folder whose journal holds one call and then two identical calls
- When: `madarch mcp --journal` prints the summary
- Then: the tool's calls count every call, its distinct calls count the repeated pair once, and the reads avoided rise by what the pair saved, not twice

### Scenario: measured-and-estimated-are-separate
- Given: a journal holding an ambiguous lookup that answered no question
- When: its summary is read
- Then: the lookup's reads avoided are zero, its questions answered are zero, and its evidence files count the files its candidates stand on

## Requirement: folder-lock — One folder serves one process, and the lock is taken atomically and held until the database is closed
The state folder's lock shall be created atomically, so two processes starting together cannot both believe
they hold it, and the file shall name its holder. A second process shall be refused with an error naming
the lock file and the holder, and a lock whose holder is gone shall be taken over once. The lock shall be
held until the graph's database is closed and dropped by its holder alone.

### Scenario: a-second-server-on-one-folder-is-refused
- Given: a folder whose lock one live process holds
- When: another process takes the same folder's lock
- Then: it is refused with an error naming the lock file and the folder as already served, and after the holder drops the lock the folder can be taken again
