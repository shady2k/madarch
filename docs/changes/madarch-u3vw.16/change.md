# A file's text: from git by blob id, one mechanism for the page and the agent

Change: madarch-u3vw.16
Base: b43b57ff88f525024961bdd2f855531643b3dc44
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

Verified end to end on this machine with bun 1.4.2 (the pin the bundled closures carry): a throwaway product holding a
YAML, a TypeScript file, a long Markdown document and a PNG was filled with disk and git, and each file's page showed its
text — the YAML and the .ts as source with line numbers and no horizontal overflow at the reading width, the .md rendered
(100 headings) and as source, the PNG as «двоичный файл: текста в нём нет». Shots at 1150, 1920 and 390, light and dark:
`test/u3-shots.test.ts` (`MADARCH_U3_SHOTS=1`), images under the walk's own output folder.

## Out of scope
The code-search index for agents (filed apart) and the file page's facts and relations, which stand as they are.

## Rationale
One mechanism, content-addressed, keeps the text at the revision the facts describe and keeps engine code out of product
files.

## Changes to requirements
- product-wiki/repositories: a file's page shows the file's text, read by the blob id the graph holds and served by the git plugin through the plugin host.

## Preserved contracts
- product-wiki/serve: test
- views/one-view: test

## Coverage
- product-wiki/repositories: test
- product-wiki/serve: test
- views/one-view: test

## Where it is seen
Kind: screen
Place: a code file's page under a filled product, section «Текст», for example /products/sample/e/files/code.file-1
Mockup: docs/prototypes/file-text.html
1. The page asks for the file's lines and shows them: a Markdown file rendered by the documents' own component with a Rendered / Source switch, every other text file as a line-numbered source that wraps or runs long, a binary file as one sentence.
2. «Скачать целиком» reads the whole blob through the same read.
