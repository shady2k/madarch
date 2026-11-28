import { expect, test } from 'bun:test';
import type { DatabaseOwner } from '../src/adapters/database-owner.js';
import { generatedTableName, type GraphContract } from '../src/graph/contract.js';
import { canonicalAssertionValue } from '../src/graph/assertion-selection.js';
import { producerFacts } from '../src/graph/producer-facts.js';
import { publishGraphDrafts, writeAssertion } from '../src/graph/write.js';
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
    const { revisions, coverage: _coverage, ...held } = facts;
    expect(held).toEqual({
      vertices: [
        { ...ref('fixture.group', 'group'), values: { text: 'group value' } },
        ...itemNames.map(name => ({ ...ref('fixture.item', name), values: { text: name === 'earlier' ? 'first' : 'second' } })),
      ],
      edges: ['fixture.member', 'fixture.link'].map(kind => ({ kind,
        from: ref('fixture.item', 'earlier'), to: ref('fixture.group', 'group'), discriminator: kind, values: { text: kind },
      })),
    });
    // Every subject of the covered kinds carries its stream position; the answer names them in one deterministic order.
    const ordered = (subjects: readonly unknown[]) => subjects.map(subject => JSON.stringify(subject)).sort();
    expect(ordered(revisions.map(revision => revision.subject))).toEqual(ordered([
      { sort: 'edge', kind: 'fixture.link', from: ref('fixture.item', 'earlier'), to: ref('fixture.group', 'group'), discriminator: 'fixture.link' },
      { sort: 'edge', kind: 'fixture.member', from: ref('fixture.item', 'earlier'), to: ref('fixture.group', 'group'), discriminator: 'fixture.member' },
      { sort: 'vertex', ...ref('fixture.group', 'group') },
      { sort: 'vertex', ...ref('fixture.item', 'earlier') },
      { sort: 'vertex', ...ref('fixture.item', 'later') },
    ]));
    expect(revisions.every(revision => /^[0-9]+$/u.test(revision.recordedSequence))).toBe(true);
    expect(identityStatements).toHaveLength(1);
  } finally { await owner.close(); }
}, 30_000);

test('a vertex and an edge that share a numeric id are separate subjects in both uid orders', async () => {
  const owner = await createTestDatabaseOwner({ graphContract: contract });
  // The assertion each fixture subject's last statement made, and the sequence the store holds for that statement.
  const finalAssertion = new Map<string, string>();
  const storedSequences = new Map<string, string>();
  try {
    await owner.transaction('write', async tx => {
      await bindTestWriteCapability(tx, contract);
      await publishGraphDrafts(tx, contract, {
        vertices: [{ ...ref('fixture.group', 'group'), values: { text: 'group value' }, producer: 'reader', producerVersion: '1' }],
        removals: [],
      }, 1);
      const group = (await tx.query<{ id: string; scope: string }>(
        "SELECT n.id::text AS id,n.identity_scope::text AS scope FROM node n JOIN entity k ON k.id=n.entity_id WHERE k.name='fixture.group'")).rows[0]!;
      // `node.id` and `edge.id` come from independent sequences, so one number may name a vertex and an edge. Each pair
      // below holds both rows on one number, with the uid order that decides which row a bare-id map would keep: the
      // vertex is recorded last in the first pair, the edge in the second.
      const pairs = [
        { id: 900001, vertex: 'later-vertex', vertexUid: 'ffffffff-ffff-7fff-bfff-fffffffffff1',
          edge: 'twin-a', edgeUid: '00000000-0000-7000-8000-0000000000a1' },
        { id: 900002, vertex: 'early-vertex', vertexUid: '00000000-0000-7000-8000-0000000000b2',
          edge: 'twin-b', edgeUid: 'ffffffff-ffff-7fff-bfff-fffffffffff2' },
      ] as const;
      for (const pair of pairs) {
        await tx.query(`INSERT INTO node (id,uid,entity_id,key,identity_scope) OVERRIDING SYSTEM VALUE
          VALUES ($1::bigint,$2::uuid,(SELECT id FROM entity WHERE name='fixture.item'),jsonb_build_object('name',$3::text),$4::uuid)`,
          [pair.id, pair.vertexUid, pair.vertex, group.scope]);
        await tx.query(`INSERT INTO edge (id,uid,entity_id,from_node,to_node,discriminator,context_id) OVERRIDING SYSTEM VALUE
          VALUES ($1::bigint,$2::uuid,(SELECT id FROM entity WHERE name='fixture.link'),$1::bigint,$3::bigint,$4::text,1)`,
          [pair.id, pair.edgeUid, Number(group.id), pair.edge]);
        for (const [sort, kind, property, value] of [
          ['vertex', 'fixture.item', 'name', pair.vertex],
          ['vertex', 'fixture.item', '$exists', true],
          ['vertex', 'fixture.item', 'text', `${pair.vertex} value`],
          ['edge', 'fixture.link', '$exists', true],
          ['edge', 'fixture.link', 'text', `${pair.edge} value`],
        ] as const) finalAssertion.set(sort === 'vertex' ? pair.vertex : pair.edge,
          await writeAssertion(tx, contract, {
            sort, kind, subjectId: String(pair.id), property, operation: 'assert', value,
          }, 1));
      }
      // The first pair's edge is withdrawn: it keeps a stream position and an answer that names it, and it is no unit.
      finalAssertion.set(pairs[0].edge, await writeAssertion(tx, contract, {
        sort: 'edge', kind: 'fixture.link', subjectId: String(pairs[0].id), property: '$exists', operation: 'retract',
      }, 1));
      // The fixture writes return the assertion uid, so the sequence each subject's last statement holds is read from the
      // store rather than assumed: the answer's `recordedSequence` is the vertex write precondition the SDK sends back.
      for (const row of (await tx.query<{ uid: string; seq: string }>(
        `SELECT n.uid::text AS uid,a.recorded_sequence::text AS seq FROM assertion a JOIN node n ON n.id=a.assertion_id
         WHERE n.uid=ANY($1::uuid[])`, [[...finalAssertion.values()]])).rows) storedSequences.set(row.uid, row.seq);
    });
    const facts = await producerFacts(owner, contract, TEST_SOURCE_UID, ['fixture.item'], ['fixture.link'], {
      kind: 'fixture.item', ownedEdges: [{ kind: 'fixture.link', from: 'fixture.item', to: 'fixture.group' }],
    });
    const { revisions, coverage: _coverage, ...held } = facts;
    const later = ref('fixture.item', 'later-vertex');
    const earlier = ref('fixture.item', 'early-vertex');
    const to = ref('fixture.group', 'group');
    expect(held).toEqual({
      vertices: [
        { ...earlier, values: { text: 'early-vertex value' } },
        { ...later, values: { text: 'later-vertex value' } },
      ],
      edges: [{ kind: 'fixture.link', from: earlier, to, discriminator: 'twin-b', values: { text: 'twin-b value' } }],
    });
    // The withdrawn edge still answers with its own ends, and every revision names the row its own sequence holds.
    const subjects = revisions.map(revision => canonicalAssertionValue(revision.subject));
    expect(subjects).toEqual([
      canonicalAssertionValue({ sort: 'edge', kind: 'fixture.link', from: later, to, discriminator: 'twin-a' }),
      canonicalAssertionValue({ sort: 'edge', kind: 'fixture.link', from: earlier, to, discriminator: 'twin-b' }),
      canonicalAssertionValue({ sort: 'vertex', ...earlier }),
      canonicalAssertionValue({ sort: 'vertex', ...later }),
    ]);
    expect(subjects).toEqual([...subjects].sort());
    // Each revision names its own subject together with the exact sequence the store holds for that subject's final
    // statement — including the retraction of the withdrawn twin-a edge. A read that answered the colliding vertex with
    // the edge's sequence keeps both subject identities and would still pass a decimal-shape check, but fails here: the
    // SDK sends that value as the vertex write precondition and the writer refuses it with REVISION_CONFLICT.
    const sequenceOf = (subject: string): string => storedSequences.get(finalAssertion.get(subject)!)!;
    const expected = [
      { subject: { sort: 'edge' as const, kind: 'fixture.link', from: later, to, discriminator: 'twin-a' }, recordedSequence: sequenceOf('twin-a') },
      { subject: { sort: 'edge' as const, kind: 'fixture.link', from: earlier, to, discriminator: 'twin-b' }, recordedSequence: sequenceOf('twin-b') },
      { subject: { sort: 'vertex' as const, ...earlier }, recordedSequence: sequenceOf('early-vertex') },
      { subject: { sort: 'vertex' as const, ...later }, recordedSequence: sequenceOf('later-vertex') },
    ];
    expect(revisions.map(revision => ({ subject: canonicalAssertionValue(revision.subject), recordedSequence: revision.recordedSequence })))
      .toEqual(expected.map(revision => ({ subject: canonicalAssertionValue(revision.subject), recordedSequence: revision.recordedSequence })));
    // Four distinct stored positions: a read that swapped two subjects' sequences fails the equality above.
    expect(new Set(expected.map(revision => revision.recordedSequence)).size).toBe(4);
  } finally { await owner.close(); }
}, 30_000);
