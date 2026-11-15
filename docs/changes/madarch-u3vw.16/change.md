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

This change record stands for the decision only: the implementation needs the plugin protocol's read operation
(`madarch.plugins/3`), the store channel from the api role to the plugin host, the template's «Текст» section with the
Rendered / Source switch, the range reads and the agent's switch to the blob path. Those are not in this commit and the
task stays open until they are.

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
