import { prepareStore } from '../src/adapters/prepare-store.js';
/**
 * The journal is the history (decision 0034, A6): rows hold the present, and history is a snapshot plus the journal's
 * replay. This file plays a sequence of the writer's changes against a real store — declarations, changed values,
 * re-evidence, a translation, a second producer, withdrawals, a bulk edge declaration, an edge removal and a pass
 * whose journal is split into several rows in one transaction — and replays the journal, row by row and in its durable
 * order (`operation.seq`), into an **empty** database. The replayed store is compared with the source at several cut
 * points: every vertex with its entity, key and removal mark; every live edge with its identity; every open opinion of
 * every entity table with every column (`translated_from` and `source_digest` included); the contexts; and the answers
 * the wiki's own reader (`GraphReader`) gives of both stores (madarch-64o5.2, stage 2b; codex, stage 2 review, P2).
 */
import { describe, expect, test } from 'bun:test';
import type { DatabaseOwner } from '../src/adapters/database-owner.js';
import { GIT_KINDS, GIT_TABLES } from '../src/fill/stages/git-contract.js';
import { repositoryContract, repositoryKindReads, repositoryEdgeReads } from './repository-contract-fixture.js';
import type { KeyValueDraft } from '../src/graph/contract.js';
import { canonicalJson, ensureVertex, journalFor, journalOn, publishOpinion, removeEdgeById, removeEntity, writeJournal } from '../src/graph/write.js';
import { GraphReader } from '../src/knowledge/graph-read.js';
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

const PATHS = ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts', 'src/e.ts'] as const;
const keyOf = (path: string): Readonly<Record<string, KeyValueDraft>> => ({ repository: 'fixture', path });

/** A file opinion as a producer states it. */
function opinion(path: string, producer: string, language: string | null, line: number) {
  return {
    values: { mode: '100644', language, languages: language === null ? ['TypeScript', 'XML'] : [language] },
    evidence: [{ type: 'file' as const, repository: 'fixture', commit_or_digest: 'c0ffee', path, line_start: line, line_end: line }],
    producer, producerVersion: producer === 'linguist' ? '9.5.0' : '1',
  };
}

/** One step of the sequence: it writes one entry, or several where it says so. */
type Step =
  | { readonly kind: 'opinion'; readonly path: string; readonly producer: string; readonly language: string | null; readonly line: number }
  | { readonly kind: 'translation'; readonly path: string; readonly producer: string; readonly language: string; readonly line: number }
  | { readonly kind: 'withdraw'; readonly path: string; readonly producer: string }
  | { readonly kind: 'bulk-edges' }
  | { readonly kind: 'edge-remove' }
  | { readonly kind: 'split-pass' };

/** The steps every sequence plays, so each kind of change is in the comparison whatever the seed draws. */
const PREFIX: readonly Step[] = [
  { kind: 'opinion', path: 'src/a.ts', producer: 'linguist', language: 'TypeScript', line: 3 },
  { kind: 'opinion', path: 'src/a.ts', producer: 'linguist', language: 'JavaScript', line: 3 },
  { kind: 'opinion', path: 'src/a.ts', producer: 'linguist', language: 'JavaScript', line: 5 },
  { kind: 'translation', path: 'src/a.ts', producer: 'ru', language: 'ru', line: 3 },
  { kind: 'opinion', path: 'src/a.ts', producer: 'scanner', language: 'TypeScript', line: 3 },
  { kind: 'withdraw', path: 'src/a.ts', producer: 'linguist' },
  { kind: 'opinion', path: 'src/b.ts', producer: 'linguist', language: 'XML', line: 1 },
  { kind: 'opinion', path: 'src/c.ts', producer: 'linguist', language: 'XML', line: 1 },
  { kind: 'bulk-edges' },
  { kind: 'edge-remove' },
  { kind: 'split-pass' },
  { kind: 'withdraw', path: 'src/a.ts', producer: 'scanner' },
  { kind: 'opinion', path: 'src/a.ts', producer: 'scanner', language: 'JavaScript', line: 7 },
];

/** A sequence: the prefix, then random steps from one seed. */
function sequence(seed: number): Step[] {
  const next = rng(seed);
  const steps: Step[] = [...PREFIX];
  for (let at = 0; at < 8; at += 1) {
    const choice = next();
    const path = PATHS[Math.floor(next() * PATHS.length)]!;
    const producer = next() < 0.5 ? 'linguist' : 'scanner';
    if (choice < 0.5) steps.push({ kind: 'opinion', path, producer, language: next() < 0.2 ? null : 'TypeScript', line: 1 + Math.floor(next() * 9) });
    else if (choice < 0.75) steps.push({ kind: 'withdraw', path, producer });
    else steps.push({ kind: 'opinion', path, producer, language: 'XML', line: 2 });
  }
  return steps;
}

/** One file node's local id, by its path. */
async function nodeOf(tx: { query(text: string, params?: unknown[]): Promise<{ rows: object[] }> }, path: string): Promise<string | undefined> {
  const found = await tx.query(`SELECT id::text AS id FROM node WHERE (key->>'path') = $1 AND (key->>'repository') = 'fixture'`, [path]);
  return (found.rows[0] as { id?: string } | undefined)?.id;
}

/** One step, applied to the source store in its own transaction (or transactions), as a producer's turn does. */
async function applyStep(owner: DatabaseOwner, step: Step): Promise<void> {
  if (step.kind === 'opinion' || step.kind === 'translation') {
    await owner.transaction('write', async (tx) => {
      const journal = journalFor('linguist@9.5.0');
      journalOn(tx, journal);
      const made = await ensureVertex(tx, repositoryContract, { kind: GIT_KINDS.file, key: keyOf(step.path) });
      const stated = opinion(step.path, step.producer, step.language, step.line);
      if (step.kind === 'translation') {
        // A translation states the opinion it came from and its source's digest: the columns a replay must carry whole.
        const source = await tx.query<{ id: string }>(`SELECT id::text AS id FROM ${GIT_TABLES.file} WHERE node_id = $1::bigint AND state = 'open' AND split_part(said_by, '@', 1) = 'linguist' ORDER BY id DESC LIMIT 1`, [made.nodeId]);
        await publishOpinion(tx, repositoryContract, { kind: GIT_KINDS.file, nodeId: made.nodeId, ...stated, producer: 'translator', producerVersion: '2', lang: 'ru', values: { mode: '100644', language: step.language }, translatedFrom: source.rows[0]?.id ?? '1', sourceDigest: 'sha256:9f2c' });
      } else {
        await publishOpinion(tx, repositoryContract, { kind: GIT_KINDS.file, nodeId: made.nodeId, ...stated });
      }
      await writeJournal(tx, journal);
    });
    return;
  }
  if (step.kind === 'withdraw') {
    await owner.transaction('write', async (tx) => {
      // The writer's own withdrawal: it closes the producer's opinions and journals the removal only where it happens.
      const journal = journalFor('linguist@9.5.0');
      journalOn(tx, journal);
      await removeEntity(tx, repositoryContract, { kind: GIT_KINDS.file, key: keyOf(step.path), producer: step.producer }, 1, journal);
      await writeJournal(tx, journal);
    });
    return;
  }
  if (step.kind === 'bulk-edges') {
    await owner.transaction('write', async (tx) => {
      const journal = journalFor('pass@1');
      journalOn(tx, journal);
      const b = await nodeOf(tx, 'src/b.ts');
      const c = await nodeOf(tx, 'src/c.ts');
      if (b === undefined || c === undefined) return;
      // The bulk declaration a history pass makes: one statement per batch, one event per edge, one entry.
      const made = await tx.query<{ id: string; from_node: string; to_node: string; discriminator: string }>(
        `INSERT INTO edge (entity_id, from_node, to_node, discriminator, context_id)
         SELECT (SELECT id FROM entity WHERE name = $1), $2::bigint, $3::bigint, $4, 1 UNION ALL SELECT (SELECT id FROM entity WHERE name = $1), $3::bigint, $2::bigint, $4, 1
         ON CONFLICT DO NOTHING RETURNING id::text AS id, from_node::text AS from_node, to_node::text AS to_node, discriminator`,
        [GIT_KINDS.renamedFrom, b, c, 'bulk'],
      );
      const uids = await tx.query<{ id: string; uid: string }>('SELECT id::text AS id, uid::text AS uid FROM node WHERE id = ANY($1::bigint[])', [`{${b},${c}}`]);
      const byId = new Map(uids.rows.map((row) => [row.id, row.uid]));
      for (const row of made.rows) journal.declaredEdge(GIT_KINDS.renamedFrom, row.id, byId.get(row.from_node) ?? '', byId.get(row.to_node) ?? '', row.discriminator, 1);
      await writeJournal(tx, journal);
    });
    return;
  }
  if (step.kind === 'edge-remove') {
    await owner.transaction('write', async (tx) => {
      const journal = journalFor('pass@1');
      journalOn(tx, journal);
      const held = await tx.query<{ id: string }>('SELECT id::text AS id FROM edge ORDER BY id LIMIT 1');
      if (held.rows[0] !== undefined) await removeEdgeById(tx, repositoryContract, GIT_KINDS.renamedFrom, held.rows[0].id);
      await writeJournal(tx, journal);
    });
    return;
  }
  // A pass whose journal is split: several rows in one transaction, written between the pass's own write batches.
  await owner.transaction('write', async (tx) => {
    const journal = journalFor('pass@1');
    journalOn(tx, journal);
    const drafts: Parameters<typeof publishOpinion>[2][] = [];
    for (const path of ['src/d.ts', 'src/e.ts']) {
      const made = await ensureVertex(tx, repositoryContract, { kind: GIT_KINDS.file, key: keyOf(path) });
      drafts.push({ kind: GIT_KINDS.file, nodeId: made.nodeId, ...opinion(path, 'linguist', 'TypeScript', 2) });
      if (journal.count() >= 2) {
        await writeJournal(tx, journal);
        journal.drain();
      }
    }
    for (const draft of drafts) await publishOpinion(tx, repositoryContract, draft);
    await writeJournal(tx, journal);
  });
}

/** Every entity table the contract declares, with the owner column and the field columns a row carries. */
function tablesOf(): { entity: string; table: string; owner: 'node_id' | 'edge_id'; fields: readonly string[] }[] {
  return [
    ...repositoryContract.vertex.map((kind) => ({ entity: kind.name, table: kind.table, owner: 'node_id' as const, fields: kind.fields.filter((field) => !kind.key.includes(field.name)).map((field) => field.name) })),
    ...repositoryContract.edge.filter((kind) => kind.table !== undefined).map((kind) => ({ entity: kind.name, table: kind.table!, owner: 'edge_id' as const, fields: kind.fields.map((field) => field.name) })),
  ];
}

/** One store's whole state, as the journal must reproduce it: rows, and the reader's own answers. */
async function snapshot(owner: DatabaseOwner): Promise<Record<string, unknown>> {
  return await owner.transaction('snapshot', async (tx) => {
    const contexts = await tx.query<Record<string, unknown>>('SELECT id::text AS id, parent::text AS parent, ref FROM context ORDER BY id');
    const vertices = await tx.query<Record<string, unknown>>(`SELECT n.uid::text AS uid, e.name AS entity, n.key, n.removed FROM node n JOIN entity e ON e.id = n.entity_id ORDER BY n.uid`);
    const edges = await tx.query<Record<string, unknown>>(
      `SELECT en.name AS entity, fn.uid::text AS "from", tn.uid::text AS "to", ed.discriminator, ed.context_id::text AS context_id
       FROM edge ed JOIN entity en ON en.id = ed.entity_id JOIN node fn ON fn.id = ed.from_node JOIN node tn ON tn.id = ed.to_node ORDER BY en.name, "from", "to", ed.discriminator, ed.context_id`,
    );
    const opinions: Record<string, unknown>[] = [];
    for (const one of tablesOf()) {
      const rows = await tx.query<Record<string, unknown>>(
        `SELECT t.id::text AS id, '${one.entity}' AS entity, ${one.owner === 'node_id' ? 'n.uid::text' : 't.edge_id::text'} AS owner,
                t.said_by, to_char(t.said_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') || 'Z' AS said_at, t.state,
                t.reason, t.confirmed_field, t.confirmed_with, t.evidence, t.lang, t.translated_from::text AS translated_from,
                t.source_digest, t.context_id::text AS context_id
                ${one.fields.length === 0 ? '' : `, ${one.fields.map((field) => `t."${field}" AS "${field}"`).join(', ')}`}
         FROM ${one.table} t ${one.owner === 'node_id' ? 'JOIN node n ON n.id = t.node_id' : ''}
         WHERE t.state = 'open' ORDER BY t.id`,
      );
      for (const row of rows.rows) opinions.push(row);
    }
    return { contexts: contexts.rows, vertices: vertices.rows, edges: edges.rows, opinions };
  });
}

/** The answers the wiki's reader gives of one store: the file listing and every file's entity with its sources. */
async function readerView(owner: DatabaseOwner): Promise<unknown> {
  const reader = new GraphReader(owner, () => '2026-11-11T00:00:00Z', undefined, undefined, undefined, repositoryKindReads, repositoryEdgeReads);
  const listed = await reader.byPrefix('code.file', 'code.file:', 500);
  const files = [];
  for (const entity of listed.rows) {
    const found = (await reader.find(entity.key))[0];
    files.push({ key: entity.key, kind: entity.kind, label: entity.label, properties: entity.properties, found: found === undefined ? null : { key: found.key, properties: found.properties, evidence: found.evidence ?? [], opinions: found.opinions ?? [] } });
  }
  return { total: listed.total, files };
}

/** The table an entity's opinions stand in. */
function tableOf(entity: string): { table: string; owner: 'node_id' | 'edge_id'; fields: readonly string[] } {
  const found = tablesOf().find((one) => one.entity === entity);
  if (found === undefined) throw new Error(`the contract declares no table for ${JSON.stringify(entity)}`);
  return found;
}

/**
 * Replays journal rows into a store that stands empty, in their durable order: a vertex from its entity, its uid and
 * its key; an edge from its ends' uids; an opinion from every column its opened event carries, with a closed one
 * deleted and a re-evidenced one's grounds replaced. This is the writer a snapshot's journal is played through — the
 * rows it makes are the rows the wiki's reader reads.
 */
async function replayInto(target: DatabaseOwner, entries: readonly { readonly change: Record<string, any> }[]): Promise<void> {
  await target.transaction('write', async (tx) => {
    for (const entry of entries) {
      const change = entry.change;
      for (const event of change['vertices'] ?? []) {
        if (event.state === 'declared') {
          await tx.query(
            `INSERT INTO node (entity_id, uid, key, context_id) SELECT id, $2::uuid, $3::jsonb, 1 FROM entity WHERE name = $1
             ON CONFLICT (uid) DO UPDATE SET removed = false, key = EXCLUDED.key`,
            [event.entity, event.uid, canonicalJson(event.key ?? {})],
          );
        } else {
          await tx.query('UPDATE node SET removed = true WHERE uid = $1::uuid', [event.uid]);
        }
      }
      for (const event of change['edges'] ?? []) {
        if (event.state === 'declared') {
          await tx.query(
            `INSERT INTO edge (id, entity_id, from_node, to_node, discriminator, context_id)
             OVERRIDING SYSTEM VALUE
             SELECT $1::bigint, en.id, fn.id, tn.id, $4, $5::bigint FROM entity en, node fn, node tn
             WHERE en.name = $2 AND fn.uid = $3::uuid AND tn.uid = $6::uuid
             ON CONFLICT DO NOTHING`,
            [event.edge, event.entity, event.from, event.discriminator, String(event.context), event.to],
          );
        } else {
          await tx.query('DELETE FROM edge WHERE id = $1::bigint', [event.edge]);
        }
      }
      for (const event of change['opinions'] ?? []) {
        const one = tableOf(String(event.entity));
        if (event.state === 'closed') {
          await tx.query(`DELETE FROM ${one.table} WHERE id = $1::bigint`, [event.id]);
          continue;
        }
        if (event.state === 're-evidenced') {
          await tx.query(`UPDATE ${one.table} SET evidence = $2::jsonb WHERE id = $1::bigint`, [event.id, canonicalJson(event.evidence ?? [])]);
          continue;
        }
        const values = event.values ?? {};
        const ownerAt = 8 + one.fields.length;
        const owner = one.owner === 'node_id'
          ? { column: 'node_id', select: `(SELECT id FROM node WHERE uid = $${String(ownerAt)}::uuid)` }
          : { column: 'edge_id', select: `$${String(ownerAt)}::bigint` };
        const saidAt = ownerAt + 1;
        const params: unknown[] = [
          event.id, String(event.said_by), String(event.lang ?? ''), canonicalJson(event.evidence ?? []),
          event.translated_from === null || event.translated_from === undefined ? null : String(event.translated_from),
          event.source_digest ?? null, String(event.context ?? 1),
          ...one.fields.map((field) => (values[field] === null || values[field] === undefined ? null : typeof values[field] === 'object' ? canonicalJson(values[field]) : values[field])),
          one.owner === 'node_id' ? (event.node ?? null) : (event.edge ?? null),
          String(event.said_at ?? ''),
        ];
        await tx.query(
          `INSERT INTO ${one.table} (id, ${owner.column}, said_by, lang, evidence, translated_from, source_digest, context_id, state, said_at${one.fields.length === 0 ? '' : `, ${one.fields.map((field) => `"${field}"`).join(', ')}`})
           OVERRIDING SYSTEM VALUE VALUES ($1::bigint, ${owner.select}, $2, NULLIF($3, '')::text, $4::jsonb, $5::bigint, $6, $7::bigint, 'open', $${String(saidAt)}::timestamptz${one.fields.map((_, at) => `, $${String(8 + at)}`).join('')})`,
          params,
        );
      }
    }
  });
}

describe('a replay over the journal answers the store', () => {
  test('rows played in their durable order into an empty database reproduce every row, every column and the reader\'s answers', async () => {
    for (const seed of [11, 29]) {
      const source = await createTestDatabaseOwner();
      const target = await createTestDatabaseOwner();
      try {
        await prepareStore(source, { contract: repositoryContract });
        await prepareStore(target, { contract: repositoryContract });
        const steps = sequence(seed);
        // The state after every step, and how many journal rows existed then: the cut points the replay is held to.
        const states: Record<string, unknown>[] = [];
        const rowsAfter: number[] = [];
        for (const step of steps) {
          await applyStep(source, step);
          states.push({ ...(await snapshot(source)), reader: await readerView(source) });
          rowsAfter.push(Number((await source.transaction('snapshot', async (tx) => await tx.query<{ n: string }>('SELECT count(*)::text AS n FROM operation'))).rows[0]?.n ?? '0'));
        }
        const entries = await source.transaction('snapshot', async (tx) => await tx.query<{ change: Record<string, any>; seq: string }>('SELECT change, seq::text AS seq FROM operation ORDER BY operation.seq'));
        expect(entries.rows).toHaveLength(rowsAfter[rowsAfter.length - 1]!);
        // The order is the column's, and it is total: every row has its own number.
        expect(new Set(entries.rows.map((row) => row.seq)).size).toBe(entries.rows.length);
        // The cut points: every step boundary a few steps apart, so an intermediate state that is wrong while the last
        // one is right is named. The split pass writes several rows in one transaction and is compared between them too.
        const cuts = [2, 4, 6, 8, 9, 10, 11, 13, steps.length - 1];
        let applied = 0;
        let compared = 0;
        for (const cut of cuts) {
          const upto = rowsAfter[cut]!;
          await replayInto(target, entries.rows.slice(applied, upto));
          applied = upto;
          const actual = { ...(await snapshot(target)), reader: await readerView(target) };
          const expected = states[cut]!;
          expect({ seed, cut, state: actual }).toEqual({ seed, cut, state: expected });
          compared += 1;
        }
        expect(compared).toBe(cuts.length);
        // The split pass left several rows of one transaction in the source's journal, and the replay played them all.
        expect(entries.rows.filter((row) => row.change['vertices']?.some?.((one: { entity: string }) => one.entity === GIT_KINDS.file)).length).toBeGreaterThan(3);
      } finally {
        await source.close();
        await target.close();
      }
    }
  }, 300_000);
});
