/**
 * The executor's admission and deadline (decision 0036, section 5): the alias and node ceilings, the two-second
 * deadline that cancels its backend and rolls its transaction back, and the statement timeout that answers TIMEOUT
 * with no partial data. The owner here is a fake that records what the executor asked of it.
 */
import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseOwner } from '../src/adapters/database-owner.js';
import { readKinds, type KindsManifest } from '../src/product/manifest/kinds.js';
import { executeGraphql, DEADLINE_MS, type MessageBody } from '../src/graph/graphql-execute.js';

/** The fixture product the queries are admitted against, read without a store. */
function fixtureManifest(): KindsManifest {
  const folder = mkdtempSync(join(tmpdir(), 'madarch-graphql-admission-'));
  mkdirSync(join(folder, 'templates'), { recursive: true });
  mkdirSync(join(folder, 'madarch/kinds/demo/core'), { recursive: true });
  const text = readFileSync(join(import.meta.dir, 'graphql/fixture-product-catalog.yaml'), 'utf8');
  writeFileSync(join(folder, 'templates/entity.yaml'), 'template: entity\n');
  writeFileSync(join(folder, 'madarch/catalog.yaml'), text);
  writeFileSync(join(folder, 'madarch/kinds/demo/core/demo.repository.yaml'), readFileSync(join(import.meta.dir, 'graphql/fixture-product-demo.repository.yaml'), 'utf8'));
  writeFileSync(join(folder, 'madarch/kinds/demo/core/demo.file.yaml'), readFileSync(join(import.meta.dir, 'graphql/fixture-product-demo.file.yaml'), 'utf8'));
  const read = readKinds(folder);
  if (!read.present) throw new Error('the fixture product holds no manifest');
  if (read.manifest.findings.length > 0) throw new Error(read.manifest.findings.map((one) => `${one.file}:${String(one.line)}: ${one.message}`).join('\n'));
  return read.manifest;
}

const manifest = fixtureManifest();
const folder = '/fixture';

interface FakeState {
  statements: string[];
  cancelled: boolean;
  cancelledPid: unknown;
  rolledBack: boolean;
}

/** A store that answers the executor's statements from memory: slow when told, timing out when told. */
function fakeOwner(options: { readonly slowMs?: number; readonly statementTimeout?: boolean } = {}): { owner: DatabaseOwner; state: FakeState } {
  const state: FakeState = { statements: [], cancelled: false, cancelledPid: undefined, rolledBack: false };
  const rowsFor = (sql: string): Record<string, unknown>[] => {
    if (sql.includes('AS node_id') && sql.includes('JOIN entity en')) return [{ node_id: '1', uid: '00000000-0000-5000-8000-000000000001', key: { path: 'a.ts' }, entity: 'demo.file' }];
    if (sql.includes('holder_id')) return [{ holder_id: '1', opinion_id: '1', said_by: 'one@1', said_at: new Date('2026-01-01T00:00:00Z'), lang: null, evidence: [], lines: 2 }];
    if (sql.includes('other_id')) return [{ parent: '1', id: '1', discriminator: '', other_id: '2', other_uid: '00000000-0000-5000-8000-000000000002', other_key: {}, other_entity: 'demo.repository' }];
    return [];
  };
  const tx = {
    query: async (sql: string, values?: readonly unknown[]) => {
      void values;
      if (sql.includes('pg_backend_pid')) return { rows: [{ pid: 4242 }] };
      if (sql.includes('SET LOCAL')) return { rows: [] };
      state.statements.push(sql);
      if (options.statementTimeout === true) throw new Error('canceling statement due to statement timeout');
      if (options.slowMs !== undefined) {
        await Bun.sleep(options.slowMs);
        if (state.cancelled) throw new Error('canceling statement due to user request');
      }
      return { rows: rowsFor(sql) };
    },
  };
  const owner = {
    transaction: async <T>(_kind: string, work: (transaction: typeof tx) => Promise<T>): Promise<T> => {
      try {
        return await work(tx);
      } catch (error) {
        state.rolledBack = true;
        throw error;
      }
    },
    run: async <T>(work: (transaction: { query: (sql: string, values?: readonly unknown[]) => Promise<{ rows: unknown[] }> }) => Promise<T>): Promise<T> => await work({
      query: async (sql: string, values?: readonly unknown[]) => {
        if (sql.includes('pg_cancel_backend')) {
          state.cancelled = true;
          state.cancelledPid = values?.[0];
        }
        return { rows: [] };
      },
    }),
  };
  return { owner: owner as unknown as DatabaseOwner, state };
}

describe('the GraphQL admission and deadline', () => {
  test('a query with more than fifty aliases is refused with LIMIT_ALIASES (#3)', async () => {
    const aliases = Array.from({ length: 51 }, (_, at) => `a${String(at)}: bootstrap { structureRevision }`).join(' ');
    const { owner, state } = fakeOwner();
    const answer = await executeGraphql(owner, { manifest, folder }, { query: `{ ${aliases} }` });
    expect((answer.body as MessageBody).errors?.[0]?.extensions?.code).toBe('LIMIT_ALIASES');
    expect(state.statements).toHaveLength(0);
  });

  test('a query whose connections multiply past five thousand nodes is refused with LIMIT_NODES (#3)', async () => {
    const { owner, state } = fakeOwner();
    const answer = await executeGraphql(owner, { manifest, folder }, { query: '{ allDemoFile(first: 200) { edges { node { path demoContainsOf(first: 200) { edges { cursor } } } } } }' });
    expect((answer.body as MessageBody).errors?.[0]?.extensions?.code).toBe('LIMIT_NODES');
    expect(state.statements).toHaveLength(0);
  });

  test('the deadline cancels the backend query and rolls its transaction back (#4)', async () => {
    const { owner, state } = fakeOwner({ slowMs: 900 });
    const answer = await executeGraphql(owner, { manifest, folder }, { query: '{ allDemoFile(first: 1) { edges { node { lines demoContainsOf(first: 1) { edges { cursor } } } } } }' });
    expect((answer.body as MessageBody).errors?.[0]?.extensions?.code).toBe('TIMEOUT');
    expect((answer.body as MessageBody).data).toBeUndefined();
    expect(state.cancelledPid).toBe(4242);
    expect(state.rolledBack).toBe(true);
  }, DEADLINE_MS + 5_000);

  test('a statement timeout answers TIMEOUT with no partial data (#18)', async () => {
    const { owner } = fakeOwner({ statementTimeout: true });
    const answer = await executeGraphql(owner, { manifest, folder }, { query: '{ allDemoFile(first: 1) { edges { node { path } } } }' });
    const body = answer.body as MessageBody;
    expect(body.data).toBeUndefined();
    expect(body.errors).toHaveLength(1);
    expect(body.errors?.[0]?.extensions?.code).toBe('TIMEOUT');
  });
});
