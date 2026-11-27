import { expect, test } from 'bun:test';
import type { DatabaseOwner } from '../src/adapters/database-owner.js';
import { generatedTableName, type GraphContract } from '../src/graph/contract.js';
import { producerFacts } from '../src/graph/producer-facts.js';
import { publishGraphDrafts } from '../src/graph/write.js';
import { createTestDatabaseOwner } from './test-database.js';
import { bindTestWriteCapability, TEST_SOURCE_UID } from './write-capability-fixture.js';

const contract: GraphContract = {
  vertex: ['fixture.item', 'fixture.group', 'fixture.empty'].map(name => ({
    name, table: generatedTableName(name, 'vertex'), key: ['name'], capability: 'reader',
    fields: [{ name: 'name', type: 'text' }, { name: 'text', type: 'text', nullable: true }],
  })),
  edge: ['fixture.link', 'fixture.member', 'fixture.empty-link'].map(name => ({
    name, table: generatedTableName(name, 'edge'), from: ['fixture.item'], to: ['fixture.group'],
    cardinality: { from: 'many', to: 'many' }, repeats: true, discriminator: 'place', capability: 'reader',
    labels: { en: { out: 'links', in: 'linked' }, ru: { out: 'links', in: 'linked' } },
    fields: [{ name: 'text', type: 'text', nullable: true }],
  })),
  dictionary: [],
};
const ref = (kind: string, name: string) => ({ kind, key: { name } });

test('mixed reconciliation kinds share one structural identity statement and retain ordered own facts', async () => {
  const owner = await createTestDatabaseOwner({ graphContract: contract });
  try {
    await owner.transaction('write', async tx => {
      await bindTestWriteCapability(tx, contract);
      await publishGraphDrafts(tx, contract, {
        vertices: [
          { ...ref('fixture.item', 'later'), values: { text: 'second' }, producer: 'reader', producerVersion: '1' },
          { ...ref('fixture.item', 'earlier'), values: { text: 'first' }, producer: 'reader', producerVersion: '1' },
          { ...ref('fixture.group', 'group'), values: { text: 'group value' }, producer: 'reader', producerVersion: '1' },
        ],
        edges: ['fixture.link', 'fixture.member'].map(kind => ({ kind,
          from: ref('fixture.item', 'earlier'), to: ref('fixture.group', 'group'), discriminator: kind,
          values: { text: kind }, producer: 'reader', producerVersion: '1',
        })),
        removals: [],
      }, 1);
    });
    await owner.transaction('write', async tx => {
      await bindTestWriteCapability(tx, contract, '019a0000-0000-7000-8000-000000000099');
      await publishGraphDrafts(tx, contract, { vertices: [
        { ...ref('fixture.item', 'foreign'), values: { text: 'not ours' }, producer: 'reader', producerVersion: '1' },
      ], removals: [] }, 1);
    });
    const itemNames = await owner.transaction('snapshot', async tx => (await tx.query<{ name: string }>(
      "SELECT n.key->>'name' AS name FROM node n JOIN entity k ON k.id=n.entity_id WHERE k.name='fixture.item' ORDER BY n.uid",
    )).rows.map(row => row.name).filter(name => name !== 'foreign'));
    const identityStatements: string[] = [];
    const observed: DatabaseOwner = {
      ...owner,
      transaction: (kind, work) => owner.transaction(kind, tx => work({
        ...tx,
        query: (sql, values) => {
          if (/FROM (?:node|edge) n JOIN entity k ON k\.id=n\.entity_id WHERE k\.name=/u.test(sql)) identityStatements.push(sql);
          return tx.query(sql, values);
        },
      })),
    };
    const facts = await producerFacts(observed, contract, TEST_SOURCE_UID,
      ['fixture.group', 'fixture.empty', 'fixture.item'], ['fixture.member', 'fixture.empty-link', 'fixture.link']);
    expect(facts).toEqual({
      vertices: [
        { ...ref('fixture.group', 'group'), values: { text: 'group value' } },
        ...itemNames.map(name => ({ ...ref('fixture.item', name), values: { text: name === 'earlier' ? 'first' : 'second' } })),
      ],
      edges: ['fixture.member', 'fixture.link'].map(kind => ({ kind,
        from: ref('fixture.item', 'earlier'), to: ref('fixture.group', 'group'), discriminator: kind, values: { text: kind },
      })),
    });
    expect(identityStatements).toHaveLength(1);
  } finally { await owner.close(); }
}, 30_000);
