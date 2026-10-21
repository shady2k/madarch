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
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, test } from 'bun:test';
import type { DatabaseOwner } from '../src/adapters/database-owner.js';
import type { GraphId, GraphStore } from '../src/graph/index.js';
import { fillGraph, remapKey } from '../src/extract/driver/index.js';
import { extractOperations } from '../src/extract/operations/index.js';
import type { CommitFact, FillOptions, FillReport } from '../src/extract/driver/index.js';
import type { Extraction, TreeReader } from '../src/extract/records.js';

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

/** A minimal extractor that files every tree path as a code.file node carrying its content digest. */
function extractFiles(tree: TreeReader): Extraction {
  return {
    producer: 'code.extract.files',
    nodes: tree.paths.map((filePath) => ({
      key: `code.file:${filePath}`,
      kind: 'code.file',
      label: filePath.slice(filePath.lastIndexOf('/') + 1),
      properties: { path: filePath, sha256: sha(tree.read(filePath)) },
    })),
    edges: [],
    gaps: [],
  };
}

/** A minimal history extractor in the shape src/extract/history will take: one code.commit node per commit. */
function extractHistory(commits: readonly CommitFact[]): Extraction {
  return {
    producer: 'code.extract.history',
    nodes: commits.map((commit) => ({
      key: `code.commit:${commit.hash}`,
      kind: 'code.commit',
      label: commit.subject,
      properties: { sha: commit.hash, rawCommitterTime: commit.committerTime, effectiveTime: commit.effectiveTime, author: commit.authorName },
    })),
    edges: [],
    gaps: [],
  };
}

// The rename remap's own contract (reviewed): a whole path part matches, a path inside another
// path does not, and a chain git detects in one commit lands on the final path once.
describe('the rename remap', () => {
  const moved = 'services/orders/src/order.go';
  test('remaps a key whose path part is the renamed path, bounded by the part separators', () => {
    expect(remapKey(`code.file:${moved}`, moved, 'services/orders/internal/domain/order.go')).toBe('code.file:services/orders/internal/domain/order.go');
    expect(remapKey(`code.symbol:${moved}#Order`, moved, 'a.go')).toBe('code.symbol:a.go#Order');
  });
  test('leaves a key whose path only contains the renamed path inside another path', () => {
    expect(remapKey('code.file:vendor/services/orders/src/order.go', moved, 'a.go')).toBeNull();
    expect(remapKey('code.file:services/orders/src/order.go.txt', moved, 'a.go')).toBeNull();
    expect(remapKey('code.file:services/orders/srcx/order.go', moved, 'a.go')).toBeNull();
  });
  test('remaps a directory rename through every key under it, and nothing else', () => {
    expect(remapKey('code.file:services/orders/src/pricing.go', 'services/orders/src', 'services/orders/internal')).toBe('code.file:services/orders/internal/pricing.go');
    expect(remapKey('code.file:services/orders/internal/store/store.go', 'services/orders/src', 'services/orders/internal')).toBeNull();
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
async function nodesOfKind(env: DriverEnv, kind: string, at: string): Promise<{ id: string; label: string; path: string | null; sha256: string | null; validFrom: string; validTo: string; properties: Record<string, unknown> }[]> {
  const rows = await env.query<{ id: string; label: string; path: string | null; digest: string | null; valid_from: string; valid_to: string; properties: Record<string, unknown> }>(
    `SELECT v.node_id::text AS id, v.label, v.properties->>'path' AS path, v.properties->>'sha256' AS digest,
            to_char(v.valid_from AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS valid_from,
            to_char(v.valid_to AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS valid_to, v.properties
     FROM node_version v JOIN node_kind k ON k.id = v.kind_id
     WHERE k.key = $1 AND v.recorded_to = 'infinity'
       AND v.valid_from <= $2::timestamptz AND v.valid_to > $2::timestamptz
     ORDER BY v.node_id, v.valid_from`,
    [kind, at],
  );
  return rows.map((r) => ({ id: r.id, label: r.label, path: r.path, sha256: r.digest, validFrom: r.valid_from, validTo: r.valid_to, properties: r.properties }));
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
      const options: FillOptions = { owner, store, repository, extractors: [extractOperations, extractFiles], history: extractHistory };
      const started = Date.now();
      const report = await fillGraph(options);
      env = {
        owner, store, repository, report,
        query: async <Row extends object>(sql: string, values?: readonly unknown[]) => (await owner.run((tx) => tx.query<Row>(sql, values))).rows,
      };
      void started;
    }, 600_000);

    test('idempotent-refill (0028): a second fill of the unchanged repository writes no row in any table', async () => {
      const before = await digestAll(env);
      const second = await fillGraph({ owner: env.owner, store: env.store, repository: env.repository, extractors: [extractOperations, extractFiles], history: extractHistory });
      expect(second.repositoryNode).toBe(env.report.repositoryNode);
      const after = await digestAll(env);
      expect(after.counts).toEqual(before.counts);
      expect(after.digest).toBe(before.digest);
    }, 300_000);

    test('rename-keeps-identity (rename.identity): services/orders/src/order.go and services/orders/internal/domain/order.go are one node', async () => {
      // The key: "moved, content kept, one identity, history continues after the move"; the move commit is "Move the order aggregate under internal/domain".
      const move = firstParent.find((c) => c.subject.includes('Move the order aggregate under internal/domain'))!;
      const after = firstParent[firstParent.indexOf(move) + 1]!.hash;
      const dayAt = (iso: string, offset = 'T12:00:00Z'): string => `${iso.slice(0, 10)}${offset}`;
      const before = dayAt(committerOf(move.parent)); // noon of the day before the move's own time
      // Before the move only the old path exists; after it only the new one; and both are the same node id.
      const filesAt = async (when: string, filePath: string) => (await nodesOfKind(env, 'code.file', when)).filter((n) => n.properties['recordKey'] === `code.file:${filePath}`);
      const oldBefore = await filesAt(before, 'services/orders/src/order.go');
      const newBefore = await filesAt(before, 'services/orders/internal/domain/order.go');
      expect(oldBefore).toHaveLength(1);
      expect(newBefore).toHaveLength(0);
      const movedAt = dayAt(move.committer, 'T23:59:59Z'); // after the move's own time, before any later commit touches the file
      const newAfter = await filesAt(movedAt, 'services/orders/internal/domain/order.go');
      const oldAfter = await filesAt(movedAt, 'services/orders/src/order.go');
      const laterStill = await filesAt(dayAt(committerOf(after)), 'services/orders/internal/domain/order.go');
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
         WHERE k.key = 'code.dockerfile' AND v.properties->>'recordKey' = 'code.dockerfile:services/orders/Dockerfile' AND v.producer = 'code.extract.operations' AND v.recorded_to = 'infinity'
         ORDER BY v.valid_from`,
      );
      expect(rows.map((r) => r.valid_from)).toContain(expected);
      // A read at the parent's instant sees the state before the anomaly; at the anomaly's instant it sees the anomaly's.
      const dockerfile = async (when: string) => (await nodesOfKind(env, 'code.dockerfile', when)).find((n) => n.properties['recordKey'] === 'code.dockerfile:services/orders/Dockerfile');
      const before = await dockerfile(parentEffective);
      const at = await dockerfile(expected);
      expect(before!.validFrom < expected).toBe(true);
      expect(at!.validFrom).toBe(expected);
      // The commit node keeps the raw committer time and carries the effective time (the key's date-anomaly item).
      const commit = (await env.query<{ label: string; raw: unknown; effective: unknown; valid_from: string }>(
        `SELECT v.label, v.properties->>'rawCommitterTime' AS raw, v.properties->>'effectiveTime' AS effective,
                to_char(v.valid_from AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS valid_from
         FROM node_version v JOIN node_kind k ON k.id = v.kind_id
         WHERE k.key = 'code.commit' AND v.properties->>'sha' = $1 AND v.recorded_to = 'infinity'`,
        [anomaly.hash],
      ))[0]!;
      expect(commit.label).toBe(anomaly.subject);
      expect(commit.raw).toBe(canonical(anomaly.committer)); // the raw time as the store writes instants
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
        const present = new Set((await nodesOfKind(env, 'code.file', at)).map((n) => String(n.properties['recordKey'] ?? '').slice('code.file:'.length)));
        for (const check of checks.filter((c) => c.snapshot === name)) {
          if (check.absent === true) {
            expect(present.has(check.path), `${name}: ${check.item} expects ${check.path} absent`).toBe(false);
          } else {
            expect(present.has(check.path), `${name}: ${check.item} expects ${check.path} present`).toBe(true);
            if (check.contains !== undefined) expect(blobAt(env.repository, commit, check.path)).toContain(check.contains);
            if (check.notContains !== undefined) expect(blobAt(env.repository, commit, check.path)).not.toContain(check.notContains);
            if (check.differsFromFinal === true && name !== 'snapshot-final') {
              const filesNode = async (when: string) => (await nodesOfKind(env, 'code.file', when)).find((n) => n.properties['recordKey'] === `code.file:${check.path}`);
              const now = await filesNode(effectiveOf(finalCommit));
              const then = await filesNode(at);
              expect(then!.sha256, `${name}: ${check.item} expects ${check.path} to differ from final`).not.toBe(now!.sha256);
            }
          }
        }
      }
    }, 120_000);

    test('measure: fill time per commit and in total, and the store\'s size per table', async () => {
      const perCommit = env.report.commits.map((c) => `${c.generation}:${c.durationMs}ms`).join(' ');
      console.log(`[measure] total ${env.report.totalMs} ms over ${env.report.commits.length} commits; per commit ${perCommit}`);
      expect(env.report.totalMs).toBeGreaterThan(0);
      expect(env.report.commits.length).toBe(firstParent.length);
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
  });
}
