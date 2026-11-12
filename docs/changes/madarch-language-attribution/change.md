# Parser-backed language attribution for unknown text files

Change: madarch-language-attribution
Base: 7655873c08b9cda8f1ed24d229beba077d62b777
Tasks: madarch-64o5.18
Kind: behavior

## Intent
Read a file's language from an established dataset or a successful parser, never
from extension/name guesses hand-written into the engine. The existing Linguist
9.5.0 dataset remains the primary source; unknown text may be identified by JSON.parse.

## Out of scope
- Picking an arbitrary language when Linguist names multiple candidates.
- Adding a list of source-map, lock or Flow extensions to the code.

## Changes to requirements
- product-wiki/file-language-source: recognised data or parser-backed language attribution.

Complete proposed capability: `capabilities/product-wiki.md`.

## Preserved contracts
- product-wiki/catalog: test/knowledge-catalog-view.test.ts

## Coverage
- product-wiki/catalog: test
- product-wiki/file-language-source: static, test, mutation, review

## Where it is seen
Kind: screen
Place: By-language fact on a developer home
Mockup: docs/prototypes/madarch-64o5.19/sidebar.html

1. Fill text files whose names Linguist does not recognise.
2. Valid JSON is attributed to JSON, regardless of name; invalid JSON remains unknown.
3. Linguist ambiguity and explicit git attributes remain authoritative.

## Blocking questions
None.
