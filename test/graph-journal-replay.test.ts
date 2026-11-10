/**
 * The journal is the history (decision 0034, A6): rows hold the present, and history is a snapshot plus the journal's
 * replay. This file plays random sequences of the writer's changes against a real store — a declaration, an opinion, a
 * changed value, re-evidence, a withdrawal by one of two producers, an edge declared and an edge removed — and folds
 * the journal, entry by entry, into the state a replay from an empty store answers. The fold is compared with the store
 * exactly: every vertex with its entity, key and removal mark, every live edge with its ends and discriminator, and
 * every open opinion with its producer, values, evidence, language, context and the moment it was said
 * (madarch-64o5.2, stage 2b; codex, stage 2 review, item 3).
 */
import { describe, expect, test } from 'bun:test';
import type { DatabaseOwner } from '../src/adapters/database-owner.js';
import { createOneGraphSchema } from '../src/graph/one-graph.js';
import { GIT_CONTRACT, GIT_KINDS, GIT_TABLES } from '../src/fill/stages/git-contract.js';
import type { KeyValueDraft } from '../src/graph/contract.js';
import { canonicalJson, ensureEdge, journalFor, journalOn, publishGraphDrafts, removeEdgeById, writeJournal } from '../src/graph/write.js';
import { createTestDatabaseOwner } from './test-database.js';

/** A deterministic stream of choices, so a failing sequence is the same sequence on the next run. */
function rng(seed: number): () => number {
  let held = seed >>> 0;
  return () => {
    held = (held + 0x6d2b79f5) >>> 0;
    let t = held;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const PATHS = ['src/a.ts', 'src/b.ts', 'src/c.ts'] as const;
const PRODUCERS = ['linguist', 'scanner'] as const;
const LANGS = ['TypeScript', 'JavaScript', 'XML'] as const;

/** One vertex's key under the fixture's repository. */
const keyOf = (path: string): Readonly<Record<string, KeyValueDraft>> => ({ repository: { kind: 'repository', key: { name: 'fixture' } }, path });

/** One file opinion as the writer states it. */
function fileDraft(path: string, producer: string, language: string | null, line: number) {
  return {
    kind: GIT_KINDS.file, key: keyOf(path),
    values: { mode: '100644', language, languages: language === null ? ['TypeScript', 'XML'] : [language] },
    evidence: [{ type: 'file' as const, repository: 'fixture', commit_or_digest: 'c0ffee', path, line_start: line, line_end: line }],
    producer, producerVersion: producer === 'linguist' ? '9.5.0' : '1',
  };
}

/** One change the sequence may make, as the writer applies it. */
type Step =
  | { readonly kind: 'declare'; readonly path: string; readonly producer: string; readonly language: string | null; readonly line: number }
  | { readonly kind: 'withdraw'; readonly path: string; readonly producer: string }
  | { readonly kind: 'edge'; readonly from: string; readonly to: string; readonly remove: boolean };

/** One step, applied in its own transaction, exactly as a producer's turn or a record pass applies it. */
async function apply(owner: DatabaseOwner, step: Step, open: Map<string, string>): Promise<void> {
  if (step.kind === 'declare') {
    await owner.transaction('write', async (tx) => {
      await publishGraphDrafts(tx, GIT_CONTRACT, { vertices: [fileDraft(step.path, step.producer, step.language, step.line)], removals: [] });
    });
    return;
  }
  if (step.kind === 'withdraw') {
    await owner.transaction('write', async (tx) => {
      await publishGraphDrafts(tx, GIT_CONTRACT, { vertices: [], removals: [{ kind: GIT_KINDS.file, key: keyOf(step.path), producer: step.producer }] });
    });
    return;
  }
  // An edge is one entry of its own, the way a record pass writes one: the journal is bound to the transaction.
  await owner.transaction('write', async (tx) => {
    const journal = journalFor('linker@1');
    journalOn(tx, journal);
    if (!step.remove) {
      const from = await tx.query<{ id: string }>(`SELECT id::text AS id FROM node WHERE (key->>'path') = $1 AND (key->'repository'->'key'->>'name') = 'fixture'`, [step.from]);
      const to = await tx.query<{ id: string }>(`SELECT id::text AS id FROM node WHERE (key->>'path') = $1 AND (key->'repository'->'key'->>'name') = 'fixture'`, [step.to]);
      if (from.rows[0] === undefined || to.rows[0] === undefined) return;
      const made = await ensureEdge(tx, GIT_CONTRACT, GIT_KINDS.renamedFrom, from.rows[0].id, to.rows[0].id, `${step.from}->${step.to}`, { producer: 'linker', producerVersion: '1', evidence: [{ type: 'file', repository: 'fixture', commit_or_digest: 'c0ffee', path: step.from }] });
      open.set(`${step.from}->${step.to}`, made.id);
    } else {
      const id = open.get(`${step.from}->${step.to}`);
      if (id !== undefined) await removeEdgeById(tx, GIT_CONTRACT, GIT_KINDS.renamedFrom, id);
    }
    await writeJournal(tx, journal);
  });
}

/** What a replay over the journal answers, folded entry by entry. */
interface Replayed {
  readonly vertices: Map<string, { entity: string; key: string; removed: boolean }>;
  readonly edges: Map<string, { entity: string; from: string; to: string; discriminator: string; context: number }>;
  readonly edgeIdentity: Map<string, string>;
  readonly opinions: Map<string, { entity: string; target: string; said_by: string; values: string; evidence: string; lang: string | null; context: number; said_at: string }>;
}

/** Folds the journal's changes the way decision 0034's A6 states it: a snapshot is the state every entry before made. */
function fold(entries: readonly Record<string, any>[]): Replayed {
  const vertices = new Map<string, { entity: string; key: string; removed: boolean }>();
  const edges = new Map<string, { entity: string; from: string; to: string; discriminator: string; context: number }>();
  const edgeIdentity = new Map<string, string>();
  const opinions = new Map<string, { entity: string; target: string; said_by: string; values: string; evidence: string; lang: string | null; context: number; said_at: string }>();
  const identityOf = (held: { entity: string; from: string; to: string; discriminator: string; context: number }): string => `${held.entity}\u0000${held.from}\u0000${held.to}\u0000${held.discriminator}\u0000${String(held.context)}`;
  for (const entry of entries) {
    const change = entry as { vertices?: readonly any[]; edges?: readonly any[]; opinions?: readonly any[] };
    for (const event of change.vertices ?? []) {
      if (event.state === 'declared') {
        vertices.set(String(event.uid), { entity: String(event.entity), key: canonicalJson(event.key ?? {}), removed: false });
        continue;
      }
      // A removed vertex drops every opinion it held, of every producer: that is what the store's readers answer.
      vertices.set(String(event.uid), { ...(vertices.get(String(event.uid)) ?? { entity: String(event.entity), key: '{}', removed: false }), removed: true });
      for (const [id, opinion] of [...opinions]) if (opinion.target === `node:${String(event.uid)}`) opinions.delete(id);
    }
    for (const event of change.edges ?? []) {
      const held = { entity: String(event.entity), from: String(event.from), to: String(event.to), discriminator: String(event.discriminator), context: Number(event.context) };
      const identity = identityOf(held);
      if (event.state === 'declared') {
        edges.set(identity, held);
        edgeIdentity.set(String(event.edge), identity);
        continue;
      }
      edges.delete(identity);
      for (const [id, opinion] of [...opinions]) if (opinion.target === `edge:${identity}`) opinions.delete(id);
    }
    for (const event of change.opinions ?? []) {
      const id = String(event.id);
      const target = event.node === undefined ? `edge:${edgeIdentity.get(String(event.edge)) ?? `unknown:${String(event.edge)}`}` : `node:${String(event.node)}`;
      if (event.state === 'opened') {
        opinions.set(id, {
          entity: String(event.entity), target, said_by: String(event.said_by),
          values: canonicalJson(event.values ?? {}), evidence: canonicalJson(event.evidence ?? []),
          lang: event.lang === null || event.lang === undefined ? null : String(event.lang),
          context: Number(event.context), said_at: String(event.said_at ?? ''),
        });
        continue;
      }
      if (event.state === 'closed') {
        opinions.delete(id);
        continue;
      }
      // Re-evidenced: the same opinion, resting on other grounds.
      const held = opinions.get(id);
      if (held !== undefined) opinions.set(id, { ...held, evidence: canonicalJson(event.evidence ?? []) });
    }
  }
  return { vertices, edges, edgeIdentity, opinions };
}

/** The store's own state, as the readers answer it: the vertices, the edges and every open opinion. */
async function stored(owner: DatabaseOwner, opinionTables: readonly { entity: string; table: string; kind: 'node' | 'edge'; fields: readonly string[] }[]): Promise<Replayed> {
  return await owner.transaction('snapshot', async (tx) => {
    const vertices = new Map<string, { entity: string; key: string; removed: boolean }>();
    const nodes = await tx.query<{ uid: string; entity: string; key: unknown; removed: boolean }>(
      `SELECT n.uid::text AS uid, e.name AS entity, n.key, n.removed FROM node n JOIN entity e ON e.id = n.entity_id`,
    );
    for (const row of nodes.rows) vertices.set(row.uid, { entity: row.entity, key: canonicalJson(row.key), removed: row.removed });
    const edges = new Map<string, { entity: string; from: string; to: string; discriminator: string; context: number }>();
    const edgeIdentity = new Map<string, string>();
    const found = await tx.query<{ id: string; entity: string; from: string; to: string; discriminator: string; context: string }>(
      'SELECT e.id::text AS id, en.name AS entity, fn.uid::text AS "from", tn.uid::text AS "to", e.discriminator, e.context_id::text AS context FROM edge e JOIN entity en ON en.id = e.entity_id JOIN node fn ON fn.id = e.from_node JOIN node tn ON tn.id = e.to_node',
    );
    for (const row of found.rows) {
      const held = { entity: row.entity, from: row.from, to: row.to, discriminator: row.discriminator, context: Number(row.context) };
      const identity = `${held.entity}\u0000${held.from}\u0000${held.to}\u0000${held.discriminator}\u0000${String(held.context)}`;
      edges.set(identity, held);
      edgeIdentity.set(row.id, identity);
    }
    const opinions = new Map<string, { entity: string; target: string; said_by: string; values: string; evidence: string; lang: string | null; context: number; said_at: string }>();
    for (const one of opinionTables) {
      const values = one.fields.map((field) => `t."${field}" AS "${field}"`);
      const rows = await tx.query<Record<string, unknown>>(
        `SELECT t."id"::text AS id, t."said_by", t."lang", t."evidence", t."context_id"::text AS context_id,
                to_char(t."said_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') || 'Z' AS said_at,
                ${one.kind === 'node' ? 'n.uid::text AS uid' : 't."edge_id"::text AS edge_uid'}${values.length === 0 ? '' : `, ${values.join(', ')}`}
         FROM ${one.table} t ${one.kind === 'node' ? 'JOIN node n ON n.id = t."node_id"' : ''}
         WHERE t."state" = 'open' AND t."context_id" = 1`,
      );
      for (const row of rows.rows) {
        const target = one.kind === 'node' ? `node:${String(row['uid'])}` : `edge:${edgeIdentity.get(String(row['edge_uid'])) ?? `unknown:${String(row['edge_uid'])}`}`;
        opinions.set(String(row['id']), {
          entity: one.entity, target, said_by: String(row['said_by']),
          values: canonicalJson(Object.fromEntries(one.fields.map((field) => [field, row[field] ?? null]))),
          evidence: canonicalJson(row['evidence'] ?? []),
          lang: row['lang'] === null || row['lang'] === undefined ? null : String(row['lang']),
          context: Number(row['context_id']), said_at: String(row['said_at']),
        });
      }
    }
    return { vertices, edges, edgeIdentity, opinions };
  });
}

/** The opinions the git contract's two kinds this sequence writes stand in, with the columns each states. */
const TABLES = [
  { entity: GIT_KINDS.file, table: GIT_TABLES.file, kind: 'node' as const, fields: ['mode', 'blob_id', 'language', 'languages'] },
  { entity: GIT_KINDS.renamedFrom, table: GIT_TABLES.renamed_from, kind: 'edge' as const, fields: [] as readonly string[] },
];

/**
 * The steps every sequence begins with, so each kind of change is played whatever the seed draws: a declaration, a
 * changed value, re-evidence, a second producer, a withdrawal that leaves the other producer's opinion standing, a
 * removal that leaves none, an edge declared, an edge removed and a repeated withdrawal that changes nothing.
 */
const PREFIX: readonly Step[] = [
  { kind: 'declare', path: 'src/a.ts', producer: 'linguist', language: 'TypeScript', line: 3 },
  { kind: 'declare', path: 'src/a.ts', producer: 'linguist', language: 'JavaScript', line: 3 },
  { kind: 'declare', path: 'src/a.ts', producer: 'linguist', language: 'JavaScript', line: 5 },
  { kind: 'declare', path: 'src/a.ts', producer: 'scanner', language: 'TypeScript', line: 3 },
  { kind: 'withdraw', path: 'src/a.ts', producer: 'linguist' },
  { kind: 'declare', path: 'src/b.ts', producer: 'linguist', language: 'XML', line: 1 },
  { kind: 'declare', path: 'src/c.ts', producer: 'linguist', language: 'XML', line: 1 },
  { kind: 'edge', from: 'src/b.ts', to: 'src/c.ts', remove: false },
  { kind: 'edge', from: 'src/b.ts', to: 'src/c.ts', remove: true },
  { kind: 'withdraw', path: 'src/a.ts', producer: 'scanner' },
  { kind: 'withdraw', path: 'src/a.ts', producer: 'scanner' },
];

/** A sequence of steps from one seed, biased to the changes a producer makes most. */
function sequence(seed: number): Step[] {
  const next = rng(seed);
  const steps: Step[] = [...PREFIX];
  for (let at = 0; at < 24; at += 1) {
    const choice = next();
    const path = PATHS[Math.floor(next() * PATHS.length)]!;
    const producer = PRODUCERS[Math.floor(next() * PRODUCERS.length)]!;
    if (choice < 0.5) steps.push({ kind: 'declare', path, producer, language: next() < 0.2 ? null : LANGS[Math.floor(next() * LANGS.length)]!, line: 1 + Math.floor(next() * 9) });
    else if (choice < 0.7) steps.push({ kind: 'withdraw', path, producer });
    // An edge names two different files (the store refuses a self-edge), so its ends are drawn apart.
    else {
      const from = PATHS[Math.floor(next() * PATHS.length)]!;
      const to = PATHS[(PATHS.indexOf(from) + 1 + Math.floor(next() * (PATHS.length - 1))) % PATHS.length]!;
      steps.push({ kind: 'edge', from, to, remove: choice >= 0.85 });
    }
  }
  return steps;
}

describe('a replay over the journal answers the store', () => {
  test('random sequences of declare, change, re-evidence, withdraw, edge declare and edge remove fold to the store\'s own state', async () => {
    for (const seed of [11, 29, 47]) {
      // Every sequence stands in its own store: a replay from empty is what is compared.
      const fresh = await createTestDatabaseOwner();
      try {
        await createOneGraphSchema(fresh, GIT_CONTRACT);
        const open = new Map<string, string>();
        for (const step of sequence(seed)) await apply(fresh, step, open);
        const entries = await fresh.transaction('snapshot', async (tx) => await tx.query<{ change: Record<string, unknown> }>('SELECT change FROM operation ORDER BY at, ctid'));
        const replay = fold(entries.rows.map((row) => row.change));
        const actual = await stored(fresh, TABLES);
        expect({ seed, vertices: [...actual.vertices].sort() }).toEqual({ seed, vertices: [...replay.vertices].sort() });
        expect({ seed, edges: [...actual.edges].sort() }).toEqual({ seed, edges: [...replay.edges].sort() });
        expect({ seed, opinions: [...actual.opinions].sort() }).toEqual({ seed, opinions: [...replay.opinions].sort() });
      } finally {
        await fresh.close();
      }
    }
  }, 300_000);
});
