/**
 * The document index stage (madarch-tzte.21.4, decision 0026's stage 6) through
 * its own `plan`, `execute` and `validate` with a fake context: the orchestrator
 * (madarch-tzte.19.5) is not needed and not used.
 *
 * Every expectation comes from the task, the decisions and the schema, never
 * from the module: the stage writes a `document` node per Markdown document of
 * the pinned repositories (its media type, its title, the bytes it spans and the
 * blob its bytes stand under), a `section` node per heading (the anchor a
 * reader's link names, the heading, its depth, the lines and the bytes it
 * covers), a `document-link` edge per link a document holds — the other
 * document's node, a code path's node, an address outside the repositories, or
 * the target as written where the pinned commit does not hold it, every one of
 * them with its place — a `task-key` edge per task key a document names, and a
 * `coverage` fact saying what the read could not read. A document whose blob did
 * not move is no unit of a later run, and a document the pinned commit no longer
 * holds is a unit that writes nothing.
 *
 * The graph is the test's own: the reads a plan makes are answered from the
 * facts an earlier run's draft set held, which is what a fact store would
 * answer, and no test touches a real database. Every repository is one the test
 * makes in a temporary folder and removes.
 */
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { factId, makeEdgeFact, type FactValueOf, repositoryPath } from '../src/fill/facts.js';
import { deriveStageGraph } from '../src/fill/registry.js';
import { createGitSnapshotSource, type SnapshotSource } from '../src/fill/snapshot.js';
import { DEFAULT_STAGE_LIMITS, type StageContext, type StageDraftWrite, type StageUnit } from '../src/fill/stage.js';
import { createStageRegistry } from '../src/fill/stages/index.js';
import {
  anchorOf, createDocumentIndexStage, documentScope, documentUnitId, markdownMediaType, publishedDocuments,
  publishedDocumentsRead, type PublishedDocumentRow,
} from '../src/fill/stages/document-index.js';
import { wholeFileRange } from '../src/fill/stages/inventory.js';
import { resolveBodyLink } from '../src/product-wiki/documents.js';

// ---- the test's own repository, context and graph ---------------------------

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
function contextFor(unit: StageUnit, answer: (read: string) => readonly unknown[] = () => []): { context: StageContext; recorder: Recorder; controller: AbortController } {
  const recorder: Recorder = { writes: [], notes: [], queries: [] };
  const controller = new AbortController();
  return {
    recorder,
    controller,
    context: {
      unit,
      config: { id: 'document-index', version: 1, enabled: true, concurrency: 1, limits: DEFAULT_STAGE_LIMITS, config: {} },
      graph: {
        query: async (read: string) => {
          recorder.queries.push(read);
          return answer(read);
        },
      },
      draft: {
        write: (entry: StageDraftWrite) => { recorder.writes.push(entry); },
        writes: () => ({ writes: recorder.writes }),
      },
      progress: (note: string) => { recorder.notes.push(note); },
      signal: controller.signal,
    },
  };
}

/** One fact of a draft set, as the fact store would hold it. */
interface DraftFact {
  readonly kind: string;
  readonly id: string;
  readonly value: Record<string, unknown>;
  readonly provenance: {
    readonly repository: { readonly id: string; readonly commit: string };
    readonly place?: { readonly file: string; readonly range: { readonly startLine: number; readonly startColumn: number; readonly endLine: number; readonly endColumn: number } };
  };
}

/** The facts one draft set holds, in the order they were written; a write that is no fact is left out. */
function factsOf(writes: readonly StageDraftWrite[]): readonly DraftFact[] {
  const facts: DraftFact[] = [];
  for (const write of writes) {
    if (write.kind !== 'fact') continue;
    facts.push(write.value as DraftFact);
  }
  return facts;
}

/** The facts of one kind one draft set holds, in the order the unit wrote them. */
function factsOfKind(writes: readonly StageDraftWrite[], kind: string): readonly DraftFact[] {
  return factsOf(writes).filter((fact) => fact.kind === kind);
}

/** WHAT a fact store would answer for one repository's stage-6 documents: the row per document fact. */
function publishedRows(writes: readonly StageDraftWrite[], repository: string): readonly PublishedDocumentRow[] {
  const rows: PublishedDocumentRow[] = [];
  for (const fact of factsOf(writes)) {
    if (fact.kind !== 'document') continue;
    const blob = fact.value['blob'];
    rows.push({ kind: 'document', repository, path: String(fact.value['path']), ...(typeof blob === 'string' ? { blob } : {}) });
  }
  return rows;
}

/**
 * The stage's own source over one repository the test made, pinned at a commit:
 * a real git tree read through the snapshot reader, which is what a run's wiring
 * hands a stage.
 */
function sourceOf(fixture: Fixture, commit: string, id = 'orders-api'): SnapshotSource {
  return createGitSnapshotSource([{ id, form: 'code', root: fixture.root, commit }]);
}

/** A document unit as this stage plans it. */
function unitOf(repository: string, path: string): StageUnit {
  return { id: documentUnitId(repository, path), scope: documentScope(repository, path) };
}

/** The id a node fact of the schema carries for one repository and path: its identity digests those two alone. */
function nodeIdOf(kind: 'document' | 'file', repository: string, path: string, extra: Record<string, unknown> = {}): string {
  const provenance = { source: { system: 'git', version: '2.43.0' }, repository: { id: repository, commit: '0'.repeat(40) } };
  if (kind === 'document') return factId({ kind, value: { repository, path: repositoryPath(path), mediaType: markdownMediaType(path) ?? 'text/markdown', ...extra } as FactValueOf<'document'>, provenance });
  return factId({ kind, value: { repository, path: repositoryPath(path), roles: [], ...extra } as FactValueOf<'file'>, provenance });
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

/** The graph a judge reads: an empty one, since a draft's validate reads nothing here. */
const EMPTY_GRAPH = { query: async (): Promise<readonly unknown[]> => [] };

/** The units one plan named, by id. */
function unitIds(plan: { units: readonly { id: string }[] }): string[] {
  return plan.units.map((unit) => unit.id);
}

/** One unit run: the stage, the unit's draft and what it recorded. */
async function runUnit(source: SnapshotSource, unit: StageUnit, answer: (read: string) => readonly unknown[] = () => []): Promise<{ recorder: Recorder; outcome: string }> {
  const stage = createDocumentIndexStage(source);
  const { context, recorder } = contextFor(unit, answer);
  const result = await stage.execute(unit, context);
  return { recorder, outcome: result.outcome };
}

/** One plan run against a graph that answers what the test says an earlier run published. */
async function runPlan(source: SnapshotSource, published: readonly PublishedDocumentRow[] = []): Promise<{ plan: { units: readonly { id: string; scope: string }[]; coverage?: string }; queries: string[] }> {
  const stage = createDocumentIndexStage(source);
  const recorder: string[] = [];
  const plan = await stage.plan({
    query: async (read: string) => {
      recorder.push(read);
      const asked = JSON.parse(read) as { read: string; repository: string };
      return published.filter((row) => row.repository === asked.repository);
    },
  });
  return { plan: plan as { units: readonly { id: string; scope: string }[]; coverage?: string }, queries: recorder };
}

// ---- the registry ----------------------------------------------------------

describe('the document index stage is registered', () => {
  test('the derived graph runs the snapshot and the inventory before the document index', async () => {
    const f = await fixture();
    try {
      await f.write('docs/a.md', '# A\n');
      const commit = f.commit();
      const registry = createStageRegistry({ snapshots: sourceOf(f, commit) });
      const derived = deriveStageGraph(registry);
      if (!derived.ok) throw new Error(`the graph did not derive: ${JSON.stringify(derived)}`);
      const order = [...derived.graph.order];
      expect(order).toContain('document-index');
      expect(order.indexOf('snapshot')).toBeLessThan(order.indexOf('document-index'));
      // A link to a code path names the node stage 1 publishes, so the
      // inventory runs first; the snapshot is what pins the commit.
      expect(order.indexOf('inventory')).toBeLessThan(order.indexOf('document-index'));
      expect(derived.graph.edges.some((edge) => edge.from === 'inventory' && edge.to === 'document-index' && edge.via === 'file')).toBe(true);
      const stage = registry.get('document-index');
      expect(stage?.produces.map((produced) => produced.kind)).toEqual(['coverage', 'document', 'document-link', 'section', 'task-key']);
    } finally {
      await f.dispose();
    }
  });

  test('the plan names the read a wiring answers from the graph', () => {
    // The read is this stage's contract with madarch-tzte.21.8: the wiring
    // answers it from the graph's `document` facts.
    expect(JSON.parse(publishedDocumentsRead('orders-api'))).toEqual({ read: 'stage-6-published-documents', repository: 'orders-api' });
  });
});

// ---- what one document writes ---------------------------------------------

describe('one document, through its own plan and execute', () => {
  test('two documents linking each other yield two documents, their sections and two resolved links', async () => {
    const f = await fixture();
    try {
      await f.write('docs/a.md', '# A\n\nSee [B](b.md).\n');
      await f.write('docs/b.md', '# B\n\nSee [A](a.md).\n');
      const commit = f.commit();
      const source = sourceOf(f, commit);
      const first = await runUnit(source, unitOf('orders-api', 'docs/a.md'));
      const second = await runUnit(source, unitOf('orders-api', 'docs/b.md'));

      const documents = [...factsOfKind(first.recorder.writes, 'document'), ...factsOfKind(second.recorder.writes, 'document')];
      expect(documents.map((fact) => fact.value['path'])).toEqual(['docs/a.md', 'docs/b.md']);
      const written: Readonly<Record<string, string>> = { 'docs/a.md': '# A\n\nSee [B](b.md).\n', 'docs/b.md': '# B\n\nSee [A](a.md).\n' };
      for (const document of documents) {
        expect(document.value['mediaType']).toBe('text/markdown');
        expect(document.value['bytes']).toBe(Buffer.byteLength(written[String(document.value['path'])] as string));
        expect(document.provenance.repository.commit).toBe(commit);
        expect(String(document.value['blob'])).toMatch(/^[0-9a-f]{40}$/);
        expect(document.provenance.place?.file).toBe(String(document.value['path']));
      }
      expect(documents[0]?.value['title']).toBe('A');
      expect(documents[1]?.value['title']).toBe('B');

      const sections = [...factsOfKind(first.recorder.writes, 'section'), ...factsOfKind(second.recorder.writes, 'section')];
      expect(sections.map((fact) => [fact.value['document'], fact.value['anchor'], fact.value['heading'], fact.value['level']]))
        .toEqual([['docs/a.md', 'a', 'A', 1], ['docs/b.md', 'b', 'B', 1]]);

      const links = [...factsOfKind(first.recorder.writes, 'document-link'), ...factsOfKind(second.recorder.writes, 'document-link')];
      expect(links.map((fact) => fact.value['to'])).toEqual([
        { form: 'node', id: nodeIdOf('document', 'orders-api', 'docs/b.md') },
        { form: 'node', id: nodeIdOf('document', 'orders-api', 'docs/a.md') },
      ]);
      // The link stands in the section that holds its line (`# A` opens the
      // whole document but its last line), and its place is where it is written:
      // "See [B](b.md)." covers columns 4 to 13 of line 3.
      expect(links[0]?.provenance.place).toEqual({ file: 'docs/a.md', range: { startLine: 3, startColumn: 4, endLine: 3, endColumn: 13 } });
      expect(links[0]?.value['from']).toBe(sections[0]?.id);
    } finally {
      await f.dispose();
    }
  });

  test('a document node spans its bytes and its lines, and a section node spans its own', async () => {
    const f = await fixture();
    try {
      await f.write('docs/a.md', '# A\n\nfirst line\nsecond line\n\n## B\n\nb body\n');
      const commit = f.commit();
      const { recorder } = await runUnit(sourceOf(f, commit), unitOf('orders-api', 'docs/a.md'));
      const [document] = factsOfKind(recorder.writes, 'document');
      const sections = factsOfKind(recorder.writes, 'section');
      const text = '# A\n\nfirst line\nsecond line\n\n## B\n\nb body\n';
      const bytes = Buffer.byteLength(text);
      expect(document?.value['bytes']).toBe(bytes);
      // The document's line span is the whole file's, as the inventory reads it.
      expect(document?.provenance.place?.range).toEqual(wholeFileRange(text));
      // The first section runs from its heading to the line before the next
      // heading, its trailing blank lines out.
      expect(sections[0]?.provenance.place?.range).toEqual({ startLine: 1, startColumn: 0, endLine: 4, endColumn: 11 });
      expect(sections[0]?.value['startByte']).toBe(0);
      expect(sections[0]?.value['endByte']).toBe(Buffer.byteLength('# A\n\nfirst line\nsecond line'));
      // The last section runs to the last line that holds text.
      expect(sections[1]?.provenance.place?.range).toEqual({ startLine: 6, startColumn: 0, endLine: 8, endColumn: 6 });
      expect(sections[1]?.value['startByte']).toBe(Buffer.byteLength('# A\n\nfirst line\nsecond line\n\n'));
      expect(sections[1]?.value['endByte']).toBe(bytes - 1);
    } finally {
      await f.dispose();
    }
  });

  test('a section carries the anchor a reader of the rendered page would follow', async () => {
    const f = await fixture();
    try {
      await f.write('docs/a.md', '## Requirement: strict YAML\n\ntext\n\n## Requirement: strict YAML\n\ntext\n\n### See [the guide](guide.md)\n');
      const commit = f.commit();
      const { recorder } = await runUnit(sourceOf(f, commit), unitOf('orders-api', 'docs/a.md'));
      // GitHub's own rendering of these headings: the anchor is the words, lower
      // cased, punctuation dropped, whitespace one "-"; a repeat takes "-1".
      expect(factsOfKind(recorder.writes, 'section').map((fact) => [fact.value['heading'], fact.value['anchor'], fact.value['level']])).toEqual([
        ['Requirement: strict YAML', 'requirement-strict-yaml', 2],
        ['Requirement: strict YAML', 'requirement-strict-yaml-1', 2],
        ['See the guide', 'see-the-guide', 3],
      ]);
    } finally {
      await f.dispose();
    }
  });

  test('a link to a code path names the node the inventory published for it', async () => {
    const f = await fixture();
    try {
      await f.write('docs/a.md', '# A\n\nSee [the entry point](../src/order.ts).\n');
      await f.write('src/order.ts', 'export const order = 1;\n');
      const commit = f.commit();
      const { recorder } = await runUnit(sourceOf(f, commit), unitOf('orders-api', 'docs/a.md'));
      const [link] = factsOfKind(recorder.writes, 'document-link');
      expect(link?.value['to']).toEqual({ form: 'node', id: nodeIdOf('file', 'orders-api', 'src/order.ts') });
    } finally {
      await f.dispose();
    }
  });

  test('a link the pinned commit does not hold is written unresolved with its place, never dropped', async () => {
    const f = await fixture();
    try {
      await f.write('docs/a.md', '# A\n\nSee [the plan](missing.md) and [the folder](plans).\n');
      await f.write('plans/one.md', '# One\n');
      const commit = f.commit();
      const { recorder } = await runUnit(sourceOf(f, commit), unitOf('orders-api', 'docs/a.md'));
      const links = factsOfKind(recorder.writes, 'document-link');
      // A path the commit does not hold at all, and a folder (which holds no file
      // a link may end at): both are the target as the document wrote it.
      expect(links.map((fact) => fact.value['to'])).toEqual([
        { form: 'literal', text: 'missing.md' },
        { form: 'literal', text: 'plans' },
      ]);
      // "See [the plan](missing.md) and ..." : the link covers columns 4 to 26.
      expect(links[0]?.provenance.place?.range).toEqual({ startLine: 3, startColumn: 4, endLine: 3, endColumn: 26 });
    } finally {
      await f.dispose();
    }
  });

  test('an address outside the repositories is an address, and a fragment names a section of its own document', async () => {
    const f = await fixture();
    try {
      await f.write('docs/a.md', '# A\n\n## B\n\nSee [out](https://example.test/x) and [in](#b) and [nowhere](#c) and [case](#B).\n');
      const commit = f.commit();
      const { recorder } = await runUnit(sourceOf(f, commit), unitOf('orders-api', 'docs/a.md'));
      const sections = factsOfKind(recorder.writes, 'section');
      expect(sections.map((fact) => fact.value['anchor'])).toEqual(['a', 'b']);
      const links = factsOfKind(recorder.writes, 'document-link');
      // An anchor is compared as written: `#B` names no section this document
      // writes as `b` (a browser's lookup of an `id` is exact), so it stays
      // unresolved with its place.
      expect(links.map((fact) => fact.value['to'])).toEqual([
        { form: 'external', url: 'https://example.test/x' },
        { form: 'node', id: sections[1]?.id },
        { form: 'literal', text: '#c' },
        { form: 'literal', text: '#B' },
      ]);
      // A link written under a section stands in that section.
      expect(links[0]?.value['from']).toBe(sections[1]?.id);
    } finally {
      await f.dispose();
    }
  });

  test('a document that names one end twice in one section holds one edge, at the first place it names it', async () => {
    const f = await fixture();
    try {
      await f.write('docs/a.md', '# A\n\nSee [one](b.md).\n\nSee [two](b.md).\n');
      await f.write('docs/b.md', '# B\n');
      const commit = f.commit();
      const { recorder } = await runUnit(sourceOf(f, commit), unitOf('orders-api', 'docs/a.md'));
      const links = factsOfKind(recorder.writes, 'document-link');
      expect(links.length).toBe(1);
      expect(links[0]?.provenance.place?.range.startLine).toBe(3);
    } finally {
      await f.dispose();
    }
  });

  test('a link whose line stands in another section is another edge: the identity is the section and the end', async () => {
    const f = await fixture();
    try {
      await f.write('docs/a.md', '# A\n\n## One\n\nSee [b](b.md).\n\n## Two\n\nSee [b](b.md).\n');
      await f.write('docs/b.md', '# B\n');
      const commit = f.commit();
      const { recorder } = await runUnit(sourceOf(f, commit), unitOf('orders-api', 'docs/a.md'));
      const sections = factsOfKind(recorder.writes, 'section');
      const links = factsOfKind(recorder.writes, 'document-link');
      // Two sections name one end: the schema's `document-link` identity is its
      // `from` and its `to`, so these are two facts, each at its own place.
      expect(sections.map((fact) => fact.value['anchor'])).toEqual(['a', 'one', 'two']);
      expect(links.length).toBe(2);
      expect(links.map((fact) => fact.value['from'])).toEqual([sections[1]?.id, sections[2]?.id]);
      expect(links.map((fact) => fact.provenance.place?.range.startLine)).toEqual([5, 9]);
    } finally {
      await f.dispose();
    }
  });

  test('a task key named under two sections is two edges, and the same key twice under one is one', async () => {
    const f = await fixture();
    try {
      await f.write('docs/a.md', '# A\n\n## One\n\nTask: madarch-a.1\n\nTask: madarch-a.1\n\n## Two\n\nTask: madarch-a.1\n');
      const commit = f.commit();
      const { recorder } = await runUnit(sourceOf(f, commit), unitOf('orders-api', 'docs/a.md'));
      const sections = factsOfKind(recorder.writes, 'section');
      const keys = factsOfKind(recorder.writes, 'task-key');
      expect(keys.map((fact) => [fact.value['key'], fact.value['from']])).toEqual([
        ['madarch-a.1', sections[1]?.id],
        ['madarch-a.1', sections[2]?.id],
      ]);
    } finally {
      await f.dispose();
    }
  });
});

// ---- the rule a task key is read by ---------------------------------------

describe('a task key named in a document', () => {
  test('the words a key stands beside are no keys: a date, a version, a bare word', async () => {
    const f = await fixture();
    try {
      // The shape of the lines the fill will meet in this product's own change
      // records: a marker in a sentence, and a key the sentence's own punctuation
      // wraps (a full stop after the key, brackets around it).
      await f.write('docs/a.md', [
        '# A',
        '',
        'Change: fill-pipeline-monday. Task: madarch-p45j.4. Run date: 2026-10-17, 15:14-15:19 UTC.',
        '',
        'End: commit (Task: madarch-tzte.21.4), push, and one line on 2026-10-18 at 15:50 MSK.',
        '',
      ].join('\n'));
      const commit = f.commit();
      const { recorder } = await runUnit(sourceOf(f, commit), unitOf('orders-api', 'docs/a.md'));
      const keys = factsOfKind(recorder.writes, 'task-key').map((fact) => fact.value['key']);
      // Both real keys, whichever punctuation of the sentence wraps them, and
      // none of the words beside them: a date and a time are no keys (a key
      // begins with a letter), and a word with no separator is none either.
      expect(keys).toEqual(['madarch-p45j.4', 'madarch-tzte.21.4']);
      // Each key stands at its own columns.
      const first = factsOfKind(recorder.writes, 'task-key').find((fact) => fact.value['key'] === 'madarch-p45j.4');
      expect(first?.provenance.place?.range).toEqual({ startLine: 3, startColumn: 36, endLine: 3, endColumn: 50 });
    } finally {
      await f.dispose();
    }
  });

  test('the key list after a marker ends at the first token that is no key, or at a bracket', async () => {
    const f = await fixture();
    try {
      await f.write('docs/a.md', [
        '# A',
        '',
        'Task: see registry.ts and madarch-later.1',
        '',
        'Task: madarch-tzte.21.4 (integrator-held; this record is the run\'s evidence)',
        '',
        'Tasks: madarch-a.1, madarch-b.2',
        '',
      ].join('\n'));
      const commit = f.commit();
      const { recorder } = await runUnit(sourceOf(f, commit), unitOf('orders-api', 'docs/a.md'));
      // A marker standing in a sentence names the keys at its head: the prose
      // after them is the sentence, and a file name further along the line is no
      // key. A list of keys is a run, and a bracket opens the sentence's aside.
      expect(factsOfKind(recorder.writes, 'task-key').map((fact) => fact.value['key'])).toEqual(['madarch-tzte.21.4', 'madarch-a.1', 'madarch-b.2']);
    } finally {
      await f.dispose();
    }
  });
});

// ---- headings, examples and the line reading ------------------------------

describe('what a reader of the document sees', () => {
  test('a heading is one at the margin, and an example opens no section', async () => {
    const f = await fixture();
    try {
      await f.write('docs/a.md', [
        '# A',
        '',
        '#tag is a word, not a heading',
        '',
        '    # indented four spaces: a code block',
        '',
        '```',
        '# inside a fence',
        '```',
        '',
        '<!--',
        '# inside a comment',
        '-->',
        '',
        '## B ##',
        '',
      ].join('\n'));
      const commit = f.commit();
      const { recorder } = await runUnit(sourceOf(f, commit), unitOf('orders-api', 'docs/a.md'));
      expect(factsOfKind(recorder.writes, 'section').map((fact) => [fact.value['anchor'], fact.value['heading'], fact.value['level'], fact.provenance.place?.range.startLine]))
        .toEqual([['a', 'A', 1, 1], ['b', 'B', 2, 15]]);
    } finally {
      await f.dispose();
    }
  });

  test('a link inside a code span or a fence is no link, and a task key inside one is no key', async () => {
    const f = await fixture();
    try {
      await f.write('docs/a.md', [
        '# A',
        '',
        'A span: `[not a link](missing.md)` and `Task: madarch-hidden`.',
        '',
        '```md',
        '[also not a link](missing.md)',
        'Task: madarch-hidden-too',
        '```',
        '',
        'Task: madarch-tzte.21.4',
        '',
      ].join('\n'));
      await f.write('docs/missing.md', '# Missing\n');
      const commit = f.commit();
      const { recorder } = await runUnit(sourceOf(f, commit), unitOf('orders-api', 'docs/a.md'));
      expect(factsOfKind(recorder.writes, 'document-link')).toEqual([]);
      expect(factsOfKind(recorder.writes, 'task-key').map((fact) => fact.value['key'])).toEqual(['madarch-tzte.21.4']);
    } finally {
      await f.dispose();
    }
  });

  test('the task keys a document names are the tracker ids after a Task: or Tasks: marker', async () => {
    const f = await fixture();
    try {
      await f.write('docs/a.md', [
        '# A',
        '',
        'This document lands madarch-tzte.21.4 (named in prose, which is no key).',
        '',
        'Task: madarch-tzte.21.4',
        '',
        'Tasks: madarch-1xq, madarch-24sy.3',
        '',
        'Task: madarch-tzte.21.4 (the same key again)',
        '',
      ].join('\n'));
      const commit = f.commit();
      const { recorder } = await runUnit(sourceOf(f, commit), unitOf('orders-api', 'docs/a.md'));
      const keys = factsOfKind(recorder.writes, 'task-key');
      // The keys in the order the document names them, each once however often
      // it is named.
      expect(keys.map((fact) => fact.value['key'])).toEqual(['madarch-tzte.21.4', 'madarch-1xq', 'madarch-24sy.3']);
      // A key is written where it stands, under the section that holds it: the
      // heading `# A` opens the only section, so its own node is the edge's end.
      expect(keys[0]?.provenance.place?.range).toEqual({ startLine: 5, startColumn: 6, endLine: 5, endColumn: 23 });
      expect(keys[0]?.value['from']).toBe(factsOfKind(recorder.writes, 'section')[0]?.id);
    } finally {
      await f.dispose();
    }
  });

  test('a heading whose words name no anchor opens no section, and the coverage names its place', async () => {
    const f = await fixture();
    try {
      await f.write('docs/a.md', '# A\n\n## ---\n\ntext\n\n## B\n');
      const commit = f.commit();
      const { recorder } = await runUnit(sourceOf(f, commit), unitOf('orders-api', 'docs/a.md'));
      expect(factsOfKind(recorder.writes, 'section').map((fact) => fact.value['anchor'])).toEqual(['a', 'b']);
      const [coverage] = factsOfKind(recorder.writes, 'coverage');
      expect(coverage?.value['complete']).toBe(false);
      expect(coverage?.value['unread']).toEqual([{ what: 'docs/a.md:3', reason: 'unsupported' }]);
      // And it is no silent loss: the note says so too.
      expect(recorder.notes.join('\n')).toContain('could not anchor 1 heading');
    } finally {
      await f.dispose();
    }
  });

  test('a document written with CRLF reads as the same lines, and its sections keep their columns', async () => {
    const f = await fixture();
    try {
      await f.write('docs/a.md', '# A\r\n\r\n## B\r\n\r\nbody\r\n');
      const commit = f.commit();
      const { recorder } = await runUnit(sourceOf(f, commit), unitOf('orders-api', 'docs/a.md'));
      const [document] = factsOfKind(recorder.writes, 'document');
      const sections = factsOfKind(recorder.writes, 'section');
      expect(document?.provenance.place?.range).toEqual({ startLine: 1, startColumn: 0, endLine: 5, endColumn: 4 });
      expect(document?.value['bytes']).toBe(Buffer.byteLength('# A\r\n\r\n## B\r\n\r\nbody\r\n'));
      // The carriage returns are the document's bytes, not the lines' text.
      expect(sections[1]?.provenance.place?.range).toEqual({ startLine: 3, startColumn: 0, endLine: 5, endColumn: 4 });
      expect(sections[1]?.value['startByte']).toBe(Buffer.byteLength('# A\r\n\r\n'));
    } finally {
      await f.dispose();
    }
  });

  test('a carriage return with no newline after it is a character of its line', async () => {
    const f = await fixture();
    try {
      // A document whose last line ends in a lone carriage return: the pair a
      // CRLF file writes is not there, so the byte is the line's own.
      await f.write('docs/a.md', '# A\n\nbody\r');
      const commit = f.commit();
      const { recorder } = await runUnit(sourceOf(f, commit), unitOf('orders-api', 'docs/a.md'));
      const [document] = factsOfKind(recorder.writes, 'document');
      const section = factsOfKind(recorder.writes, 'section')[0];
      const bytes = Buffer.byteLength('# A\n\nbody\r');
      expect(document?.value['bytes']).toBe(bytes);
      expect(section?.provenance.place?.range).toEqual({ startLine: 1, startColumn: 0, endLine: 3, endColumn: 5 });
      expect(section?.value['endByte']).toBe(bytes);
    } finally {
      await f.dispose();
    }
  });

  test('a document whose text holds one heading only is written with no title and no section', async () => {
    const f = await fixture();
    try {
      await f.write('docs/plain.md', 'just words, no heading at all\n');
      const commit = f.commit();
      const { recorder } = await runUnit(sourceOf(f, commit), unitOf('orders-api', 'docs/plain.md'));
      const [document] = factsOfKind(recorder.writes, 'document');
      expect(document?.value['title']).toBeUndefined();
      expect(factsOfKind(recorder.writes, 'section')).toEqual([]);
      expect(document?.value['bytes']).toBe(Buffer.byteLength('just words, no heading at all\n'));
    } finally {
      await f.dispose();
    }
  });

  test('the coverage says what the unit read, in code point order, and completes when nothing was missed', async () => {
    const f = await fixture();
    try {
      await f.write('docs/a.md', '# A\n');
      const commit = f.commit();
      const { recorder } = await runUnit(sourceOf(f, commit), unitOf('orders-api', 'docs/a.md'));
      const [coverage] = factsOfKind(recorder.writes, 'coverage');
      expect(coverage?.value['repository']).toBe('orders-api');
      expect(coverage?.value['scope']).toBe(documentScope('orders-api', 'docs/a.md'));
      expect(coverage?.value['complete']).toBe(true);
      expect(coverage?.value['unread']).toEqual([]);
      // The coverage stands at the document it read, so a publication that
      // attributes a unit's facts by their place can retract it with them.
      expect(coverage?.provenance.place).toEqual({ file: 'docs/a.md', range: wholeFileRange('# A\n') });
      const read = coverage?.value['read'] as readonly string[];
      expect([...read]).toEqual([...read].sort());
    } finally {
      await f.dispose();
    }
  });

  test('the stage resolves a path link the way the wiki reads one', async () => {
    const f = await fixture();
    try {
      await f.write('docs/a.md', [
        '# A',
        '',
        '## B',
        '',
        '[plain](b.md) [dot](./b.md) [up](../src/order.ts) [data](data.txt) [missing](missing.md) [abs](/src/order.ts) [rel](//example.test/x) [out](https://example.test/x) [in](#b)',
        '',
      ].join('\n'));
      await f.write('docs/b.md', '# B\n');
      await f.write('docs/data.txt', 'x\n');
      await f.write('src/order.ts', 'export const order = 1;\n');
      const commit = f.commit();
      const { recorder } = await runUnit(sourceOf(f, commit), unitOf('orders-api', 'docs/a.md'));
      const sections = factsOfKind(recorder.writes, 'section');
      const ends = factsOfKind(recorder.writes, 'document-link').map((fact) => fact.value['to']);
      // One edge per end: the two spellings of the same document are one edge.
      expect(ends).toEqual([
        { form: 'node', id: nodeIdOf('document', 'orders-api', 'docs/b.md') },
        { form: 'node', id: nodeIdOf('file', 'orders-api', 'src/order.ts') },
        { form: 'node', id: nodeIdOf('file', 'orders-api', 'docs/data.txt') },
        { form: 'literal', text: 'missing.md' },
        { form: 'literal', text: '/src/order.ts' },
        { form: 'literal', text: '//example.test/x' },
        { form: 'external', url: 'https://example.test/x' },
        { form: 'node', id: sections[1]?.id },
      ]);
      // And the wiki's own resolver answers the same for every one of them: the
      // fill and the wiki agree on what a relative link names.
      const held = new Set(['docs/a.md', 'docs/b.md', 'docs/data.txt', 'src/order.ts']);
      const named: Readonly<Record<string, string | undefined>> = {
        'b.md': 'docs/b.md', './b.md': 'docs/b.md', '../src/order.ts': 'src/order.ts', 'data.txt': 'docs/data.txt',
        'missing.md': undefined, '/src/order.ts': undefined, '//example.test/x': undefined, 'https://example.test/x': undefined, '#b': undefined,
      };
      for (const [target, path] of Object.entries(named)) expect(resolveBodyLink('docs/a.md', target, held)).toBe(path);
    } finally {
      await f.dispose();
    }
  });

  test('the anchor of a heading is the one a reader follows', () => {
    expect(anchorOf('Requirement: strict YAML')).toBe('requirement-strict-yaml');
    expect(anchorOf('The `orders` API')).toBe('the-orders-api');
    expect(anchorOf('  Placing   an order  ')).toBe('placing-an-order');
    expect(anchorOf('---')).toBe('');
  });
});

// ---- incremental per document blob ----------------------------------------

describe('what a plan names, and what a later run reads back', () => {
  test('a first run plans one unit per Markdown document and no other file', async () => {
    const f = await fixture();
    try {
      await f.write('docs/a.md', '# A\n');
      await f.write('docs/b.markdown', '# B\n');
      await f.write('docs/c.mdx', '# C\n');
      await f.write('docs/d.txt', 'no\n');
      await f.write('src/order.ts', 'export const order = 1;\n');
      const commit = f.commit();
      const { plan, queries } = await runPlan(sourceOf(f, commit));
      expect(queries).toEqual([publishedDocumentsRead('orders-api')]);
      expect(unitIds(plan)).toEqual([documentUnitId('orders-api', 'docs/a.md'), documentUnitId('orders-api', 'docs/b.markdown'), documentUnitId('orders-api', 'docs/c.mdx')]);
      // The id and the scope are the stage's own contract with the run's wiring:
      // read them as literals and not through the function under test.
      expect(unitIds(plan)[0]).toBe('document:orders-api:docs/a.md');
      expect(plan.units[0]?.scope).toBe('orders-api:docs/a.md');
      expect(plan.units[2]?.scope).toBe('orders-api:docs/c.mdx');
      expect(plan.coverage).toBe('planned');
      expect(markdownMediaType('docs/c.mdx')).toBe('text/mdx');
    } finally {
      await f.dispose();
    }
  });

  test('a repository that holds no Markdown document anywhere plans nothing', async () => {
    const f = await fixture();
    try {
      await f.write('src/order.ts', 'export const order = 1;\n');
      const commit = f.commit();
      const { plan } = await runPlan(sourceOf(f, commit));
      expect(unitIds(plan)).toEqual([]);
      // Not "nothing to do" as if it were a first run of an empty graph: no
      // producer found a document here.
      expect(plan.coverage).toBe('nothing-found');
    } finally {
      await f.dispose();
    }
  });

  test('a document whose blob did not move is no unit of a later run, and one that moved is', async () => {
    const f = await fixture();
    try {
      await f.write('docs/a.md', '# A\n');
      await f.write('docs/b.md', '# B\n');
      const first = f.commit();
      const source = sourceOf(f, first);
      const a = await runUnit(source, unitOf('orders-api', 'docs/a.md'));
      const b = await runUnit(source, unitOf('orders-api', 'docs/b.md'));
      const published = [...publishedRows(a.recorder.writes, 'orders-api'), ...publishedRows(b.recorder.writes, 'orders-api')];
      expect(published.map((row) => row.path)).toEqual(['docs/a.md', 'docs/b.md']);

      // Nothing moved: the plan names no unit at all.
      const same = await runPlan(sourceOf(f, first), published);
      expect(unitIds(same.plan)).toEqual([]);
      // No unit, but not for want of a document: the tree holds two.
      expect(same.plan.coverage).toBe('planned');

      await f.write('docs/a.md', '# A\n\nchanged\n');
      const second = f.commit();
      const moved = await runPlan(sourceOf(f, second), published);
      expect(unitIds(moved.plan)).toEqual([documentUnitId('orders-api', 'docs/a.md')]);
    } finally {
      await f.dispose();
    }
  });

  test('a document the pinned commit no longer holds is planned and its unit writes nothing', async () => {
    const f = await fixture();
    try {
      await f.write('docs/a.md', '# A\n');
      await f.write('docs/b.md', '# B\n');
      const first = f.commit();
      const wroteA = await runUnit(sourceOf(f, first), unitOf('orders-api', 'docs/a.md'));
      const wroteB = await runUnit(sourceOf(f, first), unitOf('orders-api', 'docs/b.md'));
      const published = [...publishedRows(wroteA.recorder.writes, 'orders-api'), ...publishedRows(wroteB.recorder.writes, 'orders-api')];
      await f.remove('docs/b.md');
      const second = f.commit();
      const { plan } = await runPlan(sourceOf(f, second), published);
      expect(unitIds(plan)).toEqual([documentUnitId('orders-api', 'docs/b.md')]);
      const gone = await runUnit(sourceOf(f, second), unitOf('orders-api', 'docs/b.md'));
      expect(gone.recorder.writes).toEqual([]);
      // Nothing of the run names the path that is gone: the write set is empty.
      expect(gone.recorder.notes.join('\n')).toContain('publishes nothing');
    } finally {
      await f.dispose();
    }
  });

  test('a document renamed to a name that is no Markdown publishes nothing', async () => {
    const f = await fixture();
    try {
      await f.write('docs/b.md', '# B\n');
      const first = f.commit();
      const wrote = await runUnit(sourceOf(f, first), unitOf('orders-api', 'docs/b.md'));
      await f.remove('docs/b.md');
      await f.write('docs/b.txt', '# B\n');
      const second = f.commit();
      const { plan } = await runPlan(sourceOf(f, second), publishedRows(wrote.recorder.writes, 'orders-api'));
      expect(unitIds(plan)).toEqual([documentUnitId('orders-api', 'docs/b.md')]);
      const gone = await runUnit(sourceOf(f, second), unitOf('orders-api', 'docs/b.md'));
      expect(gone.recorder.writes).toEqual([]);
    } finally {
      await f.dispose();
    }
  });

  test('a symbolic link whose name looks like a document is no document', async () => {
    const f = await fixture();
    try {
      await f.write('docs/a.md', '# A\n');
      // A link's bytes are the path it points at, so it is no document a reader
      // reads: the inventory publishes it as a `symbolic-link` file, and this
      // stage leaves it alone.
      await symlink('a.md', join(f.root, 'docs/link.md'));
      const commit = f.commit();
      const { plan } = await runPlan(sourceOf(f, commit));
      expect(unitIds(plan)).toEqual([documentUnitId('orders-api', 'docs/a.md')]);
      const link = await runUnit(sourceOf(f, commit), unitOf('orders-api', 'docs/link.md'));
      expect(link.recorder.writes).toEqual([]);
      expect(link.recorder.notes.join('\n')).toContain('publishes nothing');
    } finally {
      await f.dispose();
    }
  });

  test('two runs of one commit plan the same units in code point order', async () => {
    const f = await fixture();
    try {
      await f.write('docs/b.md', '# B\n');
      await f.write('docs/a.md', '# A\n');
      await f.write('docs/a.md', '# A\n');
      const commit = f.commit();
      const first = await runPlan(sourceOf(f, commit));
      const second = await runPlan(sourceOf(f, commit));
      expect(unitIds(first.plan)).toEqual(unitIds(second.plan));
      expect(unitIds(first.plan)).toEqual([documentUnitId('orders-api', 'docs/a.md'), documentUnitId('orders-api', 'docs/b.md')]);
    } finally {
      await f.dispose();
    }
  });
});

// ---- the read's rows -------------------------------------------------------

describe('the plan reads what an earlier run published, strictly', () => {
  const read = publishedDocumentsRead('orders-api');
  const good: PublishedDocumentRow = { kind: 'document', repository: 'orders-api', path: 'docs/a.md', blob: 'a'.repeat(40) };

  test('a row of the read is read whole, and every refusal names the read, the row and what was wrong', async () => {
    expect([...publishedDocuments([good], 'orders-api', read).entries()]).toEqual([['docs/a.md', 'a'.repeat(40)]]);
    // A row that names no blob is a document whose bytes moved: the plan plans
    // it, which is what a fact written before the field existed does.
    expect(publishedDocuments([{ kind: 'document', repository: 'orders-api', path: 'docs/a.md' }], 'orders-api', read).get('docs/a.md')).toBeUndefined();

    const refusals: readonly (readonly [unknown, string])[] = [
      ['nonsense', 'is no row'],
      [{ ...good, repository: 'other' }, 'one read is one repository'],
      [{ ...good, kind: 'file' }, 'this stage holds "document"'],
      [{ ...good, path: '/abs/a.md' }, 'is no repository path'],
      [{ ...good, blob: 'nope' }, 'is no blob id'],
      [{ ...good, runId: 'run-7' }, 'is none of them'],
      [good, 'stands in an earlier row'],
    ];
    for (const [row, said] of refusals) {
      const rows = said === 'stands in an earlier row' ? [good, good] : [row];
      const message = await refusedBy(() => publishedDocuments(rows, 'orders-api', read));
      expect(message).toContain(said);
      expect(message).toContain(read);
      if (said !== 'stands in an earlier row') expect(message).toContain('row 1');
    }
  });

  test('a plan whose read answers an unusable row refuses rather than planning a smaller run', async () => {
    const f = await fixture();
    try {
      await f.write('docs/a.md', '# A\n');
      const commit = f.commit();
      const stage = createDocumentIndexStage(sourceOf(f, commit));
      const message = await refusedBy(() => stage.plan({ query: async () => [{ kind: 'document', repository: 'orders-api', path: 'docs/a.md', blob: 'x' }] }));
      expect(message).toContain('is no blob id');
    } finally {
      await f.dispose();
    }
  });
});

// ---- what a draft is judged by --------------------------------------------

describe('a draft is judged before it is published', () => {
  test('the facts of one document pass the stage own validate', async () => {
    const f = await fixture();
    try {
      await f.write('docs/a.md', '# A\n\n## B\n\nSee [C](c.md) and [out](https://example.test/x).\n\nTask: madarch-tzte.21.4\n');
      await f.write('docs/c.md', '# C\n');
      const commit = f.commit();
      const stage = createDocumentIndexStage(sourceOf(f, commit));
      const { context, recorder } = contextFor(unitOf('orders-api', 'docs/a.md'));
      await stage.execute(unitOf('orders-api', 'docs/a.md'), context);
      expect(await stage.validate({ writes: recorder.writes }, EMPTY_GRAPH)).toEqual({ ok: true });
    } finally {
      await f.dispose();
    }
  });

  test('a write that is no fact, a section without its document and an edge without its node are refused', async () => {
    const f = await fixture();
    try {
      await f.write('docs/a.md', '# A\n\n## B\n\nSee [C](c.md).\n\nTask: madarch-tzte.21.4\n');
      await f.write('docs/c.md', '# C\n');
      const commit = f.commit();
      const stage = createDocumentIndexStage(sourceOf(f, commit));
      const { context, recorder } = contextFor(unitOf('orders-api', 'docs/a.md'));
      await stage.execute(unitOf('orders-api', 'docs/a.md'), context);
      const facts = factsOf(recorder.writes);
      const section = facts.find((fact) => fact.kind === 'section') as DraftFact;
      const link = facts.find((fact) => fact.kind === 'document-link') as DraftFact;
      const key = facts.find((fact) => fact.kind === 'task-key') as DraftFact;
      const coverage = facts.find((fact) => fact.kind === 'coverage') as DraftFact;

      const wrongKind = await stage.validate({ writes: [{ kind: 'link', evidence: 'e', from: 'a', to: 'b' } as never] }, EMPTY_GRAPH);
      expect(wrongKind.ok).toBe(false);
      expect(wrongKind.ok ? [] : wrongKind.errors.join('\n')).toContain('writes facts, and a "link" write is not one');

      const orphanSection = await stage.validate({ writes: [{ kind: 'fact', evidence: 'e', value: section as never }, { kind: 'fact', evidence: 'e', value: coverage as never }] }, EMPTY_GRAPH);
      expect(orphanSection.ok).toBe(false);
      expect(orphanSection.ok ? [] : orphanSection.errors.join('\n')).toContain('this draft writes no document fact of that path');

      const unknownNode = makeEdgeFact({
        kind: 'document-link',
        value: { from: `document:${'0'.repeat(64)}`, to: { form: 'external', url: 'https://example.test/x' } },
        provenance: link.provenance as never,
        layer: 'extracted',
      });
      const orphanEdge = await stage.validate({ writes: [{ kind: 'fact', evidence: 'e', value: unknownNode as never }] }, EMPTY_GRAPH);
      expect(orphanEdge.ok).toBe(false);
      expect(orphanEdge.ok ? [] : orphanEdge.errors.join('\n')).toContain('this draft writes no document or section fact of that id');

      const unknownSection = makeEdgeFact({
        kind: 'document-link',
        value: { from: facts[0]?.id as string, to: { form: 'node', id: `section:${'1'.repeat(64)}` } },
        provenance: link.provenance as never,
        layer: 'extracted',
      });
      const orphanFragment = await stage.validate({ writes: [{ kind: 'fact', evidence: 'e', value: unknownSection as never }] }, EMPTY_GRAPH);
      expect(orphanFragment.ok).toBe(false);
      expect(orphanFragment.ok ? [] : orphanFragment.errors.join('\n')).toContain('names a section of the document the link stands in');

      // A fact write the schema already refused — no value at all, a value that
      // is no object — is named by the check and never read past it.
      const noValue = await stage.validate({ writes: [{ kind: 'fact', evidence: 'e', value: null as never }] }, EMPTY_GRAPH);
      expect(noValue.ok).toBe(false);
      expect(noValue.ok ? [] : noValue.errors.join('\n')).toContain('a fact is an object with kind, schemaVersion, id, provenance, layer, status and value, not null');

      // An empty draft is a draft whole: it is the retraction a vanished
      // document asks for.
      expect(await stage.validate({ writes: [] }, EMPTY_GRAPH)).toEqual({ ok: true });
      // And a draft that writes the document, its sections and the key passes:
      // the key stands in the second section, which this draft writes.
      const sections = facts.filter((fact) => fact.kind === 'section');
      const whole = [recorder.writes[0] as never, ...sections.map((one) => ({ kind: 'fact' as const, evidence: 'e', value: one as never })), { kind: 'fact' as const, evidence: 'e', value: key as never }];
      expect(await stage.validate({ writes: whole }, EMPTY_GRAPH)).toEqual({ ok: true });
    } finally {
      await f.dispose();
    }
  });
});

// ---- what a fact may carry -------------------------------------------------

describe('nothing of a machine, a run or a unit reaches a fact', () => {
  test('every fact of a unit cites the repository at the pinned commit, and no fact names the checkout', async () => {
    const f = await fixture();
    try {
      await f.write('docs/a.md', '# A\n\nSee [B](b.md) and [the code](../src/order.ts).\n\nTask: madarch-tzte.21.4\n');
      await f.write('docs/b.md', '# B\n');
      await f.write('src/order.ts', 'export const order = 1;\n');
      const commit = f.commit();
      const { recorder } = await runUnit(sourceOf(f, commit), unitOf('orders-api', 'docs/a.md'));
      const unit = unitOf('orders-api', 'docs/a.md');
      for (const write of recorder.writes) {
        expect(write.evidence).toBe(`orders-api@${commit}:docs/a.md`);
        const fact = (write as { value: { provenance: { repository: { id: string; commit: string } } } }).value;
        expect(fact.provenance.repository).toEqual({ id: 'orders-api', commit });
      }
      const written = JSON.stringify(recorder.writes);
      expect(written).not.toContain(f.root);
      expect(written).not.toContain(unit.id);
      expect(written).not.toContain('runId');
    } finally {
      await f.dispose();
    }
  });

  test('a cancelled unit raises and publishes nothing', async () => {
    const f = await fixture();
    try {
      await f.write('docs/a.md', '# A\n');
      const commit = f.commit();
      const stage = createDocumentIndexStage(sourceOf(f, commit));
      const { context, recorder, controller } = contextFor(unitOf('orders-api', 'docs/a.md'));
      controller.abort();
      const message = await refusedBy(() => stage.execute(unitOf('orders-api', 'docs/a.md'), context));
      expect(message).toContain('was cancelled');
      expect(recorder.writes).toEqual([]);
    } finally {
      await f.dispose();
    }
  });

  test('a unit this stage never plans is refused by name', async () => {
    const f = await fixture();
    try {
      await f.write('docs/a.md', '# A\n');
      const commit = f.commit();
      const stage = createDocumentIndexStage(sourceOf(f, commit));
      for (const scope of ['docs/a.md', 'orders-api:', 'orders-api:/abs/a.md', ':docs/a.md']) {
        const { context } = contextFor({ id: 'document:orders-api:docs/a.md', scope });
        expect(await refusedBy(() => stage.execute({ id: 'x', scope }, context))).toContain('document-index');
      }
    } finally {
      await f.dispose();
    }
  });
});
