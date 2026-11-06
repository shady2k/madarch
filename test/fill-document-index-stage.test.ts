/**
 * The document index stage (madarch-tzte.21.4, decision 0026's stage 6; decision 0033's
 * static stage, madarch-8bdc.2.3) through its own `plan`, `execute` and `validate` with a
 * fake context: the orchestrator is not needed and not used.
 *
 * Every expectation comes from the task, the decisions and the schema, never from the
 * module: the stage publishes a `code.document` node per Markdown document (its media
 * type, its title, the bytes it spans and the blob its bytes stand under), a
 * `code.document-section` node per heading (the anchor a reader's link names, the
 * heading, its depth and its lines), one `code.document-link` edge per link — to another
 * document's node, to a code path's node, or to a `code.link-target` node holding an
 * address or a path the commit does not hold, every one with its place — one `code.task`
 * node and one `code.tasks` edge per task key a document names, and a `code.coverage`
 * naming what the read could not read. A document whose blob did not move is no unit of a
 * later run, and a document the pinned commit no longer holds is a unit that writes
 * nothing.
 *
 * The graph is the test's own: the reads a plan makes are answered from the rows a test
 * names, and no test touches a real database. Every repository is one the test makes in a
 * temporary folder and removes.
 */
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deriveStageGraph } from '../src/fill/registry.js';
import { createGitSnapshotSource, type SnapshotSource } from '../src/fill/snapshot.js';
import { DEFAULT_STAGE_LIMITS, type StageContext, type StageDraftWrite, type StageUnit } from '../src/fill/stage.js';
import {
  anchorOf, createDocumentIndexStage, documentScope, documentUnitId, markdownMediaType, publishedDocumentsRead,
} from '../src/fill/stages/document-index.js';
import { createStageRegistry } from '../src/fill/stages/index.js';
import { staticStageContext, staticStageSourceOf } from '../src/fill/stages/static-context.js';
import { publishedTreeRead } from '../src/fill/stages/tree-rows.js';

/** A throwaway repository the test commits into by hand. */
interface Fixture {
  readonly root: string;
  commit(): string;
  git(...args: string[]): string;
  write(path: string, text: string): Promise<void>;
  remove(path: string): Promise<void>;
  dispose(): Promise<void>;
}

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'madarch-documents-'));
  const git = (...args: string[]): string => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  const write = async (path: string, text: string): Promise<void> => {
    const at = join(root, path);
    await mkdir(join(at, '..'), { recursive: true });
    await writeFile(at, text);
  };
  return {
    root,
    git,
    write,
    commit(): string {
      git('add', '-A');
      git('commit', '-qm', 'fixture');
      return git('rev-parse', 'HEAD').trim();
    },
    remove: (path: string) => rm(join(root, path), { force: true }),
    dispose: () => rm(root, { recursive: true, force: true }),
  };
}

/** What a stage recorded while it ran. */
interface Recorder {
  readonly writes: StageDraftWrite[];
  readonly notes: string[];
  readonly queries: string[];
}

/** One unit's context: the reads answered by the test, the draft collected here, and a signal the test holds. */
async function contextFor(unit: StageUnit, source: SnapshotSource, answer: (read: string) => readonly unknown[] = () => []): Promise<{ context: StageContext; recorder: Recorder; controller: AbortController }> {
  const recorder: Recorder = { writes: [], notes: [], queries: [] };
  const controller = new AbortController();
  const pinned = await staticStageSourceOf(source, unit.id.split(':')[1] ?? '');
  return {
    recorder,
    controller,
    context: {
      unit,
      config: { id: 'document-index', version: 3, enabled: true, concurrency: 1, limits: DEFAULT_STAGE_LIMITS, config: { taskField: 'Ticket' } },
      graph: { query: async (read: string) => { recorder.queries.push(read); return answer(read); } },
      static: staticStageContext(pinned, {
        byKey: async () => [],
        byGlobalName: async () => [],
        neighbourhood: async () => ({ rows: [], next: null }),
        byProperty: async () => ({ rows: [], next: null }),
        edgesByProperty: async () => ({ rows: [], next: null }),
      }),
      draft: { write: (entry: StageDraftWrite) => { recorder.writes.push(entry); }, writes: () => ({ writes: recorder.writes }) },
      progress: (note: string) => { recorder.notes.push(note); },
      signal: controller.signal,
    },
  };
}

/** One item of a draft, as a test reads it: the fill's kind, the key (or the edge's joins), and the properties. */
interface DraftItem {
  readonly kind: string;
  readonly id: string;
  readonly key: string;
  readonly value: Record<string, unknown>;
  readonly provenance: { readonly place?: { readonly file: string; readonly range: { readonly startLine: number; readonly endLine: number } } };
}

/** The draft's items, in the order they were written: nodes by key, edges by their joins. */
function itemsOf(writes: readonly StageDraftWrite[]): readonly DraftItem[] {
  const items: DraftItem[] = [];
  const end = (one: { readonly key: string } | { readonly id: string }): string => ('key' in one ? one.key : one.id);
  for (const write of writes) {
    if (write.kind === 'node') {
      const properties = write.value.properties as Record<string, unknown>;
      items.push({ kind: String(properties['factKind']), id: write.value.key, key: write.value.key, value: properties, provenance: properties['provenance'] as DraftItem['provenance'] });
      continue;
    }
    if (write.kind !== 'edge') continue;
    const properties = (write.value.properties ?? {}) as Record<string, unknown>;
    items.push({
      kind: String(properties['factKind']),
      id: `${write.value.relation}:${end(write.value.from)}->${end(write.value.to)}`,
      key: end(write.value.to),
      value: { ...properties, from: end(write.value.from), to: end(write.value.to), relation: write.value.relation },
      provenance: properties['provenance'] as DraftItem['provenance'],
    });
  }
  return items;
}

/** The items of one kind. */
function itemsOfKind(writes: readonly StageDraftWrite[], kind: string): readonly DraftItem[] {
  return itemsOf(writes).filter((item) => item.kind === kind);
}

/** The edges of one relation: a link or a task key is one, its target's node is not. */
function edgesOf(writes: readonly StageDraftWrite[], relation: string): readonly DraftItem[] {
  return itemsOf(writes).filter((item) => item.value['relation'] === relation);
}

/** The nodes of one graph kind. */
function nodesOfKind(writes: readonly StageDraftWrite[], kind: string): readonly Extract<StageDraftWrite, { kind: 'node' }>['value'][] {
  return writes.filter((write) => write.kind === 'node' && write.value.kind === kind).map((write) => (write as Extract<StageDraftWrite, { kind: 'node' }>).value);
}

/** The one coverage item a draft holds, as a reader of the graph sees it. */
function coverageOfDraft(writes: readonly StageDraftWrite[]): { readonly scope: string; readonly complete: boolean; readonly read: readonly string[]; readonly unread: readonly { readonly what: string }[] } {
  const held = itemsOfKind(writes, 'coverage');
  if (held.length !== 1) throw new Error(`the draft holds ${String(held.length)} coverage items, and this test reads one`);
  const value = held[0]!.value;
  return { scope: String(value['scope']), complete: value['complete'] === true, read: (value['read'] ?? []) as readonly string[], unread: (value['unread'] ?? []) as readonly { what: string }[] };
}

/** One pinned repository's source. */
function sourceOf(f: Fixture, commit: string): SnapshotSource {
  return createGitSnapshotSource([{ id: 'orders-api', form: 'code', root: f.root, commit }]);
}

/** A document unit as this stage plans it. */
function unitOf(repository: string, path: string): StageUnit {
  return { id: documentUnitId(repository, path), scope: documentScope(repository, path) };
}

/** The tree rows a plan reads: the files the snapshot published, each at its blob. */
function treeRows(files: readonly [string, string][]): readonly { readonly kind: 'file'; readonly repository: string; readonly path: string; readonly blob: string }[] {
  return files.map(([path, blob]) => ({ kind: 'file' as const, repository: 'orders-api', path, blob }));
}

/** The stage, one unit and what it wrote. */
async function runUnit(source: SnapshotSource, unit: StageUnit, answer: (read: string) => readonly unknown[] = () => []): Promise<{ readonly writes: readonly StageDraftWrite[]; readonly notes: readonly string[] }> {
  const stage = createDocumentIndexStage(source);
  const { context, recorder } = await contextFor(unit, source, answer);
  expect(await stage.execute(unit, context)).toEqual({ outcome: 'draft' });
  expect(await stage.validate({ writes: recorder.writes }, { query: async () => [] })).toEqual({ ok: true });
  return { writes: recorder.writes, notes: recorder.notes };
}

/** One plan over the test's rows: the tree the snapshot published and this stage's own coverage. */
async function runPlan(source: SnapshotSource, files: readonly [string, string][], published: readonly { readonly kind: 'document'; readonly repository: string; readonly path: string; readonly blob?: string }[] = []): Promise<{ readonly plan: { readonly units: readonly { readonly id: string }[]; readonly coverage?: string }; readonly queries: readonly string[] }> {
  const stage = createDocumentIndexStage(source);
  const queries: string[] = [];
  const plan = await stage.plan({
    query: async (read: string) => {
      queries.push(read);
      if (read === publishedTreeRead('orders-api')) return treeRows(files);
      return published;
    },
  });
  return { plan: plan as { units: readonly { id: string }[]; coverage?: string }, queries };
}

/** What a call refused with, so a test can read what it names; `answered` when it did not refuse. */
async function refusedBy(call: () => unknown): Promise<string> {
  try {
    await call();
    return 'answered';
  } catch (error) {
    return (error as Error).message;
  }
}

/** The blob a fixture's file stands under at one commit. */
function blobOf(f: Fixture, commit: string, path: string): string {
  return f.git('rev-parse', `${commit}:${path}`).trim();
}

describe('the stage of the registry', () => {
  test('it is a static stage and the graph runs it after the snapshot', () => {
    const stage = createDocumentIndexStage(createGitSnapshotSource(() => []));
    expect(stage.staticReading).toBe(true);
    const read = deriveStageGraph(createStageRegistry({ snapshots: createGitSnapshotSource(() => []) }), undefined);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.graph.edges.filter((edge) => edge.to === 'document-index').map((edge) => [edge.from, edge.via]).sort()).toEqual([
      ['snapshot', 'file'],
      ['snapshot', 'snapshot'],
    ].sort());
  });

  test('the names a document is: Markdown extensions, and `.md` alone is a hidden file', () => {
    expect(['a.md', 'docs/a.markdown', 'x.mdx', 'README', '.md'].map((path) => markdownMediaType(path))).toEqual(['text/markdown', 'text/markdown', 'text/mdx', undefined, undefined]);
    expect(anchorOf('Requirement: The Graph — and its edges')).toBe('requirement-the-graph-and-its-edges');
  });
});

describe('one document', () => {
  test('its node, its sections and their anchors, its links, its task keys and its coverage', async () => {
    const f = await fixture();
    try {
      await f.write('docs/a.md', '---\nTicket:\n  - madarch-tzte.21.4\n---\n# A\n\n## B\n\nSee [C](c.md) and [out](https://example.test/x) and [gone](missing.md).\n');
      await f.write('docs/c.md', '# C\n');
      const commit = f.commit();
      const source = sourceOf(f, commit);
      const { writes } = await runUnit(source, unitOf('orders-api', 'docs/a.md'));

      const documents = nodesOfKind(writes, 'code.document');
      expect(documents).toHaveLength(1);
      expect(documents[0]!.properties).toMatchObject({ repository: 'orders-api', path: 'docs/a.md', mediaType: 'text/markdown', title: 'A', blob: blobOf(f, commit, 'docs/a.md') });
      const sections = nodesOfKind(writes, 'code.document-section');
      expect(sections.map((node) => [node.properties['heading'], node.properties['anchor'], node.properties['level']])).toEqual([['A', 'a', 1], ['B', 'b', 2]]);

      const links = edgesOf(writes, 'code.document-link');
      expect(links).toHaveLength(3);
      // A link to a document of the commit names the node that document's own unit writes.
      const toC = links.find((link) => link.value['target'] === 'c.md')!;
      expect(toC.key.startsWith('document:')).toBe(true);
      // An address and a path the commit does not hold keep their text in a node of their own.
      const outside = links.find((link) => link.value['target'] === 'https://example.test/x')!;
      const gone = links.find((link) => link.value['target'] === 'missing.md')!;
      expect(outside.key).toBe(gone.key === outside.key ? '' : outside.key);
      expect(outside.key.startsWith('link-target:')).toBe(true);
      expect(gone.key.startsWith('link-target:')).toBe(true);
      for (const link of links) {
        expect(String(link.value['from']).startsWith('document:') || String(link.value['from']).startsWith('section:')).toBe(true);
        expect(link.value['line']).toBeGreaterThan(0);
      }
      expect(nodesOfKind(writes, 'code.link-target').map((node) => String(node.label)).sort()).toEqual(['https://example.test/x', 'missing.md']);

      const keys = edgesOf(writes, 'code.tasks');
      expect(keys.map((key) => key.value['key'])).toEqual(['madarch-tzte.21.4']);
      expect(nodesOfKind(writes, 'code.task').map((node) => String(node.label))).toEqual(['madarch-tzte.21.4']);

      const coverage = coverageOfDraft(writes);
      expect(coverage.complete).toBe(true);
      expect(coverage.scope).toBe('orders-api:docs/a.md');
    } finally {
      await f.dispose();
    }
  }, 60_000);

  test('a fragment names a section of its own document, and a folder or an absolute target is a link-target', async () => {
    const f = await fixture();
    try {
      await f.write('docs/a.md', '# A\n\n## B\n\nSee [b](#b) and [dir](sub/) and [abs](/etc/passwd).\n');
      const commit = f.commit();
      const { writes } = await runUnit(sourceOf(f, commit), unitOf('orders-api', 'docs/a.md'));
      const links = edgesOf(writes, 'code.document-link');
      const fragment = links.find((link) => link.value['target'] === '#b')!;
      expect(fragment.key.startsWith('section:')).toBe(true);
      expect(nodesOfKind(writes, 'code.link-target')).toHaveLength(2);
    } finally {
      await f.dispose();
    }
  }, 60_000);

  test('the same end twice in one section is one edge, and in two sections two', async () => {
    const f = await fixture();
    try {
      await f.write('docs/c.md', '# C\n');
      await f.write('docs/a.md', '# A\n\n[C](c.md) and [C again](c.md)\n\n## B\n\n[C](c.md)\n');
      const commit = f.commit();
      const { writes } = await runUnit(sourceOf(f, commit), unitOf('orders-api', 'docs/a.md'));
      const links = edgesOf(writes, 'code.document-link');
      expect(links).toHaveLength(2);
      // The first two links stand under the document's only heading, so both begin at a
      // section: one edge for the pair in it, and one for the pair under the second heading.
      expect(links.map((link) => String(link.value['from']).split(':')[0]).sort()).toEqual(['section', 'section']);
    } finally {
      await f.dispose();
    }
  }, 60_000);

  test('a heading whose words name no anchor is a coverage gap, and a document with no Markdown bytes writes nothing', async () => {
    const f = await fixture();
    try {
      await f.write('docs/a.md', '# A\n\n## ...\n');
      await f.write('docs/notes.txt', 'no markdown\n');
      const commit = f.commit();
      const read = await runUnit(sourceOf(f, commit), unitOf('orders-api', 'docs/a.md'));
      expect(coverageOfDraft(read.writes).unread.map((gap) => gap.what)).toEqual(['docs/a.md:3']);
      const none = await runUnit(sourceOf(f, commit), unitOf('orders-api', 'docs/notes.txt'));
      expect(none.writes).toEqual([]);
    } finally {
      await f.dispose();
    }
  }, 60_000);
});

describe('the plan', () => {
  test('one unit per Markdown document of the tree, in code point order, and none for another file', async () => {
    const f = await fixture();
    try {
      await f.write('docs/a.md', '# A\n');
      await f.write('README', 'no extension\n');
      const commit = f.commit();
      const { plan } = await runPlan(sourceOf(f, commit), [['README', 'a'.repeat(40)], ['docs/a.md', 'b'.repeat(40)]]);
      expect(plan.units.map((unit) => unit.id)).toEqual([documentUnitId('orders-api', 'docs/a.md')]);
    } finally {
      await f.dispose();
    }
  }, 60_000);

  test('a document whose blob did not move is no unit, and one that moved or vanished is', async () => {
    const f = await fixture();
    try {
      await f.write('docs/a.md', '# A\n');
      const first = f.commit();
      const published = [{ kind: 'document' as const, repository: 'orders-api', path: 'docs/a.md', blob: 'a'.repeat(40) }];
      const same = await runPlan(sourceOf(f, first), [['docs/a.md', 'a'.repeat(40)]], published);
      expect(same.plan.units).toEqual([]);
      const moved = await runPlan(sourceOf(f, first), [['docs/a.md', 'b'.repeat(40)]], published);
      expect(moved.plan.units.map((unit) => unit.id)).toEqual([documentUnitId('orders-api', 'docs/a.md')]);
      const gone = await runPlan(sourceOf(f, first), [], published);
      expect(gone.plan.units.map((unit) => unit.id)).toEqual([documentUnitId('orders-api', 'docs/a.md')]);
      const { writes } = await runUnit(sourceOf(f, first), unitOf('orders-api', 'docs/a.md'), () => []);
      expect(writes.length).toBeGreaterThan(0);
    } finally {
      await f.dispose();
    }
  }, 60_000);

  test('a unit this stage never plans and a cancelled unit are refused by name', async () => {
    const f = await fixture();
    try {
      await f.write('docs/a.md', '# A\n');
      const commit = f.commit();
      const stage = createDocumentIndexStage(sourceOf(f, commit));
      for (const scope of ['docs/a.md', 'orders-api:', 'orders-api:/abs/a.md', ':docs/a.md']) {
        const { context } = await contextFor({ id: 'document:orders-api:docs/a.md', scope }, sourceOf(f, commit));
        expect(await refusedBy(() => stage.execute({ id: 'x', scope }, context))).toContain('document-index');
      }
      const { context, controller } = await contextFor(unitOf('orders-api', 'docs/a.md'), sourceOf(f, commit));
      controller.abort();
      expect(await refusedBy(() => stage.execute(unitOf('orders-api', 'docs/a.md'), context))).toContain('cancelled');
    } finally {
      await f.dispose();
    }
  }, 60_000);
});

describe('what a reader of the document sees', () => {
  test('a key written in running prose is no key, and only the declared front-matter field is read', async () => {
    const f = await fixture();
    try {
      await f.write('docs/a.md', '---\nTicket:\n  - declared-1\nOther:\n  - not-declared-2\n---\n# A\n\n`[C](c.md)`\n\n```\n[C](c.md)\nTicket: prose-1\n```\n\nTicket: prose-2\n');
      const commit = f.commit();
      const { writes } = await runUnit(sourceOf(f, commit), unitOf('orders-api', 'docs/a.md'));
      expect(edgesOf(writes, 'code.document-link')).toEqual([]);
      expect(edgesOf(writes, 'code.tasks').map((key) => key.value['key'])).toEqual(['declared-1']);
    } finally {
      await f.dispose();
    }
  }, 60_000);
});
