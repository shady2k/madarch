/**
 * The temporal graph store's checks (decision 0028, "Constraints"), written
 * once and run by two files: `graph-store.test.ts` on PGlite and
 * `graph-store-postgres.test.ts` on a server. Every graph here is small and
 * written out; each expected answer is derived by hand from decision 0028,
 * never from the store's own code.
 *
 * The dates are days of January 2026: `day(3)` is 2026-01-03T00:00Z.
 */
import { createHash } from 'node:crypto';
import { describe, expect, test } from 'bun:test';
import type { DatabaseOwner } from '../src/adapters/database-owner.js';
import { createGraphStore, type GraphId, type GraphLens, type GraphStore } from '../src/graph/index.js';

export const day = (n: number, hours = 0): Date => new Date(Date.UTC(2026, 0, n, hours));
const sha = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex');
const BOUND = 30_000;

export interface Env {
  owner: DatabaseOwner;
  store: GraphStore;
  setClock(date: Date): void;
  /** The scope node of producer `p1`. */
  scope: GraphId;
  own(producer?: string, scope?: GraphId): { producer: string; scope: GraphId };
  query<Row extends object = Record<string, unknown>>(sql: string, values?: readonly unknown[]): Promise<Row[]>;
  count(table: string): Promise<number>;
}

/** A timestamptz column as UTC text, whatever the session's time zone. */
const iso = (column: string): string => `CASE WHEN ${column} = 'infinity' THEN 'infinity' ELSE to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') END`;

const TABLES = ['work_item', 'edge_version', 'node_version', 'edge_identity', 'node_identity', 'relation_type', 'node_kind'];

/** Drops the graph's tables and creates them again with a registry of neutral example names. */
async function fresh(owner: DatabaseOwner, withRegistry = true): Promise<Env> {
  await owner.run(async (tx) => {
    await tx.query(`DROP TABLE IF EXISTS ${TABLES.join(', ')} CASCADE`);
  });
  let clock = day(1);
  const store = createGraphStore(owner, { now: () => clock });
  await store.createSchema();
  if (withRegistry) await store.registerVocabulary({ kinds: ['component', 'datastore', 'note'], relations: [{ key: 'uses' }, { key: 'foreign-key', discriminated: true }] });
  const scope = await store.newNode();
  const query = async <Row extends object>(sql: string, values?: readonly unknown[]): Promise<Row[]> => (await owner.run((tx) => tx.query<Row>(sql, values))).rows;
  return {
    owner,
    store,
    setClock: (date) => {
      clock = date;
    },
    scope,
    own: (producer = 'p1', s = scope) => ({ producer, scope: s }),
    query,
    count: async (table) => Number((await query<{ n: string }>(`SELECT count(*)::text AS n FROM ${table}`))[0]!.n),
  };
}

async function node(env: Env, label: string, extra: Record<string, unknown> = {}): Promise<{ nodeId: GraphId; versionId: GraphId }> {
  return await env.store.openNode({ kind: 'component', label, validFrom: day(1), owner: env.own(), ...extra } as never);
}

async function edge(env: Env, src: GraphId, dst: GraphId, extra: Record<string, unknown> = {}, relation = 'uses'): Promise<{ edgeId: GraphId; versionId: GraphId }> {
  return await env.store.openEdge({ relation, src, dst, validFrom: day(1), owner: env.own(), ...extra } as never);
}

const labels = (rows: { label: string }[]): string[] => rows.map((r) => r.label).sort();

async function refused(promise: Promise<unknown>, pattern: RegExp): Promise<void> {
  let message: string | undefined;
  try {
    await promise;
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  if (message === undefined) throw new Error(`expected a refusal matching ${pattern}, but the operation succeeded`);
  expect(message).toMatch(pattern);
}

/** A version row without its closing columns: what must never change once written. */
async function frozenRows(env: Env): Promise<Map<string, string>> {
  const rows = await env.query<{ t: string; id: string; body: string }>(
    `SELECT 'node' AS t, id::text AS id, (to_jsonb(v) - 'recorded_to' - 'closed_by' - 'closed_as')::text AS body FROM node_version v
     UNION ALL SELECT 'edge', id::text, (to_jsonb(e) - 'recorded_to' - 'closed_by' - 'closed_as')::text FROM edge_version e`,
  );
  return new Map(rows.map((r) => [`${r.t}:${r.id}`, r.body]));
}

export function graphStoreTests(label: string, getOwner: () => DatabaseOwner): void {
  const run = (name: string, body: (env: Env) => Promise<void>): void => {
    test(name, async () => {
      await body(await fresh(getOwner()));
    }, BOUND);
  };

  describe(`temporal graph store on ${label}`, () => {
    run('graph-only: the module creates exactly the graph tables, and btree_gist is loaded', async (env) => {
      const tables = await env.query<{ table_name: string }>(`SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() AND table_type = 'BASE TABLE' ORDER BY table_name`);
      expect(tables.map((t) => t.table_name)).toEqual(['edge_identity', 'edge_version', 'node_identity', 'node_kind', 'node_version', 'relation_type', 'work_item']);
      expect((await env.query(`SELECT 1 FROM pg_extension WHERE extname = 'btree_gist'`)).length).toBe(1);
      // A second createSchema changes nothing.
      const before = await env.count('node_kind');
      await env.store.createSchema();
      expect(await env.count('node_kind')).toBe(before);
    });

    run('schema: exclusion constraints, current partial indexes and the historical GiST index exist', async (env) => {
      const exclusion = await env.query<{ conrelid: string }>(`SELECT conrelid::regclass::text AS conrelid FROM pg_constraint WHERE contype = 'x' ORDER BY 1`);
      expect(exclusion.map((c) => c.conrelid.replace(/^.*\./, ''))).toEqual(['edge_version', 'node_version']);
      const indexes = await env.query<{ indexname: string; indexdef: string }>(`SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = current_schema()`);
      const current = indexes.filter((i) => /WHERE \(?recorded_to = 'infinity'/.test(i.indexdef)).map((i) => i.indexname).sort();
      expect(current).toEqual(['edge_version_current_dst', 'edge_version_current_edge', 'edge_version_current_src', 'node_version_current', 'node_version_current_kind']);
      const historical = indexes.filter((i) => /USING gist/.test(i.indexdef) && /states/.test(i.indexdef) && !/EXCLUDE/.test(i.indexdef)).map((i) => i.indexname).sort();
      expect(historical).toEqual(['edge_version_history_dst', 'edge_version_history_src', 'node_version_history', 'edge_version_no_overlap', 'node_version_no_overlap'].sort());
      const types = await env.query<{ column_name: string; data_type: string }>(
        `SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'node_version' AND column_name IN ('valid_from','valid_to','recorded_from','recorded_to','states') ORDER BY column_name`,
      );
      expect(types.map((t) => `${t.column_name}:${t.data_type}`)).toEqual(['recorded_from:timestamp with time zone', 'recorded_to:timestamp with time zone', 'states:int8range', 'valid_from:timestamp with time zone', 'valid_to:timestamp with time zone']);
    });

    run('no-overlap: versions of one identity that overlap on valid time, recorded time and states are refused', async (env) => {
      // X holds in states [1,5) for valid days 1..10, recorded from day 1.
      const x = await node(env, 'X', { validTo: day(10), states: { from: 1, to: 5 } });
      // Overlaps on all three axes (days 5..20, states [3,8)): refused.
      await refused(node(env, 'X-overlap', { nodeId: x.nodeId, validFrom: day(5), validTo: day(20), states: { from: 3, to: 8 } }), /no-overlap/);
      // Disjoint on states ([5,8)): accepted. Disjoint on valid time (day 10 on): accepted.
      await node(env, 'X-other-states', { nodeId: x.nodeId, validTo: day(10), states: { from: 5, to: 8 } });
      await node(env, 'X-later', { nodeId: x.nodeId, validFrom: day(10), validTo: day(20), states: { from: 1, to: 5 } });
      expect(await env.count('node_version')).toBe(3); // X, X-other-states, X-later (the scope node has no version)
      // Disjoint on recorded time: the overlapping valid/state range is accepted once the earlier belief is closed.
      env.setClock(day(2));
      await env.store.correctNode(x.versionId, { label: 'X-corrected' });
      expect((await env.query(`SELECT label FROM node_version WHERE node_id = ${x.nodeId} AND recorded_to = 'infinity' AND states = int8range(1,5) ORDER BY valid_from`)).map((r) => (r as { label: string }).label)).toEqual(['X-corrected', 'X-later']);
      // An edge identity is the same relation between the same ends: its overlapping versions are refused too.
      const y = await node(env, 'Y');
      await edge(env, x.nodeId, y.nodeId, { validTo: day(8), states: { from: 1, to: 5 } });
      await refused(edge(env, x.nodeId, y.nodeId, { validFrom: day(7), validTo: day(9), states: { from: 2, to: 4 } }), /no-overlap/);
    });

    run('no-overlap: null and empty ranges are refused by the database itself', async (env) => {
      const a = await node(env, 'A', { validTo: day(10) });
      const b = await node(env, 'B');
      const e = await edge(env, a.nodeId, b.nodeId, { validTo: day(10) });
      const copyNode = (set: string): string => `INSERT INTO node_version (node_id, kind_id, label, valid_from, valid_to, recorded_from, states, producer, scope_id, payload_digest, properties)
        SELECT node_id, kind_id, label, ${set} FROM node_version WHERE id = ${a.versionId}`;
      const base = { valid_from: 'valid_from', valid_to: 'valid_to', recorded_from: 'recorded_from', states: 'states' };
      const attempt = (over: Partial<typeof base>): string => {
        const m = { ...base, ...over };
        return copyNode(`${m.valid_from}, ${m.valid_to}, ${m.recorded_from}, ${m.states}, producer, scope_id, payload_digest, properties`);
      };
      await refused(env.query(attempt({ valid_from: 'NULL' })), /null value|not-null/i);
      await refused(env.query(attempt({ valid_to: 'valid_from' })), /check constraint|violates/i);
      await refused(env.query(attempt({ recorded_from: 'NULL' })), /null value|not-null/i);
      await refused(env.query(attempt({ states: 'NULL' })), /null value|not-null/i);
      await refused(env.query(attempt({ states: 'int8range(3, 3)' })), /check constraint|violates/i);
      await refused(env.query(attempt({ states: 'int8range(3, NULL)' })), /check constraint|violates/i);
      const edgeCopy = `INSERT INTO edge_version (edge_id, relation_type_id, src_id, dst_id, valid_from, valid_to, recorded_from, states, producer, scope_id, payload_digest, properties)
        SELECT edge_id, relation_type_id, src_id, dst_id, `;
      await refused(env.query(`${edgeCopy}valid_from, valid_from, recorded_from, states, producer, scope_id, payload_digest, properties FROM edge_version WHERE id = ${e.versionId}`), /check constraint|violates/i);
      await refused(env.query(`${edgeCopy}valid_from, valid_to, recorded_from, int8range(5, 5), producer, scope_id, payload_digest, properties FROM edge_version WHERE id = ${e.versionId}`), /check constraint|violates/i);
      await refused(env.query(`${edgeCopy}valid_from, valid_to, NULL, states, producer, scope_id, payload_digest, properties FROM edge_version WHERE id = ${e.versionId}`), /null value|not-null/i);
      // Through the store, an empty valid range or state span is refused before it reaches the database.
      await refused(node(env, 'C', { validFrom: day(5), validTo: day(5) }), /valid range must not be empty/);
      await refused(node(env, 'D', { states: { from: 4, to: 4 } }), /state span must not be empty/);
      expect(await env.count('node_version')).toBe(2);
    });

    run('append-only: only recorded_to is ever closed; no other column changes and nothing is deleted', async (env) => {
      const seen = new Map<string, string>();
      const check = async (step: string): Promise<void> => {
        const now = await frozenRows(env);
        for (const [id, body] of seen) {
          expect(now.has(id), `${step}: row ${id} was deleted`).toBe(true);
          expect(now.get(id), `${step}: row ${id} changed beyond its closing`).toBe(body);
        }
        for (const [id, body] of now) seen.set(id, body);
      };
      const a = await node(env, 'A');
      const b = await node(env, 'B');
      const e = await edge(env, a.nodeId, b.nodeId);
      await check('opening');
      env.setClock(day(2));
      await env.store.correctNode(a.versionId, { label: 'A2' });
      await env.store.correctEdge(e.versionId, { properties: { weight: 2 } });
      await check('corrections');
      env.setClock(day(3));
      const bVersions = await env.query<{ id: string }>(`SELECT id::text AS id FROM node_version WHERE node_id = ${b.nodeId} AND recorded_to = 'infinity'`);
      await env.store.correctNode(bVersions[0]!.id, { label: 'B-renamed' });
      await check('rename');
      env.setClock(day(4));
      await env.store.endNode(b.nodeId, day(3));
      await check('end with cascade');
      env.setClock(day(5));
      const live = await env.query<{ id: string }>(`SELECT id::text AS id FROM node_version WHERE node_id = ${a.nodeId} AND recorded_to = 'infinity'`);
      await env.store.removeVersion('node_version', live[0]!.id);
      await check('removal');
      // The database refuses what the store never does.
      await refused(env.query(`UPDATE node_version SET label = 'rewritten' WHERE id = ${a.versionId}`), /append-only/);
      await refused(env.query(`UPDATE edge_version SET properties = '{}' WHERE id = ${e.versionId}`), /append-only/);
      await refused(env.query(`DELETE FROM node_version WHERE id = ${a.versionId}`), /append-only/);
      await refused(env.query(`DELETE FROM edge_version WHERE id = ${e.versionId}`), /append-only/);
      // A closed version cannot be reopened or closed again.
      await refused(env.query(`UPDATE node_version SET recorded_to = 'infinity', closed_as = NULL WHERE id = ${a.versionId}`), /append-only/);
      await refused(env.query(`UPDATE node_version SET recorded_to = '2026-02-01T00:00:00Z' WHERE id = ${a.versionId}`), /append-only/);
      await check('refused rewrites');
    });

    run('known-then: a correction learned on day 2 about day 1 reads old at known day 1 and new at known day 2', async (env) => {
      env.setClock(day(1, 12));
      const a = await node(env, 'billing', { validFrom: day(1) });
      env.setClock(day(2, 12));
      await env.store.correctNode(a.versionId, { label: 'payments' });
      const at = async (known: Date | undefined): Promise<string | undefined> => (await env.store.node(a.nodeId, { valid: day(1, 18), ...(known === undefined ? {} : { known }) }))?.label;
      expect(await at(day(1, 18))).toBe('billing');
      expect(await at(day(2, 18))).toBe('payments');
      expect(await at(day(2, 12))).toBe('payments'); // the moment the correction was recorded
      // Before the store held it, the answer is "not recorded", never a guess.
      expect(await at(day(1, 6))).toBeUndefined();
      // The default is now: after the correction, the new belief.
      env.setClock(day(3));
      expect((await env.store.node(a.nodeId, { valid: day(1, 18) }))?.label).toBe('payments');
    });

    describe('every-hop', () => {
      // Each scenario is the chain A -> B -> C with exactly one hop blocked, read at the lens
      // {valid: day 6, known: day 6, state as-is}. Blocking the first hop leaves A reaching nothing;
      // blocking the second leaves A reaching exactly B. A control lens, under which nothing is
      // blocked, reaches B and C, so a passing test is not an empty graph.
      type Blocker = 'expired-edge' | 'expired-end-node' | 'edge-recorded-later' | 'end-node-recorded-later' | 'other-state';
      const lens: GraphLens = { valid: day(6), known: day(6) };
      const controlFor = (blocker: Blocker): GraphLens =>
        blocker === 'other-state' ? { ...lens, state: 2 } : blocker === 'edge-recorded-later' || blocker === 'end-node-recorded-later' ? { valid: day(6), known: day(9) } : { valid: day(3), known: day(6) };

      /** An edge written past the write path, so the read's own filter is what is tested. */
      const rawEdge = async (env: Env, src: GraphId, dst: GraphId): Promise<void> => {
        const identity = await env.query<{ id: string }>(`INSERT INTO edge_identity (key_hash) VALUES ('${sha(`raw-edge-${src}-${dst}`)}') RETURNING id::text AS id`);
        await env.query(
          `INSERT INTO edge_version (edge_id, relation_type_id, src_id, dst_id, valid_from, valid_to, recorded_from, states, producer, scope_id, payload_digest, properties)
           SELECT ${identity[0]!.id}, id, ${src}, ${dst}, '2026-01-01T00:00:00Z', 'infinity', '2026-01-01T00:00:00Z', int8range(0, 100), 'raw', ${env.scope}, 'raw', '{}' FROM relation_type WHERE key = 'uses'`,
        );
      };

      /** Builds the chain with hop `blocked` (1 = A to B, 2 = B to C) blocked; the clock only moves forward. A is node 2 (node 1 is the scope). */
      const build = async (env: Env, blocker: Blocker, blocked: 1 | 2): Promise<void> => {
        const a = (await node(env, 'A')).nodeId;
        if (blocker === 'end-node-recorded-later') {
          if (blocked === 1) {
            const c = (await node(env, 'C')).nodeId;
            env.setClock(day(8));
            const b = (await node(env, 'B')).nodeId;
            await edge(env, b, c);
            await rawEdge(env, a, b);
          } else {
            const b = (await node(env, 'B')).nodeId;
            await edge(env, a, b);
            env.setClock(day(8));
            const c = (await node(env, 'C')).nodeId;
            await rawEdge(env, b, c);
          }
          return;
        }
        const endsDay5 = blocker === 'expired-end-node';
        const b = (await node(env, 'B', endsDay5 && blocked === 1 ? { validTo: day(5) } : {})).nodeId;
        const c = (await node(env, 'C', endsDay5 && blocked === 2 ? { validTo: day(5) } : {})).nodeId;
        const ends: [GraphId, GraphId][] = [[a, b], [b, c]];
        const normal = async (hop: 1 | 2): Promise<void> => {
          const [src, dst] = ends[hop - 1]!;
          await edge(env, src, dst, endsDay5 && blocked === 1 && hop === 2 ? { validTo: day(5) } : {});
        };
        const block = async (hop: 1 | 2): Promise<void> => {
          const [src, dst] = ends[hop - 1]!;
          switch (blocker) {
            case 'expired-edge':
              await edge(env, src, dst, { validTo: day(5) });
              return;
            case 'expired-end-node':
              await rawEdge(env, src, dst);
              return;
            case 'edge-recorded-later':
              env.setClock(day(8));
              await edge(env, src, dst);
              return;
            case 'other-state':
              await edge(env, src, dst, { states: { from: 2, to: 3 } });
          }
        };
        const open: 1 | 2 = blocked === 1 ? 2 : 1;
        await normal(open);
        await block(blocked);
      };

      run('every-hop: an expired source node blocks an edge that still claims to hold', async (env) => {
        // A ended on day 5; the edge A -> B was written past the write path and claims to hold forever.
        const a = (await node(env, 'A', { validTo: day(5) })).nodeId;
        const b = (await node(env, 'B')).nodeId;
        await rawEdge(env, a, b);
        const walk = async (l: GraphLens): Promise<string[]> => labels((await env.store.traverse(a, ['uses'], 'out', l)).rows);
        expect(await walk({ valid: day(6), known: day(6) })).toEqual([]);
        expect((await env.store.callers(b, { valid: day(6), known: day(6) }, { relation: 'uses' })).rows).toEqual([]);
        expect(await walk({ valid: day(3), known: day(6) })).toEqual(['B']);
        expect((await env.store.callers(b, { valid: day(3), known: day(6) }, { relation: 'uses' })).rows.map((r) => r.src.label)).toEqual(['A']);
      });

      for (const blocker of ['expired-edge', 'expired-end-node', 'edge-recorded-later', 'end-node-recorded-later', 'other-state'] as const) {
        run(`every-hop: ${blocker} blocking the only path returns nothing`, async (env) => {
          await build(env, blocker, 1);
          const reach = async (l: GraphLens): Promise<string[]> => labels((await env.store.traverse('2', ['uses'], 'out', l)).rows);
          expect(await reach(lens)).toEqual([]);
          expect((await env.store.callees('2', lens, { relation: 'uses' })).rows).toEqual([]);
          expect(await reach(controlFor(blocker))).toEqual(['B', 'C']);
        });

        run(`every-hop: ${blocker} on the second hop stops the walk at B`, async (env) => {
          await build(env, blocker, 2);
          const reach = async (l: GraphLens): Promise<string[]> => labels((await env.store.traverse('2', ['uses'], 'out', l)).rows);
          expect(await reach(lens)).toEqual(['B']);
          expect(await reach(controlFor(blocker))).toEqual(['B', 'C']);
        });
      }
    });

    run('endpoint-integrity: an edge whose end is missing for part of its valid time, known time or states is refused', async (env) => {
      const a = await node(env, 'A');
      // B holds on days 5..9 and in states [2,4) only.
      const b = await node(env, 'B', { validFrom: day(5), validTo: day(9), states: { from: 2, to: 4 } });
      await refused(edge(env, a.nodeId, b.nodeId), /endpoint-integrity.*node 3 does not exist for the whole/s);
      await refused(edge(env, a.nodeId, b.nodeId, { validFrom: day(5), validTo: day(9) }), /endpoint-integrity.*states/s);
      await refused(edge(env, a.nodeId, b.nodeId, { validFrom: day(4), validTo: day(9), states: { from: 2, to: 4 } }), /endpoint-integrity/);
      await refused(edge(env, a.nodeId, b.nodeId, { validFrom: day(5), validTo: day(10), states: { from: 2, to: 4 } }), /endpoint-integrity/);
      await refused(edge(env, a.nodeId, '999'), /node 999 does not exist/);
      await edge(env, a.nodeId, b.nodeId, { validFrom: day(5), validTo: day(9), states: { from: 2, to: 4 } });
      // Two adjacent versions of an end together cover an edge across them; a gap does not.
      const c = await node(env, 'C', { validTo: day(3) });
      await node(env, 'C2', { nodeId: c.nodeId, validFrom: day(3), validTo: day(9) });
      await edge(env, a.nodeId, c.nodeId, { validFrom: day(2), validTo: day(8) });
      const d = await node(env, 'D', { validTo: day(3) });
      await node(env, 'D2', { nodeId: d.nodeId, validFrom: day(5), validTo: day(9) });
      await refused(edge(env, a.nodeId, d.nodeId, { validFrom: day(1), validTo: day(9) }), /endpoint-integrity.*valid \[2026-01-03T00:00:00\.000000Z, 2026-01-05/s);
      // A correction that would strand an edge is refused; ending the node is the way and trims the edge.
      env.setClock(day(2));
      const cVersions = await env.query<{ id: string }>(`SELECT id::text AS id FROM node_version WHERE node_id = ${c.nodeId} AND valid_from = '2026-01-03T00:00:00Z'`);
      await refused(env.store.correctNode(cVersions[0]!.id, { validTo: day(6) }), /endpoint-integrity.*endNode/s);
    });

    run('endpoint-integrity: producer A ends a node producer B\'s edge points to; the edge is closed as a recorded cascade', async (env) => {
      const scopeA = await env.store.newNode();
      const scopeB = await env.store.newNode();
      env.setClock(day(2));
      const workA1 = await env.store.openWorkItem({ producer: 'A', scope: scopeA, generation: 1, inputDigest: 'a1', leaseToken: 'ta1', leaseUntil: day(30) });
      const workB1 = await env.store.openWorkItem({ producer: 'B', scope: scopeB, generation: 1, inputDigest: 'b1', leaseToken: 'tb1', leaseUntil: day(30) });
      const pubA = await env.store.publish({ producer: 'A', scope: scopeA, generation: 1, leaseToken: 'ta1', inputDigest: 'a1', nodes: [{ ref: 'n', kind: 'component', label: 'N', validFrom: day(1) }] });
      const n = pubA.refs['n']!;
      const pubB = await env.store.publish({
        producer: 'B', scope: scopeB, generation: 1, leaseToken: 'tb1', inputDigest: 'b1',
        nodes: [{ ref: 'm', kind: 'component', label: 'M', validFrom: day(1) }],
        edges: [{ relation: 'uses', src: { ref: 'm' }, dst: { id: n }, validFrom: day(1) }],
      });
      const m = pubB.refs['m']!;
      expect(pubB.edgeVersionsOpened).toBe(1);
      // Day 3: A learns N ended on day 2 (valid time) and publishes that.
      env.setClock(day(3));
      const workA2 = await env.store.openWorkItem({ producer: 'A', scope: scopeA, generation: 2, inputDigest: 'a2', leaseToken: 'ta2', leaseUntil: day(30) });
      const ended = await env.store.publish({ producer: 'A', scope: scopeA, generation: 2, leaseToken: 'ta2', inputDigest: 'a2', ends: [{ node: { id: n }, validTo: day(2) }] });
      expect(ended.cascades.length).toBe(1);
      const versions = await env.query<{ valid_to: string; closed_as: string | null; closed_by: string | null; producer: string; opened_by: string | null }>(
        `SELECT ${iso('valid_to')} AS valid_to, closed_as, closed_by::text AS closed_by, producer, opened_by::text AS opened_by FROM edge_version WHERE src_id = ${m} ORDER BY id`,
      );
      expect(versions.length).toBe(2);
      // The old version is closed as a cascade naming A's publication; B's edge keeps its producer.
      expect(versions[0]!.closed_as).toBe('cascade');
      expect(versions[0]!.closed_by).toBe(workA2);
      expect(versions[0]!.valid_to).toBe('infinity');
      expect(versions[1]!.producer).toBe('B');
      expect(versions[1]!.opened_by).toBe(workA2);
      expect(versions[1]!.valid_to).toBe('2026-01-02T00:00:00Z');
      expect(workA1).not.toBe(workA2);
      expect(workB1).not.toBe(workA2);
      // Reads: valid day 1 12:00 sees the edge; valid day 3 does not; the belief at known day 2 12:00 still has the edge on day 3.
      const sees = async (l: GraphLens): Promise<number> => (await env.store.callees(m, l, { relation: 'uses' })).rows.length;
      expect(await sees({ valid: day(1, 12), known: day(4) })).toBe(1);
      expect(await sees({ valid: day(3), known: day(4) })).toBe(0);
      expect(await sees({ valid: day(3), known: day(2, 12) })).toBe(1);
      // B runs again on the same edge: it does not reopen the edge while its end is gone, and writes nothing.
      env.setClock(day(4));
      await env.store.openWorkItem({ producer: 'B', scope: scopeB, generation: 2, inputDigest: 'b2', leaseToken: 'tb2', leaseUntil: day(30) });
      const before = await env.count('edge_version');
      const again = await env.store.publish({
        producer: 'B', scope: scopeB, generation: 2, leaseToken: 'tb2', inputDigest: 'b2',
        nodes: [{ id: m, kind: 'component', label: 'M', validFrom: day(1) }],
        edges: [{ relation: 'uses', src: { id: m }, dst: { id: n }, validFrom: day(1) }],
      });
      expect(again.edgeVersionsOpened).toBe(0);
      expect(again.unchanged).toBe(2);
      expect(await env.count('edge_version')).toBe(before);
      // Producer A cannot end B's node.
      env.setClock(day(5));
      await env.store.openWorkItem({ producer: 'A', scope: scopeA, generation: 3, inputDigest: 'a3', leaseToken: 'ta3', leaseUntil: day(30) });
      await refused(env.store.publish({ producer: 'A', scope: scopeA, generation: 3, leaseToken: 'ta3', inputDigest: 'a3', ends: [{ node: { id: m }, validTo: day(4) }] }), /fenced-publication.*belongs to producer "B"/s);
    });

    run('endpoint-integrity: ending a node while an edge to it is inserted never leaves an edge past the end', async (env) => {
      const a = await node(env, 'A');
      const b = await node(env, 'B');
      env.setClock(day(2));
      const results = await Promise.allSettled([env.store.endNode(b.nodeId, day(5)), edge(env, a.nodeId, b.nodeId)]);
      expect(results[0]!.status).toBe('fulfilled');
      // Either the edge was refused (the end came first) or it was inserted and the end trimmed it (the edge came first).
      const strays = await env.query(`SELECT 1 FROM edge_version WHERE recorded_to = 'infinity' AND valid_to > '2026-01-05T00:00:00Z'`);
      expect(strays).toEqual([]);
      if (results[1]!.status === 'rejected') expect(String((results[1] as PromiseRejectedResult).reason)).toMatch(/endpoint-integrity/);
    });

    run('states-stable: a transition state takes a key in a gap and leaves every existing version unchanged', async (env) => {
      const state = (label: string, key: number, extra: Record<string, unknown> = {}) =>
        env.store.openNode({ kind: 'engine:state', label, properties: { stateKey: key }, validFrom: day(1), owner: env.own(), ...extra });
      await state('as-is', 1000);
      await state('to-be', 3000);
      // X holds in every state of the chain; P is planned for to-be only.
      const x = await node(env, 'X', { states: { from: 1000, to: 3001 } });
      const p = await node(env, 'P', { states: { from: 3000, to: 3001 } });
      const lensAt = (known: Date, s: GraphLens['state']): GraphLens => ({ valid: day(5), known, state: s });
      const read = async (known: Date, s: GraphLens['state']): Promise<string[]> => {
        const out: string[] = [];
        for (const id of [x.nodeId, p.nodeId]) {
          const seen = await env.store.node(id, lensAt(known, s));
          if (seen !== null) out.push(seen.label);
        }
        return out;
      };
      expect((await env.store.stateChain({ valid: day(5), known: day(1, 12) })).map((c) => c.stateKey)).toEqual([1000, 3000]);
      expect(await read(day(1, 12), 'as-is')).toEqual(['X']);
      expect(await read(day(1, 12), 'to-be')).toEqual(['X', 'P']);
      const rowsBefore = await frozenRows(env);
      const toBeBefore = await read(day(1, 12), 'to-be');
      // Day 2: a transition state between as-is and to-be.
      env.setClock(day(2));
      await state('transition', 2000);
      const rowsAfter = await frozenRows(env);
      for (const [id, body] of rowsBefore) expect(rowsAfter.get(id)).toBe(body);
      const closed = await env.query(`SELECT 1 FROM node_version WHERE recorded_to <> 'infinity'`);
      expect(closed).toEqual([]); // no existing version was even closed
      expect((await env.store.stateChain({ valid: day(5), known: day(2, 12) })).map((c) => c.stateKey)).toEqual([1000, 2000, 3000]);
      expect(await read(day(2, 12), 2000)).toEqual(['X']);
      expect(await read(day(2, 12), 'to-be')).toEqual(['X', 'P']);
      // A read of to-be at the earlier known time follows the earlier chain, and reads as it did.
      expect(await read(day(1, 12), 'to-be')).toEqual(toBeBefore);
      expect((await env.store.stateChain({ valid: day(5), known: day(1, 12) })).map((c) => c.stateKey)).toEqual([1000, 3000]);
      // A key is never reused by another state.
      await refused(state('another transition', 2000), /states-stable.*state key 2000/);
    });

    run('states-stable: reordering two states gives new keys and leaves the earlier known time\'s reading unchanged', async (env) => {
      const state = (label: string, key: number) => env.store.openNode({ kind: 'engine:state', label, properties: { stateKey: key }, validFrom: day(1), owner: env.own() });
      await state('as-is', 1000);
      const t = await state('transition', 2000);
      const b = await state('to-be', 3000);
      // Q is planned for the to-be state only.
      const q = await node(env, 'Q', { states: { from: 3000, to: 3001 } });
      const lensAt = (known: Date, s: GraphLens['state']): GraphLens => ({ valid: day(5), known, state: s });
      const readQ = async (known: Date, s: GraphLens['state']): Promise<boolean> => (await env.store.node(q.nodeId, lensAt(known, s))) !== null;
      expect(await readQ(day(1, 12), 'to-be')).toBe(true);
      const keysBefore = (await env.store.stateChain({ valid: day(5), known: day(1, 12) })).map((c) => `${c.label}:${c.stateKey}`);
      // Day 3: the two states swap places. The old state nodes close; new nodes with new keys, in the new order, take over.
      env.setClock(day(3));
      await env.store.removeVersion('node_version', t.versionId);
      await env.store.removeVersion('node_version', b.versionId);
      await state('to-be (was second)', 4000);
      await state('transition (was first)', 5000);
      // The extraction re-expresses Q's states over the new keys: Q follows the state that was to-be, now key 4000.
      await env.store.correctNode(q.versionId, { states: { from: 4000, to: 4001 } });
      expect((await env.store.stateChain({ valid: day(5), known: day(3, 12) })).map((c) => c.stateKey)).toEqual([1000, 4000, 5000]);
      expect((await env.store.stateChain({ valid: day(5), known: day(1, 12) })).map((c) => `${c.label}:${c.stateKey}`)).toEqual(keysBefore);
      // Earlier known time: to-be resolves to 3000 and Q is there, exactly as before the reorder.
      expect(await readQ(day(1, 12), 'to-be')).toBe(true);
      // Now: to-be resolves to the last key (5000), where Q is not; state 4000 holds Q.
      expect(await readQ(day(3, 12), 'to-be')).toBe(false);
      expect(await readQ(day(3, 12), 4000)).toBe(true);
      // The old keys stay taken.
      await refused(state('reuse', 3000), /states-stable.*state key 3000/);
    });

    run('acceptance-bound: a changed statement reads as proposed; the earlier version stays accepted at the earlier known time', async (env) => {
      const subject = await node(env, 'orders service'); // identity 2
      const claim = { statement: 'Orders owns payments', claimKind: 'ownership', subjects: [subject.nodeId], evidence: [] };
      env.setClock(day(1, 6));
      const c = await env.store.openNode({ kind: 'engine:claim', label: 'ownership claim', properties: {}, claim, validFrom: day(1), owner: env.own('agent') });
      // 0028: the digest is the SHA-256 of the canonical form, field names sorted by code point.
      const d1 = sha('{"claimKind":"ownership","evidence":[],"statement":"Orders owns payments","subjects":["2"]}');
      expect((await env.store.node(c.nodeId, { known: day(1, 7) }))?.claimDigest).toBe(d1);
      const statusAt = async (known: Date): Promise<string | undefined> => (await env.store.claims({ valid: day(5), known })).rows.find((r) => r.node.nodeId === c.nodeId)?.status;
      expect(await statusAt(day(1, 7))).toBe('proposed'); // nobody accepted it yet
      // Day 2: an acceptance, authored in git, names the digest.
      env.setClock(day(2));
      await env.store.openNode({ kind: 'engine:acceptance', label: 'accepted by Ada', properties: { digest: d1, person: 'Ada', role: 'architect' }, validFrom: day(2), owner: env.own('git') });
      expect(await statusAt(day(2, 12))).toBe('accepted');
      // Day 3: the statement changes: a new claim version with a new digest, proposed.
      env.setClock(day(3));
      await env.store.correctNode(c.versionId, { claim: { ...claim, statement: 'Orders owns invoicing' } });
      const d2 = sha('{"claimKind":"ownership","evidence":[],"statement":"Orders owns invoicing","subjects":["2"]}');
      expect(d2).not.toBe(d1);
      expect((await env.store.node(c.nodeId, { known: day(3, 12) }))?.claimDigest).toBe(d2);
      expect(await statusAt(day(3, 12))).toBe('proposed');
      expect(await statusAt(day(2, 12))).toBe('accepted'); // the earlier version stays accepted for the known times it held
      // Day 4: an acceptance of the new digest.
      env.setClock(day(4));
      await env.store.openNode({ kind: 'engine:acceptance', label: 'accepted by Ada', properties: { digest: d2, person: 'Ada', role: 'architect' }, validFrom: day(4), owner: env.own('git') });
      expect(await statusAt(day(4, 12))).toBe('accepted');
      expect(await statusAt(day(3, 12))).toBe('proposed');
    });

    run('acceptance-bound: the revision digest sorts subjects and evidence by code point and only claims carry one', async (env) => {
      const h1 = sha('first');
      const h2 = sha('second');
      const [low, high] = h1 < h2 ? [h1, h2] : [h2, h1];
      // Subjects "9" and "10" sort as text: "10" before "9". Evidence is written in the wrong order, and a duplicate collapses.
      const claim = {
        statement: 'S', claimKind: 'k', subjects: ['9', '10', '9'],
        evidence: [{ contentSha256: high, start: 3, end: 9 }, { contentSha256: low, start: 0, end: 5 }, { contentSha256: low, start: 0, end: 5 }],
      };
      const c = await env.store.openNode({ kind: 'engine:claim', label: 'c', properties: {}, claim, validFrom: day(1), owner: env.own() });
      const expected = sha(`{"claimKind":"k","evidence":[{"contentSha256":"${low}","end":5,"start":0},{"contentSha256":"${high}","end":9,"start":3}],"statement":"S","subjects":["10","9"]}`);
      expect((await env.store.node(c.nodeId, { known: day(2) }))?.claimDigest).toBe(expected);
      await refused(env.store.openNode({ kind: 'component', label: 'x', claim, validFrom: day(1), owner: env.own() } as never), /only a claim node/);
      await refused(env.store.openNode({ kind: 'engine:claim', label: 'x', properties: {}, validFrom: day(1), owner: env.own() }), /claim node .* carries its statement/);
      await refused(env.query(`INSERT INTO node_version (node_id, kind_id, label, valid_from, recorded_from, states, producer, scope_id, payload_digest, properties)
        SELECT node_id, kind_id, label, valid_from, recorded_from + interval '1 day', int8range(7, 8), producer, scope_id, 'x', '{}' FROM node_version WHERE id = ${c.versionId}`), /acceptance-bound/);
    });

    run('content-immutable: bytes and digest never change, and an evidence span keeps resolving after the file changes', async (env) => {
      const original = new TextEncoder().encode('line one\nline two\nline three\n');
      const changed = new TextEncoder().encode('line one\nline 2\nline three\n');
      const file = await node(env, 'orders.go', { kind: 'engine:file' });
      const v1 = await env.store.openNode({ kind: 'engine:content', label: 'orders.go@1', properties: {}, content: original, validFrom: day(1), owner: env.own() });
      expect((await env.store.node(v1.nodeId, { known: day(2) }))?.contentSha256).toBe(sha(original));
      const link = await edge(env, file.nodeId, v1.nodeId, { validFrom: day(1) }, 'engine:links-content');
      const span = { contentSha256: sha(original), start: 9, end: 17 };
      expect(new TextDecoder().decode((await env.store.contentBytes(span.contentSha256, span))!)).toBe('line two');
      // Day 3: the file changes. The old link ends, the new content is another node, and the old content is untouched.
      env.setClock(day(3));
      await env.store.endEdge(link.versionId, day(3));
      const v2 = await env.store.openNode({ kind: 'engine:content', label: 'orders.go@2', properties: {}, content: changed, validFrom: day(3), owner: env.own() });
      await edge(env, file.nodeId, v2.nodeId, { validFrom: day(3) }, 'engine:links-content');
      expect(v2.nodeId).not.toBe(v1.nodeId);
      expect(new TextDecoder().decode((await env.store.contentBytes(span.contentSha256, span))!)).toBe('line two');
      expect(new TextDecoder().decode((await env.store.contentBytes(sha(changed), { start: 9, end: 15 }))!)).toBe('line 2');
      const linked = async (valid: Date): Promise<string[]> => (await env.store.callees(file.nodeId, { valid, known: day(4) }, { relation: 'engine:links-content' })).rows.map((r) => r.dst.label);
      expect(await linked(day(2))).toEqual(['orders.go@1']);
      expect(await linked(day(4))).toEqual(['orders.go@2']);
      // A content node cannot be given other bytes, by the store or by the database; only content nodes carry bytes.
      await refused(env.store.openNode({ kind: 'engine:content', label: 'again', properties: {}, nodeId: v1.nodeId, content: changed, validFrom: day(5), owner: env.own() }), /content-immutable/);
      await refused(env.store.openNode({ kind: 'component', label: 'x', properties: {}, content: changed, validFrom: day(5), owner: env.own() } as never), /only a content node/);
      await refused(env.query(`UPDATE node_version SET content = decode('00', 'hex') WHERE id = ${v1.versionId}`), /append-only|check constraint/);
      await refused(env.query(`UPDATE node_version SET content_sha256 = '${sha('other')}' WHERE id = ${v1.versionId}`), /append-only|check constraint/);
      // The digest column must be the SHA-256 of the bytes it sits beside.
      await refused(env.query(`INSERT INTO node_version (node_id, kind_id, label, content, content_sha256, valid_from, recorded_from, states, producer, scope_id, payload_digest, properties)
        SELECT node_id, kind_id, label, decode('6162', 'hex'), '${sha('not ab')}', valid_from, recorded_from + interval '9 days', states, producer, scope_id, 'x', '{}' FROM node_version WHERE id = ${v1.versionId}`), /content-immutable|check constraint/);
      // Content is shared by digest: equal bytes published twice are one node.
      const scope2 = await env.store.newNode();
      await env.store.openWorkItem({ producer: 'p2', scope: scope2, generation: 1, inputDigest: 'i', leaseToken: 't', leaseUntil: day(30) });
      env.setClock(day(6));
      const same = await env.store.publish({ producer: 'p2', scope: scope2, generation: 1, leaseToken: 't', inputDigest: 'i', nodes: [{ ref: 'c', kind: 'engine:content', label: 'copy', content: original, validFrom: day(6) }] });
      expect(same.refs['c']).toBe(v1.nodeId);
      expect(same.nodeVersionsOpened).toBe(0);
    });

    describe('fenced-publication', () => {
      const plan = async (env: Env, producer: string, scope: GraphId, generation: number, token = `t-${producer}-${generation}`, inputDigest = `in-${generation}`, until = day(30)): Promise<GraphId> =>
        await env.store.openWorkItem({ producer, scope, generation, inputDigest, leaseToken: token, leaseUntil: until });
      const input = (producer: string, scope: GraphId, generation: number, extra: Record<string, unknown> = {}) =>
        ({ producer, scope, generation, leaseToken: `t-${producer}-${generation}`, inputDigest: `in-${generation}`, ...extra }) as Parameters<GraphStore['publish']>[0];

      run('fenced-publication: a publication lands whole, and a second publication of the generation is refused whatever its content', async (env) => {
        env.setClock(day(2));
        await plan(env, 'p1', env.scope, 1);
        const first = await env.store.publish(input('p1', env.scope, 1, {
          nodes: [{ ref: 'a', kind: 'component', label: 'A', validFrom: day(1) }, { ref: 'b', kind: 'component', label: 'B', validFrom: day(1) }],
          edges: [{ relation: 'uses', src: { ref: 'a' }, dst: { ref: 'b' }, validFrom: day(1) }],
        }));
        expect(first.nodeVersionsOpened).toBe(2);
        expect(first.edgeVersionsOpened).toBe(1);
        expect(first.refs).toEqual({ a: '2', b: '3' });
        expect(labels((await env.store.callees('2', { valid: day(5), known: day(5) }, { relation: 'uses' })).rows.map((r) => r.dst))).toEqual(['B']);
        const rows = await env.count('node_version');
        await refused(env.store.publish(input('p1', env.scope, 1, { nodes: [{ ref: 'c', kind: 'component', label: 'other content', validFrom: day(1) }] })), /fenced-publication.*already published/s);
        await refused(env.store.publish(input('p1', env.scope, 1)), /fenced-publication.*already published/s);
        expect(await env.count('node_version')).toBe(rows);
        // The database refuses to rewrite the publication record.
        await refused(env.query(`UPDATE work_item SET published_at = NULL, published_digest = NULL`), /fenced-publication/);
        // A generation nobody planned is refused.
        await refused(env.store.publish(input('p1', env.scope, 7)), /no work item for generation 7/);
      });

      run('fenced-publication: a unit whose lease passed to another worker, or expired, publishes nothing', async (env) => {
        env.setClock(day(2));
        await plan(env, 'p1', env.scope, 1, 'worker-1');
        await env.store.leaseWorkItem({ producer: 'p1', scope: env.scope, generation: 1, leaseToken: 'worker-2', leaseUntil: day(30) });
        const nodes = [{ ref: 'a', kind: 'component', label: 'A', validFrom: day(1) }];
        await refused(env.store.publish({ ...input('p1', env.scope, 1, { nodes }), leaseToken: 'worker-1' }), /fenced-publication.*lease .* passed to another worker/s);
        expect(await env.count('node_version')).toBe(0);
        await env.store.publish({ ...input('p1', env.scope, 1, { nodes }), leaseToken: 'worker-2' });
        expect(await env.count('node_version')).toBe(1);
        // An expired lease: the lease ran out on day 3 and the clock is day 4.
        env.setClock(day(3));
        await plan(env, 'p1', env.scope, 2, 'worker-3', 'in-2', day(3, 12));
        env.setClock(day(4));
        await refused(env.store.publish({ ...input('p1', env.scope, 2, { nodes }), leaseToken: 'worker-3' }), /fenced-publication.*expired/s);
        expect(await env.count('node_version')).toBe(1);
        // A stale read: the unit read other inputs than the work item now names.
        await env.store.leaseWorkItem({ producer: 'p1', scope: env.scope, generation: 2, leaseToken: 'worker-3', leaseUntil: day(30), inputDigest: 'in-2b' });
        await refused(env.store.publish({ ...input('p1', env.scope, 2, { nodes }), leaseToken: 'worker-3' }), /fenced-publication.*inputs digest in-2/s);
        await env.store.publish({ ...input('p1', env.scope, 2, { nodes }), leaseToken: 'worker-3', inputDigest: 'in-2b' });
      });

      run('fenced-publication: a unit writes only versions of its own producer and scope', async (env) => {
        const scopeB = await env.store.newNode();
        env.setClock(day(2));
        await plan(env, 'A', env.scope, 1);
        await plan(env, 'B', scopeB, 1);
        const a = await env.store.publish(input('A', env.scope, 1, { nodes: [{ ref: 'n', kind: 'component', label: 'N', validFrom: day(1) }] }));
        const n = a.refs['n']!;
        const rows = await env.count('node_version');
        const attempt = (extra: Record<string, unknown>) => env.store.publish(input('B', scopeB, 1, extra));
        // Items naming another producer or scope.
        await refused(attempt({ nodes: [{ kind: 'component', label: 'x', validFrom: day(1), producer: 'A' }] }), /fenced-publication.*not producer "A"/s);
        await refused(attempt({ nodes: [{ kind: 'component', label: 'x', validFrom: day(1), scope: env.scope }] }), /fenced-publication.*not scope 1/s);
        // An identity another producer owns: correcting it, ending it, or replacing it.
        await refused(attempt({ nodes: [{ id: n, kind: 'component', label: 'N renamed by B', validFrom: day(1) }] }), /fenced-publication.*belongs to producer "A"/s);
        await refused(attempt({ ends: [{ node: { id: n }, validTo: day(1, 12) }] }), /fenced-publication.*belongs to producer "A"/s);
        // One bad item takes the whole publication down: the good node before it is not written either.
        await refused(attempt({ nodes: [{ ref: 'good', kind: 'component', label: 'good', validFrom: day(1) }, { id: n, kind: 'component', label: 'bad', validFrom: day(1) }] }), /fenced-publication/);
        expect(await env.count('node_version')).toBe(rows);
        expect((await env.query<{ p: string | null }>(`SELECT published_at::text AS p FROM work_item WHERE producer = 'B'`))[0]!.p).toBeNull();
        // And the rightful owner still publishes its change.
        env.setClock(day(3));
        await plan(env, 'A', env.scope, 2);
        const renamed = await env.store.publish(input('A', env.scope, 2, { nodes: [{ id: n, kind: 'component', label: 'N renamed', validFrom: day(1) }] }));
        expect(renamed.corrections).toBe(1);
        expect((await env.store.node(n, { known: day(4) }))?.label).toBe('N renamed');
      });

      run('fenced-publication: two writers of one generation at once publish exactly once', async (env) => {
        env.setClock(day(2));
        await plan(env, 'p1', env.scope, 1);
        const nodes = [{ ref: 'a', kind: 'component', label: 'A', validFrom: day(1) }];
        const outcomes = await Promise.allSettled([env.store.publish(input('p1', env.scope, 1, { nodes })), env.store.publish(input('p1', env.scope, 1, { nodes }))]);
        expect(outcomes.filter((o) => o.status === 'fulfilled').length).toBe(1);
        const failed = outcomes.find((o) => o.status === 'rejected') as PromiseRejectedResult;
        expect(String(failed.reason)).toMatch(/fenced-publication.*already published/s);
        expect(await env.count('node_version')).toBe(1);
      });

      run('fenced-publication: a refill that finds the same payload writes nothing, and a producer on the same input publishes nothing', async (env) => {
        env.setClock(day(2));
        await plan(env, 'p1', env.scope, 1);
        const items = {
          nodes: [{ ref: 'a', kind: 'component', label: 'A', properties: { size: 3 }, validFrom: day(1) }, { ref: 'b', kind: 'component', label: 'B', validFrom: day(1) }],
          edges: [{ relation: 'uses', src: { ref: 'a' }, dst: { ref: 'b' }, validFrom: day(1) }],
        };
        await env.store.publish(input('p1', env.scope, 1, items));
        const digestOfAll = async (): Promise<string> => {
          const nodes = await env.query<{ t: string }>(`SELECT to_jsonb(v)::text AS t FROM node_version v ORDER BY id`);
          const edges = await env.query<{ t: string }>(`SELECT to_jsonb(e)::text AS t FROM edge_version e ORDER BY id`);
          const ids = await env.query<{ t: string }>(`SELECT id::text AS t FROM node_identity UNION ALL SELECT id::text || key_hash FROM edge_identity ORDER BY 1`);
          return sha(JSON.stringify([nodes, edges, ids]));
        };
        const before = { digest: await digestOfAll(), nodes: await env.count('node_version'), edges: await env.count('edge_version') };
        // Generation 2 reads other inputs, finds every item as it is, and writes no row at all.
        env.setClock(day(3));
        await plan(env, 'p1', env.scope, 2);
        const refill = await env.store.publish(input('p1', env.scope, 2, { ...items, nodes: items.nodes.map((n, i) => ({ ...n, id: String(i + 2) })) }));
        expect(refill).toMatchObject({ nodeVersionsOpened: 0, edgeVersionsOpened: 0, corrections: 0, unchanged: 3, unchangedInput: false });
        expect(await digestOfAll()).toBe(before.digest);
        // Generation 3 reads exactly the inputs generation 2 published: it publishes nothing, whatever it carries.
        env.setClock(day(4));
        await plan(env, 'p1', env.scope, 3, 't-p1-3', 'in-2');
        const same = await env.store.publish({ ...input('p1', env.scope, 3, { nodes: [{ kind: 'component', label: 'ignored', validFrom: day(1) }] }), inputDigest: 'in-2' });
        expect(same.unchangedInput).toBe(true);
        expect(await digestOfAll()).toBe(before.digest);
        expect((await env.query<{ g: string }>(`SELECT count(*)::text AS g FROM work_item WHERE published_at IS NOT NULL`))[0]!.g).toBe('3');
      });

      run('fenced-publication: a rename keeps the identity and succeeds the old name on the valid axis', async (env) => {
        env.setClock(day(2));
        await plan(env, 'p1', env.scope, 1);
        const first = await env.store.publish(input('p1', env.scope, 1, { nodes: [{ ref: 'o', kind: 'component', label: 'orders/order', validFrom: day(1) }] }));
        const id = first.refs['o']!;
        env.setClock(day(12));
        await plan(env, 'p1', env.scope, 2);
        const second = await env.store.publish(input('p1', env.scope, 2, { nodes: [{ id, kind: 'component', label: 'orders/domain/order', validFrom: day(10) }] }));
        expect(second.corrections).toBe(1);
        const at = async (valid: Date, known: Date): Promise<string | undefined> => (await env.store.node(id, { valid, known }))?.label;
        expect(await at(day(5), day(13))).toBe('orders/order');
        expect(await at(day(11), day(13))).toBe('orders/domain/order');
        // What was known on day 5 about day 11 was still the old name.
        expect(await at(day(11), day(5))).toBe('orders/order');
        expect(await env.count('node_identity')).toBe(2); // the scope node and one orders node
      });
    });

    run('registry-kinds: the engine declares no product kind; kinds and relation types come from the registry the caller passes', async (env) => {
      const bare = await fresh(getOwner(), false);
      // Without a registry the store holds the engine's own prefixed keys and nothing else.
      const engineKinds = await bare.query<{ key: string; namespace: string }>(`SELECT key, namespace FROM node_kind ORDER BY key`);
      expect(engineKinds.every((k) => k.namespace === 'engine' && k.key.startsWith('engine:'))).toBe(true);
      expect(engineKinds.map((k) => k.key)).toEqual([
        'engine:acceptance', 'engine:answer', 'engine:claim', 'engine:commit', 'engine:content', 'engine:directory', 'engine:evidence', 'engine:file', 'engine:question', 'engine:state', 'engine:symbol',
      ]);
      const engineRelations = await bare.query<{ key: string; namespace: string; positioned: boolean; discriminated: boolean }>(`SELECT key, namespace, positioned, discriminated FROM relation_type ORDER BY key`);
      expect(engineRelations.every((r) => r.namespace === 'engine' && r.key.startsWith('engine:'))).toBe(true);
      expect(engineRelations.filter((r) => r.positioned).map((r) => r.key)).toEqual(['engine:occurrence']);
      expect(engineRelations.some((r) => r.discriminated)).toBe(false);
      // A product kind is unknown until the registry names it.
      await refused(bare.store.openNode({ kind: 'component', label: 'x', validFrom: day(1), owner: { producer: 'p', scope: await bare.store.newNode() } }), /node kind "component" is not registered/);
      const registry = { kinds: ['component'], relations: [{ key: 'uses' }, { key: 'foreign-key', discriminated: true }], origin: { file: 'registry.yaml', line: 4 } };
      expect(await bare.store.registerVocabulary(registry)).toEqual({ kinds: 1, relations: 2 });
      expect((await bare.query<{ key: string }>(`SELECT key FROM node_kind WHERE namespace = 'product'`)).map((k) => k.key)).toEqual(['component']);
      // Registering again changes nothing; other settings for an existing key are refused (an encoding is never reused).
      expect(await bare.store.registerVocabulary(registry)).toEqual({ kinds: 0, relations: 0 });
      const encodingBefore = await bare.query(`SELECT id, key FROM relation_type ORDER BY id`);
      await refused(bare.store.registerVocabulary({ kinds: [], relations: [{ key: 'uses', discriminated: true }] }), /already registered with other settings/);
      expect(await bare.query(`SELECT id, key FROM relation_type ORDER BY id`)).toEqual(encodingBefore);
      // A product key may not use the engine's prefix, and a malformed registry names the entry and its file and line.
      await refused(bare.store.registerVocabulary({ kinds: ['engine:file2'], relations: [], origin: { file: 'registry.yaml', line: 9 } }), /kinds\[0\].*"engine:"|"engine:".*kinds\[0\].*registry\.yaml:9/s);
      await refused(bare.store.registerVocabulary({ kinds: ['a', 'a'], relations: [] }), /registered twice/);
      await refused(bare.store.registerVocabulary({ kinds: [' padded'], relations: [] }), /without surrounding blanks/);
      // Discriminators and positions follow the relation type's declaration.
      const scope = await bare.store.newNode();
      const owner = { producer: 'p', scope };
      const a = await bare.store.openNode({ kind: 'component', label: 'a', validFrom: day(1), owner });
      const b = await bare.store.openNode({ kind: 'component', label: 'b', validFrom: day(1), owner });
      await refused(bare.store.openEdge({ relation: 'uses', src: a.nodeId, dst: b.nodeId, discriminator: 'x', validFrom: day(1), owner }), /does not declare a discriminator/);
      await bare.store.openEdge({ relation: 'foreign-key', src: a.nodeId, dst: b.nodeId, discriminator: 'orders_id', validFrom: day(1), owner });
      await bare.store.openEdge({ relation: 'foreign-key', src: a.nodeId, dst: b.nodeId, discriminator: 'billing_id', validFrom: day(1), owner });
      await refused(bare.store.openEdge({ relation: 'uses', src: a.nodeId, dst: b.nodeId, position: { start: 1, end: 2 }, validFrom: day(1), owner }), /is not positioned/);
      await refused(bare.store.openEdge({ relation: 'engine:occurrence', src: a.nodeId, dst: b.nodeId, validFrom: day(1), owner }), /is positioned/);
      // Two parallel relations of one discriminated type are two identities; two occurrences are keyed by their starting byte.
      expect(await bare.count('edge_identity')).toBe(2);
      await bare.store.openEdge({ relation: 'engine:occurrence', src: a.nodeId, dst: b.nodeId, position: { start: 4, end: 9 }, validFrom: day(1), owner });
      await bare.store.openEdge({ relation: 'engine:occurrence', src: a.nodeId, dst: b.nodeId, position: { start: 20, end: 24 }, validFrom: day(1), owner });
      expect(await bare.count('edge_identity')).toBe(4);
      // The module's own source names no product kind: engine keys carry the prefix, and only the registry's entry point writes the product namespace.
      const { readFileSync, readdirSync } = await import('node:fs');
      const dir = new URL('../src/graph/', import.meta.url);
      for (const file of readdirSync(dir)) {
        const text = readFileSync(new URL(file, dir), 'utf8');
        if (file !== 'register.ts') expect(text, `${file} writes the product namespace`).not.toMatch(/'product'\s*,|VALUES \(\$1, 'product'/);
        if (file === 'vocabulary.ts') for (const m of text.matchAll(/key: '([^']+)'|^\s*'([a-z-]+:[a-z-]+)',$/gm)) expect((m[1] ?? m[2])!.startsWith('engine:')).toBe(true);
      }
      void env;
    });

    describe('reads', () => {
      run('callers and callees: the edges of the call relation that end or start at a node, with their nodes, paged by keyset', async (env) => {
        // f -> g, h -> g, k -> g, g -> m, and a `uses` edge f -> g that is no call.
        const [f, g, h, k, m] = [await node(env, 'f'), await node(env, 'g'), await node(env, 'h'), await node(env, 'k'), await node(env, 'm')];
        for (const caller of [f, h, k]) await edge(env, caller.nodeId, g.nodeId, {}, 'engine:calls');
        await edge(env, g.nodeId, m.nodeId, {}, 'engine:calls');
        await edge(env, f.nodeId, g.nodeId);
        const lens: GraphLens = { valid: day(2), known: day(2) };
        expect(labels((await env.store.callers(g.nodeId, lens)).rows.map((r) => r.src))).toEqual(['f', 'h', 'k']);
        expect(labels((await env.store.callees(g.nodeId, lens)).rows.map((r) => r.dst))).toEqual(['m']);
        // Pages of two: no row is lost between pages, and the last page says so.
        const first = await env.store.callers(g.nodeId, lens, { limit: 2 });
        expect(first.rows.length).toBe(2);
        expect(first.next).not.toBeNull();
        const second = await env.store.callers(g.nodeId, lens, { limit: 2, after: first.next! });
        expect(second.rows.length).toBe(1);
        expect(second.next).toBeNull();
        const all = await env.store.readAll((page) => env.store.callers(g.nodeId, lens, { ...page, limit: 1 }));
        expect(labels(all.map((r) => r.src))).toEqual(['f', 'h', 'k']);
        await refused(env.store.callers(g.nodeId, lens, { limit: 0 }), /page holds 1 to 100000 rows/);
        // g calls m, so g is m's only caller.
        expect((await env.store.callers(m.nodeId, lens)).rows.map((r) => r.src.label)).toEqual(['g']);
      });

      run('relations within a repository: both ends reached through containment at the date and known time', async (env) => {
        // R contains D1 and F2; D1 contains F1; E is outside. imports: F1 -> F2 (inside), F1 -> E (leaves), E -> F2 (enters).
        const names = ['R', 'D1', 'F1', 'F2', 'E'];
        const n: Record<string, GraphId> = {};
        for (const name of names) n[name] = (await node(env, name)).nodeId;
        const contains: Record<string, string> = {};
        for (const [from, to] of [['R', 'D1'], ['D1', 'F1'], ['R', 'F2']] as const) contains[`${from}>${to}`] = (await edge(env, n[from]!, n[to]!, {}, 'engine:contains')).versionId;
        for (const [from, to] of [['F1', 'F2'], ['F1', 'E'], ['E', 'F2']] as const) await edge(env, n[from]!, n[to]!, {}, 'engine:imports');
        const within = async (l: GraphLens): Promise<string[]> => (await env.store.relationsWithin(n['R']!, 'engine:imports', l)).rows.map((r) => `${r.src.label}>${r.dst.label}`);
        expect(await within({ valid: day(3), known: day(3) })).toEqual(['F1>F2']);
        // Day 5: R stopped containing F2 (recorded day 6). Valid day 7: F2 is outside, so no import is within. Valid day 3, or known day 5: still within.
        env.setClock(day(6));
        await env.store.endEdge(contains['R>F2']!, day(5));
        expect(await within({ valid: day(7), known: day(7) })).toEqual([]);
        expect(await within({ valid: day(3), known: day(7) })).toEqual(['F1>F2']);
        expect(await within({ valid: day(7), known: day(5) })).toEqual(['F1>F2']);
      });

      run('as-is against to-be: the diff of a node\'s outgoing relations over the state chain', async (env) => {
        const state = (label: string, key: number) => env.store.openNode({ kind: 'engine:state', label, properties: { stateKey: key }, validFrom: day(1), owner: env.own() });
        await state('as-is', 1000);
        await state('to-be', 3000);
        const [s, x, y, z] = [await node(env, 's'), await node(env, 'x'), await node(env, 'y'), await node(env, 'z')];
        // s -> x in both states, with a different weight in each; s -> y only planned; s -> z only today.
        await edge(env, s.nodeId, x.nodeId, { states: { from: 1000, to: 3000 }, properties: { weight: 1 } });
        await edge(env, s.nodeId, x.nodeId, { states: { from: 3000, to: 3001 }, properties: { weight: 2 } });
        await edge(env, s.nodeId, y.nodeId, { states: { from: 3000, to: 3001 } });
        await edge(env, s.nodeId, z.nodeId, { states: { from: 1000, to: 3000 } });
        const diff = await env.store.outgoingDiff(s.nodeId, { valid: day(2), known: day(2) });
        expect(diff.asIs).toBe(1000);
        expect(diff.toBe).toBe(3000);
        expect(diff.added.map((e) => e.dst)).toEqual([y.nodeId]);
        expect(diff.removed.map((e) => e.dst)).toEqual([z.nodeId]);
        expect(diff.changed.map((c) => c.toBe.dst)).toEqual([x.nodeId]);
        expect(diff.changed[0]!.asIs.payloadDigest).not.toBe(diff.changed[0]!.toBe.payloadDigest);
        // Known before the edges existed there is nothing to compare.
        const empty = await env.store.outgoingDiff(s.nodeId, { valid: day(2), known: day(1, 0) });
        expect([empty.added, empty.removed, empty.changed]).toEqual([[], [], []]);
      });

      run('traversal: WITH RECURSIVE over the declared relation types only, cycles terminate, direction in or out', async (env) => {
        // A -uses-> B -uses-> C -uses-> A (a cycle); A -foreign-key-> D -uses-> E.
        const n: Record<string, GraphId> = {};
        for (const name of ['A', 'B', 'C', 'D', 'E']) n[name] = (await node(env, name)).nodeId;
        for (const [from, to] of [['A', 'B'], ['B', 'C'], ['C', 'A'], ['D', 'E']] as const) await edge(env, n[from]!, n[to]!);
        await edge(env, n['A']!, n['D']!, { discriminator: 'd' }, 'foreign-key');
        const lens: GraphLens = { valid: day(2), known: day(2) };
        const out = async (relations: string[], from: string, direction: 'out' | 'in' = 'out'): Promise<string[]> => labels((await env.store.traverse(n[from]!, relations, direction, lens)).rows);
        expect(await out(['uses'], 'A')).toEqual(['A', 'B', 'C']);
        expect(await out(['uses', 'foreign-key'], 'A')).toEqual(['A', 'B', 'C', 'D', 'E']);
        expect(await out(['foreign-key'], 'A')).toEqual(['D']);
        expect(await out(['uses'], 'D')).toEqual(['E']);
        expect(await out(['uses'], 'E', 'in')).toEqual(['D']);
        expect(await out(['uses'], 'C', 'in')).toEqual(['A', 'B', 'C']);
        await refused(env.store.traverse(n['A']!, [], 'out', lens), /declares the relation types it follows/);
        const paged = await env.store.readAll((page) => env.store.traverse(n['A']!, ['uses', 'foreign-key'], 'out', lens, { ...page, limit: 2 }));
        expect(labels(paged)).toEqual(['A', 'B', 'C', 'D', 'E']);
      });

      run('errors name the operation, the path in the input and the file and line it came from', async (env) => {
        const origin = { file: 'extract/orders.json', line: 41 };
        await refused(env.store.openNode({ kind: 'component', label: 'x', validFrom: 'yesterday', owner: env.own(), origin }), /open node version: .*path node\.validFrom/);
        await refused(env.store.openNode({ kind: 'nope', label: 'x', validFrom: day(1), owner: env.own(), origin }), /path node\.kind; from extract\/orders\.json:41/);
        env.setClock(day(2));
        await env.store.openWorkItem({ producer: 'p1', scope: env.scope, generation: 1, inputDigest: 'i', leaseToken: 't', leaseUntil: day(30) });
        await refused(
          env.store.publish({ producer: 'p1', scope: env.scope, generation: 1, leaseToken: 't', inputDigest: 'i', nodes: [{ ref: 'a', kind: 'component', label: 'a', validFrom: day(1) }, { kind: 'component', label: 'b', validFrom: 'x', origin }] } as never),
          /path nodes\[1\]\.validFrom; from extract\/orders\.json:41/,
        );
        await refused(
          env.store.publish({ producer: 'p1', scope: env.scope, generation: 1, leaseToken: 't', inputDigest: 'i', edges: [{ relation: 'uses', src: { ref: 'ghost' }, dst: { id: '1' }, validFrom: day(1), origin }] }),
          /path edges\[0\]\.src\.ref; from extract\/orders\.json:41/,
        );
      });
    });
  });
}
