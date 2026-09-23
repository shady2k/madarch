# 0008. TypeScript on Bun, with Bun-specific APIs confined to adapters

Status: accepted
Date: 2026-09-24

## Context and problem
The core is a model-and-rules engine served over HTTP and MCP, with schemas
published for plugins in other languages.

## Considered options
1. Go: simple, fast builds; weaker types for the many kinds of facts and nodes.
2. Rust: strongest types; slower iteration.
3. TypeScript on Node LTS.
4. TypeScript on Bun.

## Decision
TypeScript on Bun. Discriminated unions with exhaustive checks cover the model's
many variants; one schema source (TypeBox) yields types, runtime validation and
the published JSON Schema; the MCP reference SDK, Mermaid and LikeC4 are in the
same ecosystem. Bun adds built-in TypeScript, tests and SQLite, fewer
dependencies and a single-binary option. Bun-specific APIs (`Bun.serve`,
`bun:sqlite`) appear only in adapters; the core uses Web APIs and `node:`
modules both runtimes support.

## Consequences
- Types are erased at runtime: every boundary (webhooks, facts, YAML) is validated.
- npm supply chain is a risk: minimal dependencies, a lockfile, audits.
- Revisit and fall back to Node LTS if Mermaid rendering, the LikeC4 packages,
  the query engine binding or long-running stability fail under Bun and an
  update does not fix it.
