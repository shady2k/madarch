# Publish the manifest catalogue before Fill

Change: madarch-64o5.9
Base: 406d73474033a58587083e8a9458825b7e94b3be
Tasks: madarch-64o5.9
Kind: behavior

## Intent
Startup validates the product manifests and publishes their catalogue through the one graph writer.
The catalogue and workflow dependency pages and MCP kinds are available before Fill. Only Fill reads
repository content through plugins and agents.

## Rationale
Owner direction, 2026-11-11 (translated): write manifest entities into the graph at startup;
validate the manifests at that same step, and refuse startup when validation fails.
This refines the old empty-before-Fill rule: before Fill the graph holds manifest declarations only.

## Out of scope
- Schema-preparation ownership and migrations (madarch-8bdc.10).
- Running plugins or agents during startup.
- Reading repository content before Fill.

## Changes to requirements
- product-wiki/manifest-catalogue-before-fill: startup validation, manifest publication, graph-only
  catalogue and dependency reads, MCP kinds, and last-valid-catalogue handling during edits.

Complete proposed capability: `capabilities/product-wiki.md`.

## Preserved contracts
- product-wiki/catalog: every manifest kind remains catalogue data.
- product-wiki/workflows: the existing workflow validation and dependency derivation remain shared.
- product-wiki/pages: content pages remain unavailable until Fill reads them.

## Coverage
- product-wiki/manifest-catalogue-before-fill: static, test, mutation, review
- product-wiki/catalog: test
- product-wiki/workflows: test
- product-wiki/pages: test

## Where it is seen
Kind: command
Place: `madarch start`, the product wiki catalogue and dependency pages, and MCP kinds

1. Start a valid product that was never filled and open its catalogue and dependency graph.
2. Ask MCP for kinds; every manifest kind is listed without a fill.
3. Start with an invalid manifest: full file paths and lines are printed and no wiki is served.
4. Edit a running product's manifest: valid edits appear; invalid edits report errors and retain the
   last valid catalogue.

## Blocking questions
None.

## DONE WHEN
A never-filled product exposes its graph-backed catalogue and dependencies and MCP kinds without
repository content; an invalid manifest refuses startup; live valid edits replace the catalogue and
invalid edits retain it and report full-path, line-numbered diagnostics.
