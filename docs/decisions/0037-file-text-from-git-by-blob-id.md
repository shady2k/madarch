# Decision 0037: a file's text is read from git by blob id

Status: accepted
Date: 2026-11-15
Deciders: the owner (walk notes of 2026-11-15, madarch-u3vw.16)
Extends: 0034 (one graph schema), 0035 (extraction plugins)

## Context
The graph holds each `code.file` of a filled repository with facts the disk plugin read from the pinned revision:
path, mode, blob id, bytes, form, lines, language. The wiki's pages read the graph and nothing else (decisions 0034 and
0035). The file page has no text, and the owner's walk of 2026-11-15 found the content missing altogether.

Two mechanisms were considered and one was rejected by the owner: storing the text in the graph (rejected: «у нас должен
быть какой-то единый механизм. Или мы все берем из графа, или мы идем и пытаемся читать из источника»), and reading the
working copy at page time (rejected: a second source, and text that may not be the revision the facts describe).
The owner chose: «Да, из git по хэшу».

## Decision
1. The graph holds, per `code.file`, the git blob id of its content at the fill's pinned revision — the `blob` field the
   disk plugin already publishes — and never the text itself. The `content` field is removed.
2. A file's text is read one way only: by (repository, blob id) from git's object store, through the git plugin in the
   plugin host. No engine code outside the plugin host reads product files (0035). Content-addressed, so the text always
   matches the facts' revision; the working copy is never read.
3. No size cap and no second path: a page asks for line ranges and virtualises; a file past a large display bound shows
   its start and «скачать целиком» through the same read. The agent plugin's file reads go through the same blob-id read,
   so the page and the agent share one mechanism.
4. Search over code for agents (MCP) is a separate index a plugin builds from the same blobs, with what it skips named
   and why; it is filed apart.
5. Cost accepted: the text is available while the repository is connected on the machine — already a condition of the
   fill.

## Consequences
- The plugin protocol carries the read: `madarch.plugins/3` lets the host ask the plugin, in the plugin's own sandbox, for
  one blob's range, and the plugin answers text, line count, byte count and whether it is text at all. The git plugin
  implements it with `git cat-file blob` on the repository the sandbox bound read-only; the host keeps one reader session
  per (plugin, repository) and ends it when idle.
- The api role serves pages and never reads git: a page's text request is a job on the store's one pg-boss queue, in a
  `file-texts` queue prepared with the fills, which the fill role claims and settles with the bytes as the job's result;
  the api reads that result back through the same queue. There is one queue and no second store (the owner,
  2026-11-15).
- The agent's file reads call the same host read (`readBlobThroughPlugin`), so a page and an agent get one mechanism.
- The page asks for ranges, so a large file costs one range, not a whole file; the host bounds a single read by bytes and
  answers the rest only when asked.
- The `content` field leaves the catalog, the disk plugin's contract and every reader of it; the agent's reads move to
  the blob path.
