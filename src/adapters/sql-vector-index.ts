import { byCodePoint } from '../model/order.js';
import type { OperationGate } from '../query/operation-gate.js';
import type { SqlExecutor, SqlQueryDriver } from '../query/sql-driver.js';
import type { AsyncVectorIndex, VectorDistanceMetric, VectorMatch, VectorRecord, VectorSearchInput } from '../vector/types.js';

export const VECTOR_SCHEMA = [
  `CREATE EXTENSION IF NOT EXISTS vector`,
  `CREATE TABLE IF NOT EXISTS vector_spaces (
    space TEXT PRIMARY KEY,
    dimensions INTEGER NOT NULL CHECK (dimensions BETWEEN 1 AND 2000)
  )`,
  `CREATE TABLE IF NOT EXISTS vector_items (
    source TEXT NOT NULL,
    space TEXT NOT NULL REFERENCES vector_spaces(space),
    item_id TEXT NOT NULL,
    embedding vector NOT NULL,
    PRIMARY KEY (source, space, item_id)
  )`,
] as const;

export const EXPECTED_PGVECTOR_VERSION = '0.8.7';

const MAX_DIMENSIONS = 2_000;
const MAX_SQL_PARAMETERS = 60_000;
const OPERATORS: Record<VectorDistanceMetric, string> = {
  l2: 'embedding <-> $1::vector',
  cosine: 'embedding <=> $1::vector',
  innerProduct: 'embedding <#> $1::vector',
};

export interface SqlVectorIndexOwner {
  driver: SqlQueryDriver;
  gate: OperationGate;
  ensureOwnerOpen(): void;
  ensureOutsideSnapshot(): void;
  registerScope(scope: { ownerClosed(): void }): () => void;
}

interface VectorSpaceRow extends Record<string, unknown> {
  dimensions: number;
}

interface VectorMatchRow extends Record<string, unknown> {
  source: string;
  item_id: string;
  distance: number;
}

interface PreparedVector {
  source: string;
  space: string;
  itemId: string;
  literal: string;
}

function vectorLiteral(vector: readonly number[]): string {
  return `[${vector.map((value) => String(value)).join(',')}]`;
}

function validateVector(vector: unknown, label: string, allowZero: boolean): number[] {
  if (!Array.isArray(vector) || vector.length < 1 || vector.length > MAX_DIMENSIONS) {
    throw new Error(`${label} must contain between 1 and ${MAX_DIMENSIONS} dimensions`);
  }
  const normalized: number[] = [];
  for (const value of vector as unknown[]) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new Error(`${label} must contain only finite numbers`);
    }
    const float32 = Math.fround(value);
    if (!Number.isFinite(float32)) throw new Error(`${label} contains a number outside pgvector's float32 range`);
    normalized.push(float32);
  }
  if (!allowZero && normalized.every((value) => value === 0)) {
    throw new Error(`${label} must not be a zero vector`);
  }
  return normalized;
}

function requireNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} must be a non-empty string`);
  if (value.includes('\u0000')) throw new Error(`${label} must not contain a zero byte`);
  return value;
}

function prepareRecords(records: readonly VectorRecord[]): { rows: PreparedVector[]; dimensions: Map<string, number> } {
  if (!Array.isArray(records)) throw new Error('vector records must be an array');
  const rows: PreparedVector[] = [];
  const dimensions = new Map<string, number>();
  const identities = new Set<string>();
  for (const record of records) {
    const source = requireNonEmptyString(record?.source, 'vector source');
    const space = requireNonEmptyString(record?.space, 'vector space');
    const itemId = requireNonEmptyString(record?.itemId, 'vector item id');
    const normalized = validateVector(record.vector, `vector ${JSON.stringify(itemId)}`, false);
    const size = normalized.length;
    const priorSize = dimensions.get(space);
    if (priorSize !== undefined && priorSize !== size) {
      throw new Error(`vector space ${JSON.stringify(space)} has inconsistent dimensions ${priorSize} and ${size}`);
    }
    dimensions.set(space, size);
    const identity = JSON.stringify([source, space, itemId]);
    if (identities.has(identity)) throw new Error(`duplicate vector identity ${identity}`);
    identities.add(identity);
    rows.push({ source, space, itemId, literal: vectorLiteral(normalized) });
  }
  return { rows, dimensions };
}

async function ensureVectorSpaces(executor: SqlExecutor, dimensions: ReadonlyMap<string, number>): Promise<void> {
  for (const [space, size] of [...dimensions].sort(([a], [b]) => byCodePoint(a, b))) {
    const inserted = await executor.query<{ space: string }>(
      'INSERT INTO vector_spaces (space, dimensions) VALUES ($1, $2) ON CONFLICT (space) DO NOTHING RETURNING space',
      [space, size],
    );
    if (inserted.rows.length === 1) continue;
    const existing = await executor.query<VectorSpaceRow>('SELECT dimensions FROM vector_spaces WHERE space = $1', [space]);
    if (existing.rows.length !== 1 || existing.rows[0]!.dimensions !== size) {
      throw new Error(`vector space ${JSON.stringify(space)} is registered with a different dimension`);
    }
  }
}

async function insertVectors(executor: SqlExecutor, rows: readonly PreparedVector[]): Promise<void> {
  const perChunk = Math.floor(MAX_SQL_PARAMETERS / 4);
  for (let start = 0; start < rows.length; start += perChunk) {
    const chunk = rows.slice(start, start + perChunk);
    const values: unknown[] = [];
    const tuples = chunk.map((row) => {
      const sourceParam = values.push(row.source);
      const spaceParam = values.push(row.space);
      const itemParam = values.push(row.itemId);
      const vectorParam = values.push(row.literal);
      return `($${sourceParam}, $${spaceParam}, $${itemParam}, $${vectorParam}::vector)`;
    });
    await executor.query(
      `INSERT INTO vector_items (source, space, item_id, embedding) VALUES ${tuples.join(', ')}`,
      values,
    );
  }
}

export function createSqlVectorIndex(owner: SqlVectorIndexOwner, sourceInput: readonly string[]): AsyncVectorIndex {
  owner.ensureOutsideSnapshot();
  owner.ensureOwnerOpen();
  if (!Array.isArray(sourceInput)) throw new Error('vector index sources must be an array');
  const sources = [...new Set(sourceInput.map((source) => requireNonEmptyString(source, 'vector index source')))].sort(byCodePoint);
  const sourceSet = new Set(sources);
  const active = new Set<Promise<unknown>>();
  let scopeClosing = false;
  let scopeClosed = false;
  let scopeClosePromise: Promise<void> | undefined;

  function ensureScopeOpen(): void {
    owner.ensureOwnerOpen();
    if (scopeClosing || scopeClosed) throw new Error('the vector index is closed');
  }

  function track<T>(work: () => Promise<T>): Promise<T> {
    const promise = work();
    active.add(promise);
    void promise.then(() => active.delete(promise), () => active.delete(promise));
    return promise;
  }

  const scopeEntry = {
    ownerClosed: () => { scopeClosing = true; scopeClosed = true; },
  };
  const unregister = owner.registerScope(scopeEntry);

  const index: AsyncVectorIndex = {
    rebuild: (sourceInput, records) => {
      try {
        owner.ensureOutsideSnapshot();
        ensureScopeOpen();
        if (!Array.isArray(sourceInput)) throw new Error('selected vector sources must be an array');
        const selected = [...new Set(sourceInput.map((source) => requireNonEmptyString(source, 'selected vector source')))].sort(byCodePoint);
        const selectedSet = new Set(selected);
        for (const source of selected) {
          if (!sourceSet.has(source)) throw new Error(`vector source ${JSON.stringify(source)} is outside this index scope`);
        }
        const prepared = prepareRecords(records);
        if (selected.length === 0) {
          if (prepared.rows.length > 0) throw new Error('vector records cannot be rebuilt without selected sources');
          return Promise.resolve();
        }
        for (const row of prepared.rows) {
          if (!sourceSet.has(row.source) || !selectedSet.has(row.source)) {
            throw new Error(`vector source ${JSON.stringify(row.source)} is outside the selected replacement scope`);
          }
        }
        return track(() => owner.gate.write(() => owner.driver.transaction('write', async (executor) => {
          await ensureVectorSpaces(executor, prepared.dimensions);
          await executor.query('DELETE FROM vector_items WHERE source = ANY($1::text[])', [selected]);
          await insertVectors(executor, prepared.rows);
        })));
      } catch (error) {
        return Promise.reject(error);
      }
    },
    search: (input: VectorSearchInput) => {
      try {
        owner.ensureOutsideSnapshot();
        ensureScopeOpen();
        const space = requireNonEmptyString(input?.space, 'vector space');
        const normalized = validateVector(input?.vector, 'query vector', input?.metric !== 'cosine');
        const dimensions = normalized.length;
        if (!Object.hasOwn(OPERATORS, input?.metric)) throw new Error(`unsupported vector metric ${JSON.stringify(input?.metric)}`);
        if (!Number.isSafeInteger(input?.limit) || input.limit <= 0) throw new Error('vector search limit must be a positive safe integer');
        if (sources.length === 0) return Promise.resolve([]);
        const queryVector = vectorLiteral(normalized);
        const operator = OPERATORS[input.metric];
        return track(() => owner.gate.snapshot(() => owner.driver.transaction('snapshot', async (executor) => {
          const spaceRows = await executor.query<VectorSpaceRow>('SELECT dimensions FROM vector_spaces WHERE space = $1', [space]);
          if (spaceRows.rows.length === 0) return [];
          if (spaceRows.rows[0]!.dimensions !== dimensions) {
            throw new Error(`query vector dimension ${dimensions} does not match vector space ${JSON.stringify(space)}`);
          }
          const result = await executor.query<VectorMatchRow>(
            `SELECT source, item_id, ${operator} AS distance FROM vector_items
             WHERE source = ANY($2::text[]) AND space = $3
             ORDER BY distance ASC, source COLLATE "C", item_id COLLATE "C"
             LIMIT $4`,
            [queryVector, sources, space, input.limit],
          );
          return result.rows.map((row) => {
            if (typeof row.source !== 'string' || typeof row.item_id !== 'string' || typeof row.distance !== 'number' || !Number.isFinite(row.distance)) {
              throw new Error('the vector index returned an invalid search row');
            }
            return { source: row.source, itemId: row.item_id, distance: row.distance };
          });
        })));
      } catch (error) {
        return Promise.reject(error);
      }
    },
    close: () => {
      try {
        owner.ensureOutsideSnapshot();
      } catch (error) {
        return Promise.reject(error);
      }
      if (scopeClosePromise !== undefined) return scopeClosePromise;
      if (scopeClosed) return Promise.resolve();
      scopeClosing = true;
      scopeClosePromise = (async () => {
        await Promise.allSettled([...active]);
        scopeClosed = true;
        unregister();
      })();
      return scopeClosePromise;
    },
  };
  return index;
}
