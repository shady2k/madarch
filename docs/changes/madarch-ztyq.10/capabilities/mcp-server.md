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
