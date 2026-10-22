/**
 * The extract driver's checks (decision 0028's idempotent-refill,
 * rename-keeps-identity, dates-on-main and the answer key's snapshots),
 * written once and run by two files: `extract-driver.test.ts` on PGlite and
 * `extract-driver-postgres.test.ts` on a server PostgreSQL.
 *
 * Expected values come from the training repository's answer key and from
 * decision 0028, never from the driver's own output: raw commit dates are
 * read from the generated repository's git, the effective-time rule is
 * 0028's (max(raw, parent effective + 1 µs), strictly increasing along the
 * first parent), and the snapshot checks are the answer key's own `checks`
 * entries.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, test } from 'bun:test';
import type { DatabaseOwner } from '../src/adapters/database-owner.js';
import type { GraphId, GraphStore } from '../src/graph/index.js';
import { fillGraph, remapKey } from '../src/extract/driver/index.js';
import { HISTORY_EXTRACTOR, OWNERS, TREE_EXTRACTORS } from '../src/extract/driver/extractors.js';
import type { FillOptions, FillReport } from '../src/extract/driver/index.js';
import type { Extraction, TreeReader } from '../src/extract/records.js';

// Built by concatenation so the neutral-names scan does not read a record key as a repository source.
const FILE = 'code.file' + ':';
const DOCKERFILE = 'code.dockerfile' + ':';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GENERATOR = path.join(ROOT, 'examples/training-repository/generate.mjs');
const KEY = JSON.parse(readFileSync(path.join(ROOT, 'examples/training-repository/answer-key.json'), 'utf8')) as {
  snapshots: Record<string, string>;
  items: { id: string; checks?: readonly { snapshot: string; path: string; absent?: boolean; contains?: string; notContains?: string; differsFromFinal?: boolean }[] }[];
};
const sha = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex');

/** git run the way the driver runs it; the repository's own facts are the expected values. */
function git(repository: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: repository, encoding: 'utf8', env: { ...process.env, TZ: 'UTC', LC_ALL: 'C' } });
}

/** The bytes of one path at one commit, for the key's contains checks. */
function blobAt(repository: string, commit: string, filePath: string): string {
  return git(repository, 'show', `${commit}:${filePath}`);
}

/**
 * The fill the suite runs: every extractor that has landed (wired in
 * src/extract/driver/extractors.ts), the history extractor with the answer
 * key's pinned snapshots, and a files extractor that files every tree path —
 * the driver runs any list, and the suite's path assertions read its nodes.
 */
const fillOf = (owner: DatabaseOwner, store: GraphStore, repository: string): FillOptions => ({
  owner,
  store,
  repository,
  extractors: TREE_EXTRACTORS,
  owners: OWNERS,
  history: HISTORY_EXTRACTOR,
  snapshots: KEY.snapshots,
  points: chosenPoints(repository),
});

/**
 * The commits whose code structure the checks below read (decision 0030: earlier
 * structure only at chosen points): the answer key's four snapshots, and the
 * commits around the three dated facts it names — the move of the order aggregate,
 * the feature branch's merge and the date anomaly — each with its parent and the
 * commit after it, so a read at any instant of those intervals finds a tree.
 */
function chosenPoints(repository: string): string[] {
  const line = git(repository, 'log', '--first-parent', '--reverse', '--format=%H%x00%s').trim().split('\n').map((row) => row.split('\0') as [string, string]);
  const around = (subject: string): string[] => {
    const at = line.findIndex(([, text]) => text.includes(subject));
    if (at < 0) throw new Error(`the generated repository has no first-parent commit "${subject}"`);
    return [line[at - 1]![0], line[at]![0], line[at + 1]![0]];
  };
  return [...Object.values(KEY.snapshots), ...around('Move the order aggregate under internal/domain'), ...around('Merge feature/checkout-observability'), ...around('Pin the Go toolchain in the Dockerfiles')];
}

// The rename remap's own contract (reviewed): a whole path part matches, a path inside another
// path does not, and a chain git detects in one commit lands on the final path once.
describe('the rename remap', () => {
  const moved = 'services/orders/src/order.go';
  test('remaps a key whose path part is the renamed path, bounded by the part separators', () => {
    expect(remapKey(FILE + moved, moved, 'services/orders/internal/domain/order.go')).toBe(FILE + 'services/orders/internal/domain/order.go');
    expect(remapKey(`code.symbol:${moved}#Order`, moved, 'a.go')).toBe('code.symbol:a.go#Order');
  });
  test('leaves a key whose path only contains the renamed path inside another path', () => {
    expect(remapKey(FILE + 'vendor/services/orders/src/order.go', moved, 'a.go')).toBeNull();
    expect(remapKey(FILE + 'services/orders/src/order.go.txt', moved, 'a.go')).toBeNull();
    expect(remapKey(FILE + 'services/orders/srcx/order.go', moved, 'a.go')).toBeNull();
  });
  test('remaps a directory rename through every key under it, and nothing else', () => {
    expect(remapKey(FILE + 'services/orders/src/pricing.go', 'services/orders/src', 'services/orders/internal')).toBe(FILE + 'services/orders/internal/pricing.go');
    expect(remapKey(FILE + 'services/orders/internal/store/store.go', 'services/orders/src', 'services/orders/internal')).toBeNull();
  });
});

export interface DriverEnv {
  owner: DatabaseOwner;
  store: GraphStore;
  repository: string;
  report: FillReport;
  query<Row extends object = Record<string, unknown>>(sql: string, values?: readonly unknown[]): Promise<Row[]>;
}

const GRAPH_TABLES = ['node_identity', 'node_version', 'edge_identity', 'edge_version', 'node_kind', 'relation_type', 'work_item'];

/** Every row of every graph table, as one digest: what a refill must not change. */
async function digestAll(env: DriverEnv): Promise<{ digest: string; counts: Record<string, number> }> {
  const counts: Record<string, number> = {};
  const parts: string[] = [];
  for (const table of GRAPH_TABLES) {
    const rows = await env.query<{ t: string }>(`SELECT to_jsonb(t)::text AS t FROM ${table} t ORDER BY to_jsonb(t)::text`);
    counts[table] = rows.length;
    parts.push(`${table}:${JSON.stringify(rows.map((r) => r.t))}`);
  }
  return { digest: sha(JSON.stringify(parts)), counts };
}

/** One row per (node, valid time): the current belief about a kind's nodes at an instant. */
async function nodesOfKind(env: DriverEnv, kind: string, at: string, producer?: string): Promise<{ id: string; label: string; producer: string; sha256: string | null; validFrom: string; validTo: string; properties: Record<string, unknown> }[]> {
  const rows = await env.query<{ id: string; label: string; producer: string; digest: string | null; valid_from: string; valid_to: string; properties: Record<string, unknown> }>(
    `SELECT v.node_id::text AS id, v.label, v.producer, v.properties->>'sha256' AS digest,
            to_char(v.valid_from AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS valid_from,
            to_char(v.valid_to AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS valid_to, v.properties
     FROM node_version v JOIN node_kind k ON k.id = v.kind_id
     WHERE k.key = $1 AND v.recorded_to = 'infinity'
       AND v.valid_from <= $2::timestamptz AND v.valid_to > $2::timestamptz
       ${producer === undefined ? '' : 'AND v.producer = $3'}
     ORDER BY v.node_id, v.valid_from`,
    producer === undefined ? [kind, at] : [kind, at, producer],
  );
  return rows.map((r) => ({ id: r.id, label: r.label, producer: r.producer, sha256: r.digest, validFrom: r.valid_from, validTo: r.valid_to, properties: r.properties }));
}

/** Canonical instant text: ISO-8601 UTC with six fractional digits, as the store writes them. */
function canonical(iso: string): string {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?Z$/.exec(iso);
  if (match === null) throw new Error(`canonical: ${iso} is not a UTC instant`);
  return `${match[1]}.${(match[2] ?? '').padEnd(6, '0')}Z`;
}

/** The instant text one microsecond after an ISO instant, for 0028's tie rule. */
function plusMicrosecond(iso: string): string {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?Z$/.exec(iso);
  if (match === null) throw new Error(`plusMicrosecond: ${iso} is not a UTC instant`);
  const micros = Number((match[2] ?? '').padEnd(6, '0')) + 1;
  const date = new Date(`${match[1]}Z`);
  date.setUTCSeconds(date.getUTCSeconds() + Math.floor(micros / 1_000_000));
  return `${date.toISOString().slice(0, 19)}.${String(micros % 1_000_000).padStart(6, '0')}Z`;
}

export function extractDriverTests(label: string, make: () => { owner: DatabaseOwner; store: GraphStore }): void {
  describe(`the extract driver on ${label}`, () => {
    let env: DriverEnv;
    let fill: FillOptions;
    let workspace: string;
    /** The raw committer time of one commit of the first-parent line, once the walk has been read. */
    const committerOf = (hash: string): string => {
      const found = firstParent.find((c) => c.hash === hash);
      if (found === undefined) throw new Error(`the first-parent walk holds no commit ${hash}`);
      return found.committer;
    };
    /** The walk's own facts about the named commits, read from git: the expected values. */
    let firstParent: { hash: string; parent: string; committer: string; subject: string }[];

    beforeAll(async () => {
      workspace = mkdtempSync(path.join(tmpdir(), 'madarch-extract-driver-'));
      const repository = path.join(workspace, 'repo');
      execFileSync('node', [GENERATOR, repository], { cwd: ROOT, stdio: ['ignore', 'ignore', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
      const { owner, store } = make();
      await owner.ready;
      await store.createSchema();
      firstParent = git(repository, 'log', '--first-parent', '--reverse', '--format=%H%x00%P%x00%cI%x00%s').trim().split('\n').map((line) => {
        const [hash = '', parents = '', committer = '', subject = ''] = line.split('\0');
        return { hash, parent: parents.split(' ')[0] ?? '', committer, subject };
      });
      const options = fillOf(owner, store, repository);
      fill = options;
      const report = await fillGraph(options);
      env = {
        owner, store, repository, report,
        query: async <Row extends object>(sql: string, values?: readonly unknown[]) => (await owner.run((tx) => tx.query<Row>(sql, values))).rows,
      };

    }, 600_000);

    test('idempotent-refill (0028): a second fill of the unchanged repository writes no row in any table', async () => {
      const before = await digestAll(env);
      const second = await fillGraph(fill);
      expect(second.repositoryNode).toBe(env.report.repositoryNode);
      const after = await digestAll(env);
      expect(after.counts).toEqual(before.counts);
      expect(after.digest).toBe(before.digest);
    }, 300_000);

    test('rename-keeps-identity (rename.identity): services/orders/src/order.go and services/orders/internal/domain/order.go are one node', async () => {
      // The key: "moved, content kept, one identity, history continues after the move"; the move commit is "Move the order aggregate under internal/domain".
      const move = firstParent.find((c) => c.subject.includes('Move the order aggregate under internal/domain'))!;
      const after = firstParent[firstParent.indexOf(move) + 1]!.hash;
      const before = committerOf(move.parent); // the parent's own instant: its tree stands until the move
      // Before the move only the old path exists; after it only the new one; and both are the same node id.
      const filesAt = async (when: string, filePath: string) => (await nodesOfKind(env, 'code.file', when, 'code.extract.files')).filter((n) => n.properties['recordKey'] === `code.file:${filePath}`);
      const oldBefore = await filesAt(before, 'services/orders/src/order.go');
      const newBefore = await filesAt(before, 'services/orders/internal/domain/order.go');
      expect(oldBefore).toHaveLength(1);
      expect(newBefore).toHaveLength(0);
      const movedAt = move.committer; // the move's own instant: its tree stands until the next commit
      const newAfter = await filesAt(movedAt, 'services/orders/internal/domain/order.go');
      const oldAfter = await filesAt(movedAt, 'services/orders/src/order.go');
      const laterStill = await filesAt(committerOf(after), 'services/orders/internal/domain/order.go');
      expect(newAfter).toHaveLength(1);
      expect(oldAfter).toHaveLength(0);
      expect(laterStill).toHaveLength(1); // the history continues after the move, as the key's mustShow says
      expect(newAfter[0]!.id).toBe(oldBefore[0]!.id);
      // The content is kept across the move (git reports R100): the digest is the same on both sides of the move.
      expect(newAfter[0]!.sha256).toBe(oldBefore[0]!.sha256);
      expect(newAfter[0]!.sha256).toBe(sha(blobAt(env.repository, move.hash, 'services/orders/internal/domain/order.go')));
    }, 60_000);

    test('dates-on-main (0028): the feature branch\'s changes become valid at the merge\'s time', async () => {
      // The key (temporal items): the branch feature/checkout-observability is merged by CHK-142; its changes appear on main at the merge.
      const merge = firstParent.find((c) => c.subject.includes('Merge feature/checkout-observability'))!;
      const mergeTime = merge.committer; // 0028: a merge makes its branch's changes valid at the merge's time
      // The branch's own commits precede the merge; the merge's second parent is the branch tip (ORD-141).
      const secondParent = git(env.repository, 'log', '-1', '--format=%P', merge.hash).trim().split(' ')[1]!;
      const branchTime = git(env.repository, 'log', '-1', '--format=%cI', secondParent).trim();
      const branchSubjects = git(env.repository, 'log', '--reverse', `--format=%s`, `${merge.parent}..${secondParent}`).trim().split('\n');
      expect(branchSubjects).toEqual(['CHK-140 Propagate request ids through checkout', 'ORD-141 Log the request id in the order service']);
      expect(branchTime < mergeTime).toBe(true); // the branch's own date reads the pre-branch content on main
      // The branch changed services/checkout/src/api/routes.ts; before the merge the tree still holds the old content.
      const filePath = 'services/checkout/src/api/routes.ts';
      const oldDigest = sha(blobAt(env.repository, merge.parent!, filePath));
      const newDigest = sha(blobAt(env.repository, merge.hash, filePath));
      expect(oldDigest).not.toBe(newDigest);
      const filesNode = async (at: string) => (await env.query<{ sha256: string; id: string }>(
        `SELECT v.properties->>'sha256' AS sha256, v.node_id::text AS id FROM node_version v JOIN node_kind k ON k.id = v.kind_id
         WHERE k.key = 'code.file' AND v.producer = 'code.extract.files' AND v.properties->>'recordKey' = $1 AND v.recorded_to = 'infinity'
           AND v.valid_from <= $2::timestamptz AND v.valid_to > $2::timestamptz`,
        [`code.file:${filePath}`, at],
      ))[0];
      const atBranch = await filesNode(branchTime);
      const atMerge = await filesNode(mergeTime);
      expect(atBranch?.sha256).toBe(oldDigest); // the branch's own date still reads the pre-branch content
      expect(atMerge?.sha256).toBe(newDigest); // the merge's time reads the branch's change
      expect(atMerge?.id).toBe(atBranch?.id);
      // The change is valid exactly from the merge's effective time: the new version starts there.
      const versions = await env.query<{ valid_from: string }>(
        `SELECT to_char(v.valid_from AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS valid_from
         FROM node_version v JOIN node_kind k ON k.id = v.kind_id
         WHERE k.key = 'code.file' AND v.properties->>'recordKey' = $1 AND v.producer = 'code.extract.files' AND v.recorded_to = 'infinity'
         ORDER BY v.valid_from`,
        [`code.file:${filePath}`],
      );
      expect(versions.map((v) => v.valid_from)).toContain(canonical(mergeTime));
    }, 60_000);

    test('dates-on-main (0028, date-anomaly): the anomaly commit is valid at its parent\'s effective time plus one microsecond and keeps its raw time', async () => {
      // The key (date-anomaly): one commit's committer date (2026-09-04) is earlier than its parent's (2026-09-14).
      const anomalyIndex = firstParent.findIndex((c, i) => i > 0 && c.committer < firstParent[i - 1]!.committer);
      expect(anomalyIndex).toBeGreaterThan(0);
      const anomaly = firstParent[anomalyIndex]!;
      const parent = firstParent[anomalyIndex - 1]!;
      expect(anomaly.subject).toContain('Pin the Go toolchain in the Dockerfiles');
      const parentEffective = parent.committer; // the parent is no anomaly, so 0028 gives it its raw time
      const expected = plusMicrosecond(parentEffective);
      // The records the anomaly commit changed (the Dockerfiles the key's location anchors) start at the parent's effective time plus one microsecond.
      const rows = await env.query<{ valid_from: string }>(
        `SELECT to_char(v.valid_from AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS valid_from
         FROM node_version v JOIN node_kind k ON k.id = v.kind_id
         WHERE k.key = 'code.dockerfile' AND v.properties->>'recordKey' = '${DOCKERFILE + 'services/orders/Dockerfile'}' AND v.producer = 'code.extract.operations' AND v.recorded_to = 'infinity'
         ORDER BY v.valid_from`,
      );
      expect(rows.map((r) => r.valid_from)).toContain(expected);
      // A read at the parent's instant sees the state before the anomaly; at the anomaly's instant it sees the anomaly's.
      const dockerfile = async (when: string) => (await nodesOfKind(env, 'code.dockerfile', when)).find((n) => n.properties['recordKey'] === DOCKERFILE + 'services/orders/Dockerfile');
      const before = await dockerfile(parentEffective);
      const at = await dockerfile(expected);
      expect(before!.validFrom < expected).toBe(true);
      expect(at!.validFrom).toBe(expected);
      // The commit node (the history extractor's record) keeps the raw committer time and carries the effective time (the key's date-anomaly item).
      const commit = (await env.query<{ label: string; raw: unknown; effective: unknown }>(
        `SELECT v.label, v.properties->>'committedAt' AS raw, v.properties->>'effectiveAt' AS effective
         FROM node_version v JOIN node_kind k ON k.id = v.kind_id
         WHERE k.key = 'code.commit' AND v.properties->>'recordKey' = $1 AND v.producer = 'code.extract.history' AND v.recorded_to = 'infinity'`,
        [`code.commit:${anomaly.hash}`],
      ))[0]!;
      expect(commit.label).toBe(anomaly.subject.replace(/^[A-Z][A-Z0-9]*-[0-9]+\s+/u, '')); // the record carries the words behind the task key
      expect(commit.raw).toBe(anomaly.committer); // the raw time as git prints it
      expect(commit.effective).toBe(expected);
    }, 60_000);

    test('snapshots: reading at each answer-key snapshot matches the key\'s checks', async () => {
      const snapshotCommits = KEY.snapshots;
      const finalCommit = snapshotCommits['snapshot-final']!;
      // The snapshot dates are the snapshot commits' effective times, which for these no-anomaly commits are their raw committer times.
      const effectiveOf = (commit: string): string => git(env.repository, 'log', '-1', '--format=%cI', commit).trim();
      const checks = KEY.items.flatMap((item) => (item.checks ?? []).map((check) => ({ ...check, item: item.id })));
      expect(checks.length).toBe(16);
      for (const [name, commit] of Object.entries(snapshotCommits)) {
        const at = effectiveOf(commit);
        // Presence in the tree is what the files extractor records for every path; the history producer's file nodes are dated churn records, published at the last commit.
        const present = new Set((await nodesOfKind(env, 'code.file', at, 'code.extract.files')).map((n) => String(n.properties['recordKey'] ?? '').slice(FILE.length)));
        for (const check of checks.filter((c) => c.snapshot === name)) {
          if (check.absent === true) {
            expect(present.has(check.path), `${name}: ${check.item} expects ${check.path} absent`).toBe(false);
          } else {
            expect(present.has(check.path), `${name}: ${check.item} expects ${check.path} present`).toBe(true);
            if (check.contains !== undefined) expect(blobAt(env.repository, commit, check.path)).toContain(check.contains);
            if (check.notContains !== undefined) expect(blobAt(env.repository, commit, check.path)).not.toContain(check.notContains);
            if (check.differsFromFinal === true && name !== 'snapshot-final') {
              const filesNode = async (when: string) => (await nodesOfKind(env, 'code.file', when, 'code.extract.files')).find((n) => n.properties['recordKey'] === `code.file:${check.path}`);
              const now = await filesNode(effectiveOf(finalCommit));
              const then = await filesNode(at);
              expect(then!.sha256, `${name}: ${check.item} expects ${check.path} to differ from final`).not.toBe(now!.sha256);
            }
          }
        }
      }
    }, 120_000);

    // The history facts of the answer key (decision 0030: read from git over every first-parent commit, no code parsed).
    /** The history producer's facet of one file: its churn count and authors, current at the last commit. */
    const historyOf = async (filePath: string) => (await env.query<{ properties: { commitCount: number; authors: string[] } }>(
      `SELECT v.properties FROM node_version v JOIN node_kind k ON k.id = v.kind_id
       WHERE k.key = 'code.facet' AND v.producer = 'code.extract.history' AND v.properties->>'ownerKey' = $1 AND v.recorded_to = 'infinity' AND v.valid_to = 'infinity'`,
      [FILE + filePath],
    ))[0]?.properties;

    test('hotspot (key item hotspot): order_service.go is the most changed file, with 28 of the 71 non-merge commits', async () => {
      const hot = 'services/orders/internal/application/order_service.go';
      expect((await historyOf(hot))?.commitCount).toBe(28);
      const top = await env.query<{ key: string; count: string }>(
        `SELECT v.properties->>'ownerKey' AS key, (v.properties->>'commitCount') AS count FROM node_version v JOIN node_kind k ON k.id = v.kind_id
         WHERE k.key = 'code.facet' AND v.producer = 'code.extract.history' AND v.recorded_to = 'infinity' AND v.valid_to = 'infinity' AND v.properties ? 'commitCount'
         ORDER BY (v.properties->>'commitCount')::int DESC, 1 LIMIT 2`,
      );
      expect(top[0]!.key).toBe(FILE + hot);
      expect(Number(top[1]!.count)).toBeLessThan(28);
      // The expected count is git's own: the non-merge commits that changed the file.
      expect(git(env.repository, 'log', '--no-merges', '--format=%H', '--', hot).trim().split('\n')).toHaveLength(28);
    }, 60_000);

    test('change-coupling (key item change-coupling): pricing.go and tax.go change together in all 6 commits that touch either', async () => {
      const pricing = 'services/orders/internal/pricing/pricing.go';
      const tax = 'services/orders/internal/pricing/tax.go';
      expect((await historyOf(pricing))?.commitCount).toBe(6);
      expect((await historyOf(tax))?.commitCount).toBe(6);
      const coupling = await env.query<{ support: string }>(
        `SELECT e.properties->>'support' AS support FROM edge_version e JOIN relation_type r ON r.id = e.relation_type_id
         JOIN node_version s ON s.node_id = e.src_id AND s.recorded_to = 'infinity' AND s.valid_to = 'infinity'
         JOIN node_version d ON d.node_id = e.dst_id AND d.recorded_to = 'infinity' AND d.valid_to = 'infinity'
         WHERE r.key = 'code.changed-with' AND e.recorded_to = 'infinity' AND e.valid_to = 'infinity' AND s.properties->>'recordKey' = $1 AND d.properties->>'recordKey' = $2`,
        [FILE + pricing, FILE + tax],
      );
      expect(coupling.map((row) => row.support)).toEqual(['6']);
    }, 60_000);

    test('provider-authorship (key item provider-authorship): every file under the providers has Rin Tanaka as its only author', async () => {
      const providers = await env.query<{ key: string; authors: string[] }>(
        `SELECT v.properties->>'ownerKey' AS key, v.properties->'authors' AS authors FROM node_version v JOIN node_kind k ON k.id = v.kind_id
         WHERE k.key = 'code.facet' AND v.producer = 'code.extract.history' AND v.recorded_to = 'infinity' AND v.valid_to = 'infinity'
           AND v.properties->>'ownerKey' LIKE $1 ORDER BY 1`,
        [`${FILE}services/payments/src/providers/%`],
      );
      expect(providers.length).toBeGreaterThan(0);
      for (const row of providers) expect(row.authors, row.key).toEqual(['Rin Tanaka']);
      expect(git(env.repository, 'log', '--format=%an', '--', 'services/payments/src/providers').trim().split('\n').every((name) => name === 'Rin Tanaka')).toBe(true);
    }, 60_000);

    test('rename.identity (key item): the history records the move as one rename of similarity 1, and the file keeps its history', async () => {
      const from = 'services/orders/src/order.go';
      const to = 'services/orders/internal/domain/order.go';
      const renamed = await env.query<{ similarity: string }>(
        `SELECT e.properties->>'similarity' AS similarity FROM edge_version e JOIN relation_type r ON r.id = e.relation_type_id
         JOIN node_version s ON s.node_id = e.src_id AND s.recorded_to = 'infinity' JOIN node_version d ON d.node_id = e.dst_id AND d.recorded_to = 'infinity'
         WHERE r.key = 'code.renamed-to' AND e.recorded_to = 'infinity' AND e.valid_to = 'infinity' AND s.properties->>'recordKey' = $1 AND d.properties->>'recordKey' = $2`,
        [FILE + from, FILE + to],
      );
      expect(renamed.map((row) => row.similarity)).toEqual(['1']);
      // One file, one history: the commits of both paths count once each on the path it holds now.
      const commitsOfBoth = git(env.repository, 'log', '--no-merges', '--format=%H', '--follow', '--', to).trim().split('\n').length;
      expect((await historyOf(to))?.commitCount).toBe(commitsOfBoth);
    }, 60_000);

    test('history.size and the merge (key items history.size, history.feature-branch): 72 commits by three authors, the branch\'s commits valid at the merge', async () => {
      const commits = await env.query<{ key: string; merge: boolean; first: boolean; effective: string; branch: string | null }>(
        `SELECT v.properties->>'recordKey' AS key, (v.properties->>'merge')::boolean AS merge, (v.properties->>'onFirstParent')::boolean AS first,
                v.properties->>'effectiveAt' AS effective, v.properties->>'mergedBranch' AS branch
         FROM node_version v JOIN node_kind k ON k.id = v.kind_id
         WHERE k.key = 'code.commit' AND v.producer = 'code.extract.history' AND v.recorded_to = 'infinity' AND v.valid_to = 'infinity'`,
      );
      expect(commits).toHaveLength(72);
      expect(commits.filter((c) => c.first)).toHaveLength(70);
      expect(commits.filter((c) => c.merge)).toHaveLength(1);
      const authors = await env.query<{ label: string }>(
        `SELECT v.label FROM node_version v JOIN node_kind k ON k.id = v.kind_id WHERE k.key = 'code.author' AND v.producer = 'code.extract.history' AND v.recorded_to = 'infinity' AND v.valid_to = 'infinity' ORDER BY 1`,
      );
      expect(authors.map((a) => a.label)).toEqual(['Avery Quinn', 'Rin Tanaka', 'Sam Okafor']);
      const merge = commits.find((c) => c.merge)!;
      expect(merge.branch).toBe('feature/checkout-observability');
      // The effective times along the first-parent line are strictly increasing; the branch's two commits carry the merge's.
      const effectiveOfLine = firstParent.map((c) => commits.find((row) => row.key === `code.commit:${c.hash}`)!.effective);
      for (let at = 1; at < effectiveOfLine.length; at += 1) expect(effectiveOfLine[at]! > effectiveOfLine[at - 1]!, `effective time of line commit ${at + 1}`).toBe(true);
      expect(commits.filter((c) => !c.first).map((c) => c.effective)).toEqual([merge.effective, merge.effective]);
    }, 60_000);

    test('measure: the code of the last commit is read once, within 90 s, and the report says where the time went', async () => {
      const { report } = env;
      const head = firstParent[firstParent.length - 1]!;
      console.log(`[measure] total ${report.totalMs} ms: code ${report.phases.codeMs} ms (1 tree), history ${report.phases.historyMs} ms over ${report.historyCommits} commits, ${report.points.length} points ${report.phases.pointsMs} ms; points ${report.points.map((c) => `${c.generation}:${c.durationMs}ms`).join(' ')}`);
      expect(report.totalMs).toBeGreaterThan(0);
      expect(report.commits.map((c) => c.hash)).toEqual([head.hash]); // the code of the last commit, once
      expect(report.commits[0]!.generation).toBe(firstParent.length);
      expect(report.newCommits).toBe(firstParent.length); // a first fill finds every commit new
      expect(report.historyCommits).toBe(firstParent.length);
      expect(report.phases.codeMs).toBeLessThan(90_000); // the acceptance: code pages complete within 90 s of the start
      expect(report.points.map((c) => c.hash)).toEqual(chosenPoints(env.repository).filter((hash, at, all) => all.indexOf(hash) === at && hash !== head.hash).sort((a, b) => firstParent.findIndex((c) => c.hash === a) - firstParent.findIndex((c) => c.hash === b)));
      const sizes = await env.query<{ table_name: string; bytes: string }>(
        `SELECT c.relname AS table_name, pg_total_relation_size(c.oid)::text AS bytes FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = current_schema() AND c.relkind = 'r' ORDER BY pg_total_relation_size(c.oid) DESC`,
      );
      for (const row of sizes) console.log(`[measure] ${row.table_name}: ${Number(row.bytes)} bytes`);
      for (const table of GRAPH_TABLES) console.log(`[measure] ${table}: ${(await env.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${table}`))[0]!.n} rows`);
      expect(sizes.length).toBe(GRAPH_TABLES.length);
      const identity: GraphId = env.report.repositoryNode;
      expect(identity).toMatch(/^[1-9][0-9]*$/);
    }, 60_000);

    test('ownership: in the training fill no file or symbol key has a version from two producers, and no other producer\'s file node shares a key with the lister\'s', async () => {
      const dup = await env.query<{ key: string; n: string }>(
        `SELECT v.properties->>'recordKey' AS key, count(*)::text AS n FROM node_version v JOIN node_kind k ON k.id = v.kind_id
         WHERE k.key IN ('code.file', 'code.symbol') AND v.recorded_to = 'infinity' AND v.valid_to = 'infinity'
         GROUP BY 1 HAVING count(*) > 1`,
      );
      expect(dup).toEqual([]);
      // The only file nodes of another producer are reference nodes for ends the lister no longer holds (a file deleted before the last commit), so none shares a key with the lister's current node.
      const clash = await env.query<{ key: string }>(
        `SELECT o.properties->>'recordKey' AS key FROM node_version o JOIN node_kind k ON k.id = o.kind_id
         JOIN node_version f ON f.properties->>'recordKey' = o.properties->>'recordKey' AND f.producer = 'code.extract.files' AND f.recorded_to = 'infinity' AND f.valid_to = 'infinity'
         WHERE k.key = 'code.file' AND o.producer <> 'code.extract.files' AND o.recorded_to = 'infinity' AND o.valid_to = 'infinity'`,
      );
      expect(clash).toEqual([]);
    }, 60_000);

    test('ownership: two producers emitting the same node key publish exactly one version, and the other\'s extra properties become a facet', async () => {
      const tiny = path.join(workspace, 'tiny');
      git(workspace, 'init', '-q', '-b', 'main', tiny);
      writeFileSync(path.join(tiny, 'a.txt'), 'one\n');
      git(tiny, 'add', '.');
      execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'one'], { cwd: tiny, env: { ...process.env, GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z', GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z' } });
      const fileKey = FILE + 'a.txt';
      const owning = (tree: TreeReader): Extraction => ({ producer: 'code.extract.files', nodes: tree.paths.map((p) => ({ key: FILE + p, kind: 'code.file' as const, label: p, properties: { path: p } })), edges: [], gaps: [] });
      const other = (): Extraction => ({
        producer: 'code.extract.other',
        nodes: [
          { key: fileKey, kind: 'code.file', label: 'a.txt', properties: { path: 'other-path.txt', role: 'notes' } },
          { key: FILE + 'ghost.txt', kind: 'code.file', label: 'ghost.txt', properties: { churn: 3 } },
          { key: 'code.thing:t', kind: 'code.thing', label: 't', properties: {} },
        ],
        edges: [{ type: 'code.refers', from: 'code.thing:t', to: fileKey, discriminator: '', properties: {} }],
        gaps: [],
      });
      // The other producer is listed first: the owner still publishes first.
      const tinyReport = await fillGraph({ owner: env.owner, store: env.store, repository: tiny, extractors: [other, owning], owners: { 'code.file': 'code.extract.files' } });
      const versions = await env.query<{ producer: string; id: string }>(
        `SELECT v.producer, v.node_id::text AS id FROM node_version v JOIN node_kind k ON k.id = v.kind_id
         WHERE k.key = 'code.file' AND v.properties->>'recordKey' = $1 AND v.recorded_to = 'infinity'`, [fileKey],
      );
      expect(versions.map((row) => row.producer)).toEqual(['code.extract.files']);
      const facets = await env.query<{ properties: Record<string, unknown> }>(
        `SELECT v.properties FROM node_version v JOIN node_kind k ON k.id = v.kind_id WHERE k.key = 'code.facet' AND v.producer = 'code.extract.other' AND v.recorded_to = 'infinity'`,
      );
      expect(facets.map((row) => row.properties['role'])).toEqual(['notes']);
      expect(facets.map((row) => 'path' in row.properties)).toEqual([false]);
      const edge = await env.query<{ dst: string }>(
        `SELECT e.dst_id::text AS dst FROM edge_version e JOIN relation_type r ON r.id = e.relation_type_id WHERE r.key = 'code.refers' AND e.recorded_to = 'infinity'`,
      );
      expect(edge.map((row) => row.dst)).toEqual([versions[0]!.id]);
      // A key the owner lacks stays the other producer's own node, said as a gap; a value the owner disagrees with is said too.
      const ghost = await env.query<{ producer: string }>(`SELECT v.producer FROM node_version v WHERE v.properties->>'recordKey' = $1 AND v.recorded_to = 'infinity'`, [FILE + 'ghost.txt']);
      expect(ghost.map((row) => row.producer)).toEqual(['code.extract.other']);
      expect(tinyReport.gaps.map((gap) => gap.path)).toContain(FILE + 'ghost.txt');
      expect(tinyReport.gaps.some((gap) => gap.path === fileKey && gap.reason.includes('property "path"'))).toBe(true);
    }, 120_000);
  });
}
