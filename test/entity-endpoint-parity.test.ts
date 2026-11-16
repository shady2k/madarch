/** ALX-65: one manifest's Entity implementations are exactly its wildcard endpoints. */
import { expect, test } from 'bun:test';
import { buildSchema, isInterfaceType } from 'graphql';
import { createHash } from 'node:crypto';
import { parseKinds } from '../src/product/manifest/kinds.js';
import { graphContractOf } from '../src/fill/stages/plugin-contract.js';
import { publishedManifestOf } from '../src/graphql/manifest.js';
import { graphqlSchemaOf } from '../src/graphql/schema.js';
import { typeNameOf } from '../src/graphql/names.js';
import { withManifestContract } from '../src/graph/manifest-contract.js';
import { withAssertionContract } from '../src/graph/system-contract.js';
import { assertionValueTableName, type GraphContract, type EntityRefDraft, type VertexDraft } from '../src/graph/contract.js';
import { publishGraphDrafts, requireWriteCapability } from '../src/graph/write.js';
import { installDisputeSelection, refreshDisputeSelection } from '../src/graph/disputes.js';
import { newUid } from '../src/graph/uid.js';
import type { SqlExecutor } from '../src/sql-driver.js';
import { createTestDatabaseOwner } from './test-database.js';

const sorted = (values: Iterable<string>) => [...values].sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
const manifestText = `kinds:
  fixture.anchor:
    source: graph
    title: label
  fixture.record:
    source: graph
    title: label
edges:
- name: fixture.any
  from: [any]
  to: [any]
  repeats: true
  discriminator: place
  labels:
    en: {out: mentions, in: mentioned by}
    ru: {out: mentions, in: mentioned by}
  cardinality:
    from: {min: 0, max: null}
    to: {min: 0, max: null}
`;

/** Clone a complete authenticated header and lineage, never calling writer endpoint validation. */
async function sqlEdge(tx: SqlExecutor, from: string, to: string, discriminator: string, original: string, declared: GraphContract) {
  const edge = (await tx.query<{ id: string }>(`INSERT INTO edge(uid,entity_id,from_node,to_node,discriminator,context_id)
    SELECT $1,id,$2,$3,$4,1 FROM entity WHERE name='fixture.any' RETURNING id::text`,
    [newUid(), from, to, discriminator])).rows[0]!.id;
  const assertion = (await tx.query<{ id: string }>(`INSERT INTO node(entity_id,uid,key,identity_scope,context_id)
    SELECT entity_id,$1,key,identity_scope,context_id FROM node WHERE id=$2 RETURNING id::text`, [newUid(), original])).rows[0]!.id;
  await tx.query(`INSERT INTO assertion(assertion_id,property,language,context_id,valid_from,valid_to,operation)
    SELECT $1,property,language,context_id,valid_from,valid_to,operation FROM assertion WHERE assertion_id=$2`, [assertion, original]);
  await tx.query(`INSERT INTO edge(uid,entity_id,from_node,to_node,discriminator,context_id)
    SELECT gen_random_uuid(),entity_id,$1,to_node,discriminator,context_id FROM edge WHERE from_node=$2`, [assertion, original]);
  await tx.query('INSERT INTO assertion_edge_subject(assertion_id,edge_id) VALUES($1,$2)', [assertion, edge]);
  await tx.query(`INSERT INTO "${assertionValueTableName('fixture.any', 'edge', '$exists')}"(assertion_id,value) VALUES($1,true)`, [assertion]);
  await refreshDisputeSelection(tx, declared);
  expect((await tx.query(`SELECT id FROM graph_edge_active_ids('fixture.any',1) active(id) WHERE id=$1`, [edge])).rows).toHaveLength(1);
  return edge;
}

async function accepted(tx: SqlExecutor, prefix: string, side: 'from' | 'to') {
  return sorted((await tx.query<{ kind: string }>(`SELECT DISTINCT k.name AS kind FROM edge e
    JOIN entity ek ON ek.id=e.entity_id JOIN node n ON n.id=e.${side}_node JOIN entity k ON k.id=n.entity_id
    WHERE ek.name='fixture.any' AND e.discriminator=$1 AND graph_edge_active(e.id,ek.name,1)`, [prefix])).rows.map(row => row.kind));
}

test('ALX-65: schema Entity kinds equal writer and deferred SQL wildcard acceptance on both ends', async () => {
  const manifest = parseKinds(manifestText, `${import.meta.dir}/entity-endpoint-parity.yaml`, import.meta.dir);
  expect(manifest.findings).toEqual([]);
  const declared = withManifestContract(graphContractOf(manifest));
  const effective = withAssertionContract(declared);
  const schema = buildSchema(graphqlSchemaOf(publishedManifestOf(manifest)));
  const entity = schema.getType('Entity');
  if (!isInterfaceType(entity)) throw new Error(`${import.meta.path}:72: Entity must be an interface`);
  const implementations = sorted(schema.getImplementations(entity).objects.map(type => type.name));
  // CatalogueEntity represents catalogue records; it is not a stored vertex kind.
  expect(implementations).toEqual(sorted(['CatalogueEntity', ...effective.vertex.map(kind => typeNameOf(kind.name))]));
  const expected = sorted(effective.vertex.map(kind => kind.name));
  for (const name of ['source', 'person', 'plugin', 'agent', 'agent-session', 'system.assertion', 'manifest.workflow-stage']) expect(expected).toContain(name);
  const owner = await createTestDatabaseOwner({ graphContract: declared });
  try {
    const refs = await owner.transaction('write', async tx => {
      await installDisputeSelection(tx, declared);
      const binding = requireWriteCapability(tx);
      // Reuse host identities: system.product is installation-wide; plugin and operation already have real lineage.
      const refs = new Map<string, EntityRefDraft>([
        ['system.product', { kind: 'system.product', key: {}, uid: binding.productUid }],
        ['plugin', { kind: 'plugin', key: {}, uid: binding.sourceUid }],
        ['system.operation', { kind: 'system.operation', key: {}, uid: binding.operationUid }],
      ]);
      const vertices: VertexDraft[] = effective.vertex.filter(kind => kind.name !== 'system.assertion' && !refs.has(kind.name)).map(kind => {
        const content = 'complete Entity endpoint fixture';
        const key = Object.fromEntries(kind.key.map(name => [name, name === 'digest' ? createHash('sha256').update(content).digest('hex') : `endpoint-${kind.name}`]));
        const ref: EntityRefDraft = { kind: kind.name, key, ...(kind.key.length || kind.keyEdges?.length ? {} : { uid: newUid() }), ...(kind.keyEdges?.length ? { keyEdges: Object.fromEntries(kind.keyEdges.map(role => [role.role, { kind: 'manifest.workflow', key: { name: 'endpoint-manifest.workflow' } }])) } : {}) };
        refs.set(kind.name, ref);
        return { ...ref, producer: 'fixture', producerVersion: '1', ...(kind.evidence?.contentField ? { values: { [kind.evidence.contentField]: content } } : {}) };
      });
      await publishGraphDrafts(tx, declared, { vertices, removals: [] });
      for (const [kind, ref] of refs) {
        if (ref.uid !== undefined) continue;
        const stored = (await tx.query<{ uid: string }>('SELECT n.uid::text FROM node n JOIN entity k ON k.id=n.entity_id WHERE k.name=$1 AND n.key=$2::jsonb', [kind, JSON.stringify(ref.key)])).rows;
        expect(stored).toHaveLength(1);
        refs.set(kind, { ...ref, uid: stored[0]!.uid });
      }
      const assertion = (await tx.query<{ uid: string }>('SELECT n.uid::text FROM assertion a JOIN node n ON n.id=a.assertion_id ORDER BY a.recorded_sequence LIMIT 1')).rows[0]!;
      refs.set('system.assertion', { kind: 'system.assertion', key: {}, uid: assertion.uid });
      await refreshDisputeSelection(tx, declared);
      await tx.query('SET CONSTRAINTS ALL IMMEDIATE');
      return refs;
    });
    await owner.transaction('write', async tx => {
      await installDisputeSelection(tx, declared);
      const anchor = refs.get('fixture.anchor')!;
      await publishGraphDrafts(tx, declared, { vertices: [], removals: [], edges: [...refs.values()].flatMap(ref => [
        { kind: 'fixture.any', from: ref, to: anchor, discriminator: 'writer-from', producer: 'fixture', producerVersion: '1' },
        { kind: 'fixture.any', from: anchor, to: ref, discriminator: 'writer-to', producer: 'fixture', producerVersion: '1' },
      ]) });
      await refreshDisputeSelection(tx, declared);
      await tx.query('SET CONSTRAINTS ALL IMMEDIATE');
    });
    for (const side of ['from', 'to'] as const) expect(await owner.transaction('snapshot', async tx => { await installDisputeSelection(tx, declared); return accepted(tx, `writer-${side}`, side); })).toEqual(expected);
    const original = await owner.run(async tx => (await tx.query<{ id: string }>(`SELECT a.assertion_id::text AS id FROM assertion a
      JOIN assertion_edge_subject s ON s.assertion_id=a.assertion_id JOIN edge e ON e.id=s.edge_id JOIN entity k ON k.id=e.entity_id
      WHERE k.name='fixture.any' AND a.property='$exists' ORDER BY a.recorded_sequence LIMIT 1`)).rows[0]!.id);
    await owner.transaction('write', async tx => {
      const nodes = (await tx.query<{ kind: string; id: string; uid: string }>('SELECT k.name AS kind,n.id::text,n.uid::text FROM node n JOIN entity k ON k.id=n.entity_id')).rows;
      const ids = new Map([...refs].map(([kind, ref]) => [kind, nodes.find(node => node.uid === ref.uid)!.id]));
      const anchor = ids.get('fixture.anchor')!;
      for (const id of ids.values()) {
        await sqlEdge(tx, id, anchor, 'sql-from', original, declared);
        await sqlEdge(tx, anchor, id, 'sql-to', original, declared);
      }
      await refreshDisputeSelection(tx, declared);
      await tx.query('SET CONSTRAINTS ALL IMMEDIATE');
    });
    for (const side of ['from', 'to'] as const) expect(await owner.transaction('snapshot', async tx => { await installDisputeSelection(tx, declared); return accepted(tx, `sql-${side}`, side); })).toEqual(expected);
    const counts = () => owner.run(tx => tx.query(`SELECT (SELECT count(*)::text FROM node) AS nodes,(SELECT count(*)::text FROM edge) AS edges,(SELECT count(*)::text FROM assertion) AS assertions`));
    for (const side of ['from', 'to'] as const) {
      for (const kind of ['fixture.undeclared', 'CatalogueEntity', 'fixture.any']) {
        const before = (await counts()).rows;
        await expect(owner.transaction('write', tx => publishGraphDrafts(tx, declared, { vertices: [], removals: [], edges: [{
          kind: 'fixture.any', from: side === 'from' ? { kind, key: {}, uid: newUid() } : refs.get('fixture.anchor')!,
          to: side === 'to' ? { kind, key: {}, uid: newUid() } : refs.get('fixture.anchor')!, producer: 'fixture', producerVersion: '1',
        }] }))).rejects.toThrow(`UNKNOWN_KIND ${kind}`);
        expect((await counts()).rows).toEqual(before);
      }
      const before = (await counts()).rows;
      let reachedDeferred = false;
      await expect(owner.transaction('write', async tx => {
        const outside = (await tx.query<{ id: string }>(`WITH kind AS (INSERT INTO entity(name,sort) VALUES('fixture.undeclared','node') RETURNING id)
          INSERT INTO node(entity_id,uid,key,identity_scope,context_id) SELECT kind.id,$1,'{}',n.identity_scope,1 FROM kind CROSS JOIN node n LIMIT 1 RETURNING id::text`, [newUid()])).rows[0]!.id;
        const anchor = (await tx.query<{ id: string }>('SELECT id::text FROM node WHERE uid=$1', [refs.get('fixture.anchor')!.uid])).rows[0]!.id;
        await sqlEdge(tx, side === 'from' ? outside : anchor, side === 'to' ? outside : anchor, 'sql-outside', original, declared);
        await refreshDisputeSelection(tx, declared);
        reachedDeferred = true;
        await tx.query('SET CONSTRAINTS ALL IMMEDIATE');
      })).rejects.toThrow('TARGET_MISSING or END_KIND_INVALID for fixture.any');
      expect(reachedDeferred).toBe(true);
      expect((await counts()).rows).toEqual(before);
    }
  } finally { await owner.close(); }
}, 120_000); // Measured 22.27 s on 2026-11-16 across all effective Entity kinds.
