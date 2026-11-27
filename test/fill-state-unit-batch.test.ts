import { expect, test } from 'bun:test';
import { createTestDatabaseOwner, type TestDatabaseOwner } from './test-database.js';
import { advanceUnitIn, createRun, edgeRowsIn, readRecordsIn, readRunUnits, readUnit } from '../src/graph/fill-state.js';
import { acquireGraphWriteLock } from '../src/graph/write.js';
import { createUnit } from './fill-unit-fixture.js';

test('reading a run batches unit owners without query growth per unit', async () => {
  const owner = await createTestDatabaseOwner();
  try {
    for (const runId of ['small', 'large']) await createRun(owner, { runId, product: 'batch-product', at: 1 });
    const options = { product: 'batch-product', stageId: 'source', inputsDigest: 'digest', retries: 2, at: 2 };
    await createUnit(owner, { ...options, unitId: 'source/small', scopeKey: 'small', runId: 'small' });
    const names = ['z', 'a', 'A', 'é', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'];
    for (const name of names) await createUnit(owner, { ...options, unitId: `source/${name}`, scopeKey: name, runId: 'large' });
    let queries = 0;
    const counting = Object.create(owner) as TestDatabaseOwner;
    counting.transaction = async (kind, work) => await owner.transaction(kind, async tx => await work({
      query: async <Row extends object = Record<string, unknown>>(sql: string, values?: readonly unknown[]) => {
        queries += 1;
        return await tx.query<Row>(sql, values);
      },
    }));
    const small = await readRunUnits(counting, 'small');
    const oneCost = queries;
    queries = 0;
    const large = await readRunUnits(counting, 'large');
    expect(small).toHaveLength(1);
    expect(large).toHaveLength(12);
    expect(queries).toBeLessThanOrEqual(oneCost);
    expect(large.map(unit => unit.unitId)).toEqual(['A', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'z', 'é'].map(name => `source/${name}`));
    for (const unit of large) {
      expect(unit.runId).toBe('large');
      expect(await readUnit(owner, unit.unitId)).toEqual(unit);
    }
    expect(small[0]?.runId).toBe('small');
  } finally { await owner.close(); }
}, 60_000);

test('a unit transition states the machine operation it runs under in the same admission', async () => {
  const owner = await createTestDatabaseOwner();
  try {
    await createRun(owner, { runId: 'r', product: 'transition-product', at: 1 });
    await createUnit(owner, { unitId: 'source/a', product: 'transition-product', runId: 'r', stageId: 'source', scopeKey: 'a', inputsDigest: 'digest', retries: 0, at: 2 });
    const batches: { kind: string; property: string }[][] = [];
    const inserts: string[][] = [];
    const step = await owner.transaction('write', async tx => {
      await acquireGraphWriteLock(tx);
      const read = tx.query.bind(tx);
      (tx as { query: typeof tx.query }).query = async <Row extends object = Record<string, unknown>>(sql: string, values?: readonly unknown[]) => {
        // The stream read's input is the complete assertion plan of one admission, kinds and properties named.
        if (sql.includes('AS sort,wanted.subject::text AS subject') && typeof values?.[0] === 'string') {
          batches.push((JSON.parse(values[0]) as { kind: string; property: string }[]).map(({ kind, property }) => ({ kind, property })));
        }
        const result = await read<Row>(sql, values);
        if (sql.includes('INSERT INTO assertion(')) inserts.push(result.rows.map(row => (row as { id: string }).id));
        return result;
      };
      return await advanceUnitIn(tx, { unitId: 'source/a', event: { type: 'admit', at: 3, generation: 1 } });
    });
    expect(step.ok).toBe(true);
    // The transition, the record it leaves and the operation lineage it runs under are one insertion batch:
    // before this the machine's own operation was stated by an admission of its own. The batch names every
    // record by kind and property, so the operation's own vertex and its author edge must be in it — the
    // repeated `$exists` property alone would also hold with one of them missing.
    expect(batches).toHaveLength(1);
    expect(batches[0]).toEqual(expect.arrayContaining([
      { kind: 'system.unit', property: 'state' },
      { kind: 'system.fill-transition', property: 'step' },
    ]));
    expect(batches[0]!.filter(input => input.property === '$exists').map(input => input.kind).sort()).toEqual([
      'system.fill-transition',
      'system.fill-transition-subject',
      'system.operation',
      'system.operation-author',
      'system.unit',
    ]);
    expect(inserts).toHaveLength(1);
    await owner.transaction('snapshot', async tx => {
      const rows = (await tx.query<{ id: string; operation: string; property: string; subject: string | null; kind: string | null }>(`
        SELECT a.assertion_id::text AS id, lineage.to_node::text AS operation, a.property,
          n.id::text AS subject, k.name AS kind
        FROM assertion a
        JOIN edge lineage ON lineage.from_node=a.assertion_id AND lineage.entity_id=(SELECT id FROM entity WHERE name='system.assertion-operation')
        LEFT JOIN assertion_vertex_subject s ON s.assertion_id=a.assertion_id
        LEFT JOIN edge subject ON subject.id=s.subject_edge_id
        LEFT JOIN node n ON n.id=subject.to_node
        LEFT JOIN entity k ON k.id=n.entity_id
        WHERE a.assertion_id=ANY($1::bigint[])`, [inserts[0]])).rows;
      expect(rows.map(row => row.id).sort()).toEqual([...inserts[0]!].sort());
      const operations = rows.filter(row => row.kind === 'system.operation' && row.property === '$exists');
      expect(operations).toHaveLength(1);
      const operationId = operations[0]!.subject!;
      expect(new Set(rows.map(row => row.operation))).toEqual(new Set([operationId]));
      const authors = await edgeRowsIn(tx, 'system.operation-author', 'from', [Number(operationId)]);
      expect(authors).toHaveLength(1);
      const [author] = await readRecordsIn(tx, 'vertex', 'plugin', ['label'], [authors[0]!.to]);
      expect(author?.values.label).toBe('fill-state');
    });
  } finally { await owner.close(); }
}, 60_000);
