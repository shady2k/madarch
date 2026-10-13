# Discussion message contract design

Task: madarch-y781.1.1
Base: b985d519a3107d92edc3e6fa358d4834277e7021

## Outcome and constraints

Publish the owner-approved comment-message layout as a product-repository contract. This prefactor does not implement discussion UI, writes, replies/resolution, indexing or browser tests. The parent epic fixes one Markdown file per message at `comments/<thread ULID>/<message ULID>.md`, front matter for author, time, thread, anchor quote and 32-character context, document path, source commit and status, and source markers `<!--c:<id>-->…<!--/c:<id>-->`. Distinct ids may overlap. No markers is a lost anchor; a missing or mismatched pair is refused with source file and line.

## Existing shape

The product repository publishes TypeBox sources from `src/product/schema.ts`, generates stable JSON in `schema/` through `bun run schemas`, and checks conformance examples in `examples/contract/` through `bun run contract:check`. The registry contract is versioned both in the input (`contract: 1`) and its `$id` (`.../schema/v1/product-registry.schema.json`). Generic document fields have their own published schema but are unversioned and do not parse YAML front matter. Product-document cases and registry cases are JSON case suites, and checker mismatches name the cases file and source line. The capability spec is `docs/system/capabilities/product-repository.md`; behavior proposals use `docs/changes/<change>/change.md` and a complete capability copy.

## Options

1. Extend the generic document-fields schema and parser for comment front matter and markers. This reuses a familiar schema but couples discussion metadata to fields read from ordinary `docs/` pages and changes existing parser semantics.
2. Add a dedicated, versioned discussion-message schema, a small Markdown/front-matter and marker validator, and pinned cases under the existing contract checker. This keeps comment metadata separate from generic wiki document fields and follows the registry's versioned schema + conformance pattern.

## Decision

Choose option 2. Add one TypeBox schema source and generated published schema with `$id` `https://github.com/shady2k/madarch/schema/v1/product-discussion-message.schema.json`. Use `contract: 1` in message front matter as well as the versioned `$id`, matching the registry's explicit two-sided versioning. The front matter includes `author`, `time`, `thread`, `anchor`, `document`, `sourceCommit`, `status`, and `contract`. An anchor is either `{kind: page}` for an intentional page-level comment, or `{kind: selection, quote, before, after}` for a selected range (context fields hold at most 32 Unicode code points). This distinguishes an intentional page-level comment from a selected range whose markers were later deleted. Validate ULID directory/file ids, and require the thread directory id to match the `thread` field; the filename ULID is the message identity. Treat the body after front matter as message Markdown. Use `open` and `resolved` as the message status vocabulary, without adding reply/resolve interactions.

Keep marker validation separate from message-file parsing. Scan source Markdown for paired `c` marker tokens, require matching ids and proper nesting per id, allow interleaved/overlapping pairs with different ids, and report each malformed marker at its 1-based source line. For `kind: selection`, both marker tokens absent means a lost anchor and is valid. A `kind: page` anchor has no marker pair by design and is accepted as an intentional page-level comment, never classified as lost. Cases pin valid metadata, page-level comments, path/ULID checks, valid and overlapping markers, lost anchors, one-sided markers, and mismatched ids. Only contract/document validation and tests needed for these cases are in scope.

## Quality scenarios

- Given a valid message at a ULID path with matching `contract: 1`, the checker accepts it; for malformed metadata it reports the message file and line.
- Given Markdown with properly paired, possibly overlapping distinct-id markers, the checker accepts it; with one-sided or mismatched markers it refuses and names source path and line; with both absent for `kind: selection` it accepts the lost-anchor state; `kind: page` is accepted without markers as intentional, not lost.
- Regenerating schemas produces the committed schema exactly, and every pinned case runs deterministically without network or outside checkout.

## Design review

The first review found that the contract did not distinguish a page-level comment (approved in the parent design) from a lost selection anchor. The schema now uses a discriminated anchor: `kind: page` for intentional no-selection comments and `kind: selection` with quote/context for selected text. A pinned page-level case is added. The reviewer found no other material contradictions.

## Consequences

The schema version is independently published as version 1 and must be notified to the skill set when this change lands. The main `docs/` document-field reader remains unchanged. The parser is intentionally a contract validator, not a comment writer or renderer. Validation rules for marker crossing/nesting beyond the approved distinct-id overlap case remain constrained to preserving valid Markdown and may be narrowed during implementation if parser behavior requires it; any material conflict with the approved cases stops for coordinator input.
