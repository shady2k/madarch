# The release binary carries the vendored archify renderer, and a failed picture reads as a sentence

Change: madarch-64o5.97
Base: 8b3c73cb7bfa96b18c8c6f98e7f3ee2d6590d65c
Tasks: madarch-64o5.97
Kind: no-behavior

## Intent
The owner's walk, a file page's «Вокруг», renderer archify, madarch 0.3.0 built by scripts/build-binary.ts: the diagram
area showed raw JSON, «the vendored archify renderer is missing» at a $bunfs path. Two causes, both in where the release
reads what it carries: the embed root was read through `Bun.main`, which in a binary built with a second entry (the read
worker) names that worker's file, so the embedded wiki app was never found; and the renderer was run where it lay, a
bundle path a child process cannot open, without the vendor assets it reads beside itself.

The release root is now the bundle's own mount ($bunfs/root), the vendor folder is laid beside the document before the
renderer runs, and the build's own smoke draws one archify diagram from a fresh draft's catalogue entity. A renderer that
cannot draw answers one sentence in the reader's language, never the server's JSON and never a bundle path; the cause
goes to the server's log.

## Out of scope
The renderers' colours and sizes (madarch-64o5.96) and the layout width (madarch-64o5.99).

## Rationale
Archify is kept by the owner's decision and must work in what users install; the source tests could not see the bundle's
layout, so the build now reads it the way an installed binary does.

## Changes to requirements
None.

## Preserved contracts
- views/one-view: the same graph revision answers the same picture bytes; only where the renderer runs from changes.
- product-wiki/app: the binary still serves the wiki app it embeds.

## Coverage
- product-wiki/app: test
- views/one-view: test

## Where it is seen
Kind: screen
Place: a file's or kind's entity page under a product, section «Вокруг», renderer «archify»
1. The archify tab draws the diagram, in the binary built by scripts/build-binary.ts as in a source run.
2. A picture that cannot be drawn shows one sentence in the reader's language where the diagram would stand.
