# Model Context Protocol server

Capability: mcp-server

## Purpose
A person's own agent reaches a repository's graph from the editor they already use: `madarch mcp` serves
the store the one fill publishes over the Model Context Protocol on standard input and output. The five
tools of this step read the repository's normal form — its files, one file's facts and dates, a file's
history, one commit and the repository itself — and the seven tools of decision 0032 for the later steps
are served beside them and answer that their step has not run, naming it. Every answer names the as-is
commit it is true at, the paths the working tree changed since it, and every gap the fill recorded. The
server writes nothing: no file of the checkout, no page and no store row.

## Requirement: record-tools — The repository's normal form is served as five read-only tools
The server shall serve `list_files`, `get_file`, `get_file_history`, `get_commit` and `get_repository`,
each read from the store's record tables alone and never from a file of the checkout. `list_files` shall
answer one page of files with a path prefix, a language and the previous page's `next`, in code point
order of the paths, each row naming the path, mode, blob hash, bytes, lines, text or binary form and the
language with every candidate. `get_file` shall answer one file's mode, blob hash, bytes, lines, form,
language with every candidate, the commit and author that created it and the one that last modified it,
its commit count and its authors. `get_file_history` shall answer the commits that touched a path,
following renames, newest first, each with the change, the lines added and removed and the path it came
from, paged by the row it ended on. `get_commit` shall answer a commit's hash, author, author and commit
dates with their UTC offsets, subject, parents and every changed path. `get_repository` shall answer the
repository's name, url, default branch, as-is commit, the counts of files, commits and folders the store
holds, and every gap. A page bound shall cut an answer to the tool's own bound and never refuse a larger
one; a file or a commit the as-is commit does not hold shall be refused by name.

### Scenario: five-tools
- Given: a store of one repository at one commit
- When: a client sends `tools/list`
- Then: the listing holds `list_files`, `get_file`, `get_file_history`, `get_commit` and `get_repository` with their schemas, and no tool that writes

### Scenario: list-files-pages
- Given: a repository of four files whose names sort `README.md`, `assets/picture.bin`, `src/a.ts` and `src/nested/c.ts`
- When: `list_files` is called with a limit of two and then with the `next` it answered
- Then: the first page holds `README.md` and `assets/picture.bin` with `assets/picture.bin` as `next`, and the second holds the two below `src/`; a prefix of `src/nested` keeps that folder's file alone

### Scenario: file-facts
- Given: a file created in one commit and edited in another
- When: `get_file` is called for it
- Then: it states the mode, blob, bytes, lines, form, the language with every candidate, the creating commit and author, the modifying commit and author, the commit count and the authors

### Scenario: history-follows-a-rename
- Given: a file renamed with nothing else in its commit and then edited
- When: `get_file_history` is called for its path
- Then: the edit, the rename naming the path it came from, and the add stand newest first, and a one-row page's `next` is the row it ended on

### Scenario: commit-facts
- Given: a commit with one parent that renamed a file and modified another
- When: `get_commit` is called for it
- Then: it states the hash, author, both dates with their offsets, subject, parents and both changed paths with their changes and counts

### Scenario: repository-facts
- Given: a repository the fill read at one commit
- When: `get_repository` is called
- Then: it states the name, url, default branch, as-is commit, the counts and the gaps, and `steps` says which of the fill's steps have run

## Requirement: later-steps — A tool whose step has not run names the step, and never answers an empty page
The server shall serve the seven tools of decision 0032 beside the five, and a tool whose step this fill
does not run shall answer with an error whose code is `step-not-run` and which names the step
(`syntax`, `semantic-resolution` or `document-index`) and the steps the fill runs — never an empty result
a client would take for a repository that holds nothing. A store that holds a temporal reading of the
as-is commit shall serve those tools from it, and a store that holds no reading of this commit shall serve
them no reading at all: an older commit's rows shall not be served under the new commit's name.

### Scenario: the-seven-name-their-step
- Given: a store a fill wrote with the tree and the history records and no temporal reading
- When: a client calls `get_symbol`, `trace_flow` or `get_page`
- Then: each answer is an error naming the step that has not run, and its source still names the as-is commit

### Scenario: a-store-with-a-reading
- Given: a store that holds a temporal reading of this commit
- When: a client calls a tool of those seven
- Then: the answer is read from that reading, with no step-not-run error

## Requirement: source-on-every-answer — Every answer names the as-is commit and what the checkout changed
Every answer, a refusal and a failure included, shall name the repository, the as-is commit the store's
records state, the branch, the checkout's HEAD when it is not that commit, and every path the working tree
changed since it, and every gap the store recorded for the repository.

### Scenario: an-answer-names-its-commit
- Given: a checkout whose working tree changed one file since the filled commit
- When: `get_repository` is called
- Then: its `source` names the as-is commit and the changed path, and its `gaps` is the repository's own list

## Requirement: command — The command serves a checkout, and keeps its journal
`madarch mcp` shall serve the checkout named by `--repo` (the current folder when it is left out) with the
store resolved by the one resolver (`productStoreFolder`), filling it through the one runner when the
store does not hold the checkout's HEAD. A second process shall not serve a store another holds: a lock
taken atomically shall name the holding process and refuse the second by name, and the lock shall be held
until the database is closed. Every call shall be journaled with the tool, its arguments, the size of its
answer and the files it covered, and `--journal` shall print what the served calls cost. A store folder
that cannot be named and a start that fails shall be answered on standard error with the command's own
exit code.

### Scenario: the-command-serves-a-checkout
- Given: a checkout with a commit and an empty madarch home
- When: a client starts `madarch mcp` with the checkout's path and asks for `get_file`
- Then: the store is filled through the one fill, the answer names the as-is commit and the file's facts, and standard output carries only protocol lines

### Scenario: one-store-one-lock
- Given: a store a server is serving
- When: a second `madarch mcp` starts on the same checkout
- Then: it is refused by name, naming the process that holds the store
