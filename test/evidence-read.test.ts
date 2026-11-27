import { expect, test } from 'bun:test';
import { newUid } from '../src/graph/uid.js';
import type { SemanticBinding } from '../src/product/manifest/kinds.js';
import { evaluateEvidenceState, readEvidenceStates, type EvidenceProof } from '../src/graph/evidence-read.js';
import { sha256Hex } from '../src/graph/digest.js';
import { generatedTableName, type GraphContract } from '../src/graph/contract.js';

const at = '2026-11-15T00:00:00.000Z';
const content = 'a😀b\nsecond';
const digest = sha256Hex(Buffer.from(content));
const base: EvidenceProof = { immutable: true, digestAlgorithm: 'sha256', content, digest, locator: null, validAt: at, assertion: { operation: 'assert', validTo: null } };

test('retained valid history remains valid when current support changes or ends', () => {
  expect(evaluateEvidenceState({ ...base, support: { currentApplicability: 'current' } })).toMatchObject({ historicalValidity: 'valid', currentApplicability: 'current', availability: 'available' });
  expect(evaluateEvidenceState({ ...base, support: { currentApplicability: 'stale' } })).toMatchObject({ historicalValidity: 'valid', currentApplicability: 'stale', availability: 'available' });
  for (const assertion of [{ operation: 'retract' as const, validTo: null }, { operation: 'assert' as const, validTo: at }]) {
    expect(evaluateEvidenceState({ ...base, assertion })).toMatchObject({ historicalValidity: 'valid', currentApplicability: 'ended' });
  }
});

test('future assertion end preserves current support and support diagnostics remain explicit', () => {
  const result = evaluateEvidenceState({ ...base, assertion: { operation: 'assert', validTo: '2030-01-01T00:00:00Z' }, support: { currentApplicability: 'current' } });
  expect(result.currentApplicability).toBe('current');
  expect(result.issues).toEqual([]);
  const diagnostic = evaluateEvidenceState({ ...base, support: { currentApplicability: 'unknown', issues: ['support is contested'] } });
  expect(diagnostic.issues).toEqual(['support is contested']);
  expect(evaluateEvidenceState(base).issues.every(issue => issue.length > 0)).toBe(true);
});

test('missing retained bytes are unavailable and unknown, not invalid', () => {
  for (const content of [undefined, null, 42]) {
    const result = evaluateEvidenceState({ ...base, content });
    expect(result).toMatchObject({ historicalValidity: 'unknown', availability: 'unavailable', currentApplicability: 'unknown' });
    expect(result.issues.length).toBeGreaterThan(0);
  }
  for (const proof of [{ ...base, immutable: false }, { ...base, digest: undefined }]) {
    expect(evaluateEvidenceState(proof).historicalValidity).toBe('unknown');
  }
});

test('hash and locator mismatch are invalid while missing support stays unknown', () => {
  for (const proof of [{ ...base, content: 'changed' }, { ...base, digest: 'bad' }, { ...base, locator: { digest: '0'.repeat(64) } }]) {
    expect(evaluateEvidenceState(proof)).toMatchObject({ historicalValidity: 'invalid', availability: 'available', currentApplicability: 'unknown' });
  }
  expect(evaluateEvidenceState(base).issues.length).toBeGreaterThan(0);
});

test('caller proof diagnostics survive evidence evaluation', () => {
  const reason = 'retained field selection is contested';
  const result = evaluateEvidenceState({ ...base, issues: [reason] });
  expect(result.issues).toContain(reason);
});

test('invalid locator is rejected before bytes or digest proof without changing currentness', () => {
  for (const content of [undefined, 'retained']) {
    const result = evaluateEvidenceState({ ...base, content, locator: { digest: 42 }, support: { currentApplicability: 'current' } });
    expect(result.historicalValidity).toBe('invalid');
    expect(result.currentApplicability).toBe('current');
    expect(result.availability).toBe(content === undefined ? 'unavailable' : 'available');
    expect(result.issues.some(issue => issue.includes('EVIDENCE_INVALID'))).toBe(true);
  }
});

test('locator spans use retained Unicode content and distinguish incomplete from invalid', () => {
  for (const locator of [{ start: 0, end: 9 }, { lineStart: 1, lineEnd: 2 }, {}]) {
    expect(evaluateEvidenceState({ ...base, locator }).historicalValidity).toBe('valid');
  }
  for (const locator of [{ start: 0, end: 11 }, { start: -1, end: 1 }, { start: 3, end: 2 }, { lineStart: 1, lineEnd: 3 }, { arbitrary: true }]) {
    expect(evaluateEvidenceState({ ...base, locator }).historicalValidity).toBe('invalid');
  }
  for (const locator of [{ start: 0 }, { lineStart: 0 }, { columnStart: 0, columnEnd: 1 }, { lineStart: 1, lineEnd: 1, columnStart: 0, columnEnd: 4 }]) {
    const result = evaluateEvidenceState({ ...base, locator });
    expect(result.historicalValidity).toBe('unknown');
    expect(result.issues.length).toBeGreaterThan(0);
  }
});

test('SQL reader selects typed assertions and key digest without requiring active source', async () => {
  const { createDatabaseOwner } = await import('../src/adapters/database-owner.js');
  const { prepareGraphSchema } = await import('../src/adapters/schemas/graph.js');
  const { bindWriteCapability, publishGraphDrafts } = await import('../src/graph/write.js');
  const { startupBinding } = await import('../src/graph/manifest-publication.js');
  const { testStoreServer } = await import('./test-database.js');
  const contract: GraphContract = { vertex: [{ name: 'retained', table: generatedTableName('retained', 'vertex'), key: ['digest'], fields: [{ name: 'digest', type: 'text' }, { name: 'body', type: 'text' }], capability: 'fixture', evidence: { immutable: true, digestField: 'digest', contentField: 'body', digestAlgorithm: 'sha256' } }, { name: 'fixture-source', table: generatedTableName('fixture-source', 'vertex'), key: ['path'], fields: [{ name: 'path', type: 'text' }, { name: 'text', type: 'text' }], capability: 'fixture' }], edge: [{ name: 'supports', from: ['retained'], to: ['fixture-source'], fields: [], repeats: false, capability: 'fixture', cardinality: { from: 'many', to: 'many' }, labels: { en: { out: 'supports', in: 'supported by' }, ru: { out: 'supports', in: 'supported by' } } }], dictionary: [] };
  const owner = await createDatabaseOwner({ cluster: await testStoreServer(), database: `evidence_${Date.now()}` });
  try {
    await owner.ready;
    await prepareGraphSchema(owner, contract);
    const { binding } = await owner.transaction('write', tx => startupBinding(tx, contract, 'evidence-fixture',
      ['retained', 'fixture-source', 'supports'].map(kind => ({ kind, properties: ['*'], assert: true, retractOwn: true }))));
    await owner.transaction('write', async tx => {
      bindWriteCapability(tx, binding);
      await publishGraphDrafts(tx, contract, { vertices: [
        { kind: 'retained', key: { digest }, values: { body: content }, producer: 'fixture', producerVersion: '1', validFrom: '2020-01-01T00:00:00Z' },
        ...Array.from({ length: 99 }, (_, index) => {
          const body = `retained ${index}`;
          return { kind: 'retained', key: { digest: sha256Hex(Buffer.from(body)) }, values: { body }, producer: 'fixture', producerVersion: '1', validFrom: '2020-01-01T00:00:00Z' };
        }),
      ], removals: [] });
    });
    const uid = await owner.transaction('snapshot', async tx => (await tx.query<{ uid: string }>(`SELECT n.uid::text AS uid FROM node n JOIN entity k ON k.id=n.entity_id WHERE k.name='retained' AND n.key->>'digest'=$1`, [digest])).rows[0]!.uid);
    const selector = { validAt: '2030-01-01T00:00:00Z', recordedAt: '2030-01-01T00:00:00Z', contexts: [1] };
    await owner.transaction('snapshot', async tx => {
      const identities = (await tx.query<{ uid: string }>(`SELECT n.uid::text AS uid FROM node n JOIN entity k ON k.id=n.entity_id WHERE k.name='retained' ORDER BY n.uid`)).rows;
      expect(identities).toHaveLength(100);
      let reads = 0;
      const measured = new Proxy(tx, { get(target, key) {
        if (key === 'query') return async (sql: string, values?: readonly unknown[]) => { reads += 1; return await target.query(sql, values); };
        return Reflect.get(target, key);
      } });
      await readEvidenceStates(measured, contract, [{ targetUid: uid, locator: null, assertion: base.assertion }], selector);
      expect(reads).toBe(2);
      reads = 0;
      const states = await readEvidenceStates(measured, contract, identities.map(target => ({ targetUid: target.uid, locator: null, assertion: base.assertion })), selector);
      expect(reads).toBe(2);
      expect(states).toHaveLength(100);
      expect(states.every(state => state.historicalValidity === 'valid' && state.availability === 'available')).toBe(true);
    });
    const result = await owner.transaction('snapshot', async tx => (await readEvidenceStates(tx, contract, [{ targetUid: uid, locator: { start: 0, end: 3 }, assertion: base.assertion }], selector))[0]!);
    expect(result).toMatchObject({ historicalValidity: 'valid', availability: 'available', currentApplicability: 'unknown' });
    const { evidenceSupportRoles } = await import('../src/graph/evidence-support.js');
    const bindings = evidenceSupportRoles(new Map<string, SemanticBinding>([
      ['evidence-support', { kind: 'retained', fields: {}, edges: { about: { kind: 'supports', direction: 'from' as const, line: 1 } }, line: 1 }],
      ['file', { kind: 'fixture-source', fields: { content: 'text' }, line: 1 }],
    ]));
    const publishSource = async (text: string): Promise<void> => {
      await owner.transaction('write', async tx => {
        bindWriteCapability(tx, binding);
        await publishGraphDrafts(tx, contract, {
          vertices: [{ kind: 'fixture-source', key: { path: 'example' }, values: { text }, producer: 'fixture', producerVersion: '1' }],
          edges: [{ kind: 'supports', from: { kind: 'retained', key: { digest } }, to: { kind: 'fixture-source', key: { path: 'example' } }, producer: 'fixture', producerVersion: '1' }], removals: [],
        });
      });
    };
    await publishSource(content);
    const current = await owner.transaction('snapshot', async tx => (await readEvidenceStates(tx, contract, [{ targetUid: uid, locator: null, assertion: base.assertion }], selector, bindings))[0]!);
    expect(current).toMatchObject({ historicalValidity: 'valid', currentApplicability: 'current', availability: 'available' });
    await owner.transaction('snapshot', async tx => {
      let count = 0;
      const measured = new Proxy(tx, { get(target, key) {
        if (key === 'query') return async (sql: string, values?: readonly unknown[]) => { count += 1; return await target.query(sql, values); };
        return Reflect.get(target, key);
      } });
      const one = await readEvidenceStates(measured, contract, [{ targetUid: uid, locator: null, assertion: base.assertion }], selector, bindings);
      const oneCount = count;
      expect(oneCount).toBe(6); // identities, retained fields, support links, source existence, siblings and edge existence.
      count = 0;
      const requests = Array.from({ length: 100 }, (_, index) => ({ targetUid: uid, locator: null, assertion: { operation: 'assert' as const, validTo: index % 2 === 0 ? null : at } }));
      const many = await readEvidenceStates(measured, contract, requests, selector, bindings);
      expect(count).toBe(oneCount);
      expect(one).toEqual([current]);
      expect(many.map(state => state.currentApplicability)).toEqual(requests.map(request => request.assertion.validTo === null ? 'current' : 'ended'));
      count = 0;
      expect(await readEvidenceStates(measured, contract, [], selector, bindings)).toEqual([]);
      expect(count).toBe(0);
    });
    const replacement = 'replacement';
    const replacementDigest = sha256Hex(Buffer.from(replacement));
    await owner.transaction('write', async tx => {
      bindWriteCapability(tx, binding);
      await publishGraphDrafts(tx, contract, {
        vertices: [{ kind: 'retained', key: { digest: replacementDigest }, values: { body: replacement }, producer: 'fixture', producerVersion: '1' }], removals: [],
        edges: [{ kind: 'supports', from: { kind: 'retained', key: { digest: replacementDigest } }, to: { kind: 'fixture-source', key: { path: 'example' } }, producer: 'fixture', producerVersion: '1' }],
      });
    });
    const ambiguous = await owner.transaction('snapshot', async tx => (await readEvidenceStates(tx, contract, [{ targetUid: uid, locator: null, assertion: base.assertion }], selector, bindings))[0]!);
    expect(ambiguous.currentApplicability).toBe('unknown');
    await owner.transaction('write', async tx => {
      bindWriteCapability(tx, binding);
      await publishGraphDrafts(tx, contract, { vertices: [], removals: [], edgeRemovals: [{ kind: 'supports', from: { kind: 'retained', key: { digest } }, to: { kind: 'fixture-source', key: { path: 'example' } }, producer: 'fixture' }] });
    });
    const stale = await owner.transaction('snapshot', async tx => (await readEvidenceStates(tx, contract, [{ targetUid: uid, locator: null, assertion: base.assertion }], selector, bindings))[0]!);
    expect(stale).toMatchObject({ historicalValidity: 'valid', currentApplicability: 'stale', availability: 'available' });
    const past = await owner.transaction('snapshot', async tx => (await readEvidenceStates(tx, contract, [{ targetUid: uid, locator: null, assertion: base.assertion }], { ...selector, recordedAt: '2000-01-01T00:00:00Z' }))[0]!);
    expect(past).toMatchObject({ historicalValidity: 'unknown', availability: 'unavailable' });
    const missing = await owner.transaction('snapshot', async tx => (await readEvidenceStates(tx, contract, [{ targetUid: newUid(), locator: null, assertion: base.assertion }], selector))[0]!);
    expect(missing).toMatchObject({ historicalValidity: 'unknown', availability: 'unavailable' });
  } finally { await owner.close(); }
}, 20000);
