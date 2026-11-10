/**
 * The graph's rows are written from one module (decision 0033, item 3; the review of stage 1, finding 10): `node`,
 * `edge`, `entity` and every entity table are written by `src/graph/write.ts` alone, and its own schema modules
 * (`contract.ts`, `one-graph.ts`) are the only others that may state DDL about them. A statement that inserts, updates
 * or deletes those rows anywhere else is a second writer, and this rule names it with its line.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { moduleSet } from './sources.js';
import type { ArchitectureViolation } from './violation.js';

/** The modules that may write the graph's rows, besides the writer: the schema's own DDL and the contract's tables. */
const ALLOWED = new Set(['src/graph/write.ts', 'src/graph/one-graph.ts', 'src/graph/contract.ts']);

/** A statement that writes one of the graph's own tables. */
const WRITE = /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+["']?(node|edge|entity)["']?\b/giu;

/** Every module that writes a graph row without the one writer, with the line the statement stands on. */
export function graphWriteViolations(root: string): ArchitectureViolation[] {
  const out: ArchitectureViolation[] = [];
  for (const file of moduleSet(root).modules) {
    if (ALLOWED.has(file) || !file.startsWith('src/')) continue;
    const text = readFileSync(join(root, file), 'utf8');
    for (const match of text.matchAll(WRITE)) {
      const line = text.slice(0, match.index ?? 0).split('\n').length;
      out.push({ rule: 'graph-writes-in-writer', file, line, symbol: match[1] ?? null });
    }
  }
  return out;
}
