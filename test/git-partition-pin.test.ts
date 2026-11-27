import { expect, test } from 'bun:test';
import { partitioned } from '../plugins/git/partition.js';
import type { Unit, ExtractContext, VertexResult, EdgeResult } from 'madarch-plugin-sdk';
const ref = (hash: string, kind = 'code.commit') => ({ kind, key: { hash } });
const context = {} as ExtractContext;
const unit = (keys: string[], repositories = [{ repository: 'fixture', root: '/prepared/fixture', commit: 'P' }]): Unit => ({ unitId: 'commits', kind: 'code.commit', key: {}, inputs: { repositories, keys: keys.map(hash => ({ hash })) } });
const evidence = { target: ref('P'), commit: 'P' };
const result = (): { end: { state: 'complete' }; vertices: VertexResult[]; edges: EdgeResult[] } => ({ end: { state: 'complete' as const }, vertices: [
  { ...ref('K'), values: { subject: 'K' }, evidence },
  { ...ref('Q'), values: { subject: 'Q' }, evidence },
  { ...ref('P'), values: { subject: 'P'.repeat(600000) }, evidence },
], edges: [{ kind: 'code.parent', from: ref('K'), to: ref('Q'), evidence }] });
test('prepared pin is a citation, selected owner retains full pin; parent keeps its witness', async () => {
  const output = partitioned(async () => result());
  const child = await output.extract(unit(['K']), context);
  expect(child.vertices?.map(v => v.key)).toEqual([{ hash: 'K' }, { hash: 'Q' }]);
  expect(child.vertices?.[0]?.evidence).toEqual(evidence);
  expect(child.edges).toEqual(result().edges);
  const owner = await output.extract(unit(['P']), context);
  expect(owner.vertices).toEqual([result().vertices![2]!]);
});
test('planning counts citation output consistently with extraction', async () => {
  const data = result();
  data.vertices[0] = { ...data.vertices[0]!, values: { subject: 'K'.repeat(300000) } };
  data.vertices[1] = { ...data.vertices[1]!, values: { subject: 'Q'.repeat(300000) } };
  const output = partitioned(async () => data);
  expect((await output.planOutput(unit([]), context)).partitions).toEqual([{ keys: [{ hash: 'K' }] }, { keys: [{ hash: 'P' }, { hash: 'Q' }] }]);
});
for (const scenario of ['no prepared pin', 'other revision', 'foreign kind', 'ordinary endpoint'] as const) test(scenario, async () => {
  const data = result();
  if (scenario === 'other revision') data.vertices[0] = { ...data.vertices[0]!, evidence: { ...evidence, commit: 'other' } };
  if (scenario === 'foreign kind') {
    data.vertices!.push({ ...ref('P', 'foreign'), values: { subject: 'foreign' } });
    data.vertices[0] = { ...data.vertices[0]!, evidence: { target: ref('P', 'foreign'), commit: 'P' } };
  }
  if (scenario === 'ordinary endpoint') data.edges!.push({ kind: 'code.parent', from: ref('K'), to: ref('P'), evidence });
  const output = partitioned(async () => data);
  const child = await output.extract(unit(['K'], scenario === 'no prepared pin' ? [] : undefined), context);
  expect(child.vertices?.some(v => v.key['hash'] === 'P')).toBe(true);
});

test('a different output kind preserves ordinary commit evidence support', async () => {
  const data = result();
  data.vertices.push({ kind: 'code.author', key: { name: 'fixture' }, evidence });
  const output = partitioned(async () => data);
  const child = await output.extract({ ...unit([]), kind: 'code.author', inputs: { repositories: [{ commit: 'P' }], keys: [{ name: 'fixture' }] } }, context);
  expect(child.vertices?.map(v=>v.kind)).toEqual(['code.commit', 'code.author']);
});
test('ordinary units without repository inputs or optional output collections remain valid', async () => {
  const output = partitioned(async () => ({ end: { state: 'complete' } }));
  expect((await output.extract({ ...unit([]), inputs: { keys: [] } }, context)).vertices).toEqual([]);
});
