# A file's text: from git by blob id, one mechanism for the page and the agent

Change: madarch-u3vw.16
Base: ef989dae1b707459a69421ca1d4bdee54cd6904b
Tasks: madarch-u3vw.16
Kind: behavior

## Intent
The owner's walk found a file page with no text (2026-11-15, after the first agent fill: «Почему не видно содержимое
файла?»), and decided the one mechanism: the graph holds each code.file's git blob id at the fill's pinned revision and
never the text; the text is read by (repository, blob id) from git's object store through the git plugin in the plugin
host, for the page and for the agent's file reads alike. Decision 0037 records it.

Implemented: `madarch.plugins/3` adds the host's read of a blob, answered by the git plugin in its sandbox; the store's
`file_text_request` table (prepared with the store's schema) carries a page's request to the plugin host and its answer
back; `/api/source` answers a code file by the blob id the graph holds, line ranges included; the code-file template's
«Текст» section renders Markdown with the documents' own component and a Rendered / Source switch, and every other text
file as a line-numbered source at the page's width with soft wrap and chunked ranges; the agent's ACP file reads ask the
same host read by blob id instead of a graph-held text; the disk plugin no longer publishes `content` and the catalogue
drops the field.

Not verified on this machine: the bundled plugin closures are pinned to bun 1.4.2 and this box runs 1.4.4, so no plugin
fill can run here (the same on main), and the screenshots of a filled product could not be taken.

## Out of scope
The code-search index for agents (filed apart) and the file page's facts and relations, which stand as they are.

## Rationale
One mechanism, content-addressed, keeps the text at the revision the facts describe and keeps engine code out of product
files.

## Changes to requirements
- product-wiki/front-matter: a file's page shows its text, read by blob id, as the decision states.

## Preserved contracts
- graph-queries/reads: pages read the graph; the text arrives by the store channel, never by a file read in the api process.
- views/one-view: pictures and facts are unchanged.

## Coverage
- product-wiki/front-matter: test

## Where it is seen
Kind: screen
Place: a code file's page under a product, section «Текст»
1. A Markdown file shows rendered with a Rendered / Source switch.
2. Another text file shows its source at the page's full width, with line numbers and a soft-wrap switch.
3. A binary file says it has no text.
