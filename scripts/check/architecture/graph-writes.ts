/**
 * The graph's rows are written from one module (decision 0033, item 3; the review of stage 1, finding 10, and of stage
 * 1c): `node`, `edge`, `entity`, the opinion tables the contract generates (`k_…`, `e_…` with their table's digest) and
 * `opinion_id` are written by `src/graph/write.ts` alone, and its own schema modules (`contract.ts`, `one-graph.ts`) are
 * the only others that may state DDL about them. A statement that inserts, updates or deletes those rows anywhere else —
 * a schema-qualified name included — is a second writer, and this rule names it with its line. No module under `scripts/`
 * is exempt except the one file listed below, which states the pattern itself.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { moduleSet } from './sources.js';
import type { ArchitectureViolation } from './violation.js';

/** The modules that may write the graph's rows, besides the writer: the schema's own DDL and the contract's tables. */
const ALLOWED = new Set(['src/graph/write.ts', 'src/graph/one-graph.ts', 'src/graph/contract.ts']);

/** The one file under `scripts/` this rule may name: it holds the pattern and the message. */
const THE_RULE_FILE = 'scripts/check/architecture/graph-writes.ts';

/** The graph's own tables, a generated opinion table (`k_file_1a2b3c4d`), and the sequence every opinion's id comes from. */
const TARGET = String.raw`(?:(?:[a-z_][a-z0-9_]*)\."?)?(node|edge|entity|opinion_id|[ked]_[a-z0-9_]+_[0-9a-f]{8})`;

/** A statement that writes one of the graph's own tables or its sequence, named literally. */
const WRITE = new RegExp(String.raw`\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+${TARGET}\b`, 'giu');

/** A statement whose written table is built at run time from a contract's or a kind's table. */
const WRITE_DYNAMIC = /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+\$\{[^}]*(?:\b(?:kind|vertex|edge)\.table\b|GIT_TABLES\.[a-z_]+)\}/giu;

/** The engine's dictionaries, which the record store interns: a table, and no entity's opinions. */
const DICTIONARY = /GIT_TABLES\.(?:blob|path|language)\}/u;

/** Every module that writes a graph row without the one writer, with the line the statement stands on. */
export function graphWriteViolations(root: string): ArchitectureViolation[] {
  const out: ArchitectureViolation[] = [];
  for (const file of moduleSet(root).modules) {
    if (ALLOWED.has(file) || file === THE_RULE_FILE || (file.startsWith('src/adapters/schemas/graph') && file.endsWith('.ts'))) continue;
    const text = readFileSync(join(root, file), 'utf8');
    for (const match of text.matchAll(WRITE)) {
      const line = text.slice(0, match.index ?? 0).split('\n').length;
      out.push({ rule: 'graph-writes-in-writer', file, line, symbol: match[1] ?? null });
    }
    for (const match of text.matchAll(WRITE_DYNAMIC)) {
      if (DICTIONARY.test(match[0])) continue;
      const line = text.slice(0, match.index ?? 0).split('\n').length;
      out.push({ rule: 'graph-writes-in-writer', file, line, symbol: 'a table named at run time' });
    }
  }
  return out;
}
