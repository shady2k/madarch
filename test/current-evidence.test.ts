import { expect, test } from 'bun:test';
import { createTestDatabaseOwner } from './test-database.js';
import { generatedTableName, type GraphContract } from '../src/graph/contract.js';
import { publishGraphDrafts } from '../src/graph/write.js';
import { vanishedCurrentEvidence } from '../src/graph/index.js';
import { sha256Hex } from '../src/graph/digest.js';

const contract: GraphContract = {
  vertex: [
    { name: 'retained', table: generatedTableName('retained', 'vertex'), key: ['digest'], capability: 'fixture',
      fields: [{ name: 'digest', type: 'text' }, { name: 'body', type: 'text' }],
      evidence: { immutable: true, digestField: 'digest', contentField: 'body', digestAlgorithm: 'sha256' } },
    { name: 'probe.fact', table: generatedTableName('probe.fact', 'vertex'), key: ['id'], capability: 'fixture',
      fields: [{ name: 'id', type: 'text' }, { name: 'title', type: 'text' }] },
  ], edge: [], dictionary: [],
};

test('current evidence reports unavailable retained bytes without rewriting history or reporting ended assertions', async () => {
  const owner = await createTestDatabaseOwner({ graphContract: contract });
  const digest = sha256Hex(Buffer.from('retained bytes'));
  const missing = sha256Hex(Buffer.from('unavailable bytes'));
  const evidence = (value: string) => [{ target: { kind: 'retained', key: { digest: value } } }];
  const fact = (id: string, value: string) => ({ kind: 'probe.fact', key: { id }, values: { title: id }, evidence: evidence(value), producer: 'fixture', producerVersion: '1' });
  try {
    await owner.transaction('write', async tx => {
      await publishGraphDrafts(tx, contract, { removals: [], vertices: [
        { kind: 'retained', key: { digest }, values: { body: 'retained bytes' }, producer: 'fixture', producerVersion: '1' },
        { kind: 'retained', key: { digest: missing }, producer: 'fixture', producerVersion: '1' },
        fact('available', digest), fact('unavailable', missing), fact('ended', missing),
      ] });
      await publishGraphDrafts(tx, contract, { vertices: [], removals: [{ kind: 'probe.fact', key: { id: 'ended' }, producer: 'fixture' }] });
    });
    const before = await owner.transaction('snapshot', async tx => (await tx.query<{ count: number }>('SELECT count(*)::int AS count FROM assertion')).rows[0]!.count);
    const page = await vanishedCurrentEvidence(owner, contract);
    expect(page.rows.filter(row => row.key['id'] === 'available').every(row => row.state.historicalValidity === 'valid' && row.state.availability === 'available')).toBe(true);
    expect(page.rows.some(row => row.key['id'] === 'ended')).toBe(false);
    expect(page.rows.filter(row => row.key['id'] === 'unavailable').length).toBeGreaterThan(0);
    expect(page.rows.filter(row => row.key['id'] === 'unavailable').every(row => row.applicability === 'unavailable')).toBe(true);
    const seen: string[] = [];
    let after: string | undefined;
    do {
      const next = await vanishedCurrentEvidence(owner, contract, { limit: 1, ...(after === undefined ? {} : { after }) });
      seen.push(...next.rows.map(row => row.opinion));
      after = next.next;
    } while (after !== undefined);
    expect(seen).toEqual(page.rows.map(row => row.opinion));
    expect(new Set(seen).size).toBe(seen.length);
    expect(await owner.transaction('snapshot', async tx => (await tx.query<{ count: number }>('SELECT count(*)::int AS count FROM assertion')).rows[0]!.count)).toBe(before);
  } finally { await owner.close(); }
}, 30_000);
