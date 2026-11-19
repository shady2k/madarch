/**
 * The work kinds hold what the beads tracker export holds (madarch-64o5.68): every field of `.beads/issues.jsonl`
 * has a declared field on a work kind or an entity kind of its own, so moving the tracker into the catalogue loses
 * nothing. The starter value sets the work kinds point at are declared with their entries.
 *
 * A tracker dependency is one edge, `work.depends-on`, whose `type` attribute carries the tracker's link type:
 * the six work kinds stand at both ends, and a task that depends on a comment is refused.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { CATALOG_FILES } from '../src/knowledge/catalog-assets.js';
import { byCodePoint } from '../src/model/order.js';
import { createDraft } from '../src/product/draft.js';
import { publishValidatedManifests, startupBinding, validateProductManifests } from '../src/graph/manifest-publication.js';
import { withManifestContract } from '../src/graph/manifest-contract.js';
import { graphContractOf } from '../src/fill/stages/plugin-contract.js';
import { publishGraphDrafts } from '../src/graph/write.js';
import { readKindAssertions } from '../src/graph/records.js';
import { newUid } from '../src/graph/uid.js';
import { createTestDatabaseOwner } from './test-database.js';
import { gitEnv } from './git-env.js';
import { SAMPLE_IDENTITY } from './knowledge-fixture.js';

interface KindDeclaration {
  readonly name: string;
  readonly fields: readonly { name: string; type?: string }[];
  readonly constraints?: { readonly out?: readonly string[]; readonly in?: readonly string[] };
  readonly description?: Record<string, unknown>;
}

interface EdgeDeclaration {
  readonly name: string;
  readonly from: readonly string[];
  readonly to: readonly string[];
  readonly repeats?: boolean;
  readonly fields?: readonly { name: string; type?: string; nullable?: boolean }[];
  readonly cardinality: {
    readonly from: { readonly min: number; readonly max: number | null };
    readonly to: { readonly min: number; readonly max: number | null };
  };
}

function kinds(): Map<string, KindDeclaration> {
  const held = new Map<string, KindDeclaration>();
  for (const path of Object.keys(CATALOG_FILES).sort(byCodePoint)) {
    if (path === 'catalog.yaml' || path.startsWith('templates/')) continue;
    const declaration = parse(CATALOG_FILES[path]!) as Record<string, unknown>;
    const name = path.split('/').pop()!.slice(0, -'.yaml'.length);
    held.set(name, {
      name,
      fields: (declaration['fields'] as { name: string; type?: string }[] | undefined) ?? [],
      constraints: declaration['relation-constraints'] as KindDeclaration['constraints'],
      description: declaration['description'] as Record<string, unknown> | undefined,
    });
  }
  return held;
}

function edges(): Map<string, EdgeDeclaration> {
  const declaration = parse(CATALOG_FILES['catalog.yaml']!) as { edges: EdgeDeclaration[] };
  return new Map(declaration.edges.map((edge) => [edge.name, edge]));
}

/** One line of the tracker export, with every field the export writes. */
const ISSUE = {
  id: 'bd-7f3a',
  title: 'Let a request come from an agent too',
  description: 'A request is a person\'s utterance or an agent\'s proposal.',
  status: 'in_progress',
  priority: 1,
  issue_type: 'task',
  labels: ['security', 'testing'],
  assignee: 'agent:claude',
  owner: 'shady2k',
  created_at: '2026-11-13T10:00:00Z',
  updated_at: '2026-11-14T09:30:00Z',
  closed_at: null,
  close_reason: null,
  dependencies: [{ issue_id: 'bd-7f3a', depends_on_id: 'bd-1000', type: 'blocks', created_at: '2026-11-13T10:05:00Z', created_by: 'shady2k' }],
  comments: [{ author: 'shady2k', text: 'Проверь перенос полей.', created_at: '2026-11-13T11:00:00Z' }],
} as const;

/** Where each field of the export lives: a kind's field with its type, or an edge the kind stands in. */
type Home =
  | { readonly kind: string; readonly field: string; readonly type?: string }
  | { readonly kind: string; readonly edge: string };

const HOME: Partial<Record<keyof typeof ISSUE, Home>> = {
  id: { kind: 'task', field: 'key' },
  title: { kind: 'task', field: 'title' },
  description: { kind: 'task', field: 'description' },
  status: { kind: 'task', field: 'status', type: 'value-set-value' },
  priority: { kind: 'task', field: 'priority', type: 'value-set-value' },
  labels: { kind: 'task', field: 'labels', type: 'value-set-value-list' },
  // A dependency and a comment are entities and edges of their own: the task stands at one end of the edge, and the
  // fields the record carries have their own homes below.
  dependencies: { kind: 'task', edge: 'work.depends-on' },
  comments: { kind: 'comment', field: 'body' },
};

/** Where each field of one exported dependency lives: an end of the edge, a field of it, or words saying where. */
type DependencyHome =
  | { readonly end: 'from' | 'to' }
  | { readonly edge: string; readonly field: string; readonly type: string }
  | { readonly elsewhere: string };

const DEPENDENCY_HOME: Readonly<Record<string, DependencyHome>> = {
  issue_id: { end: 'from' },
  depends_on_id: { end: 'to' },
  type: { edge: 'work.depends-on', field: 'type', type: 'value-set-value' },
  created_at: { elsewhere: 'the instant the statement about the edge holds from (valid_from), not a field of the edge' },
  created_by: { elsewhere: 'the source of the statement about the edge, not a field of the edge' },
};

/**
 * What the export wrote that the catalogue now states as a kind, an edge or a value rather than as a tracker field:
 * the issue's type is its kind, its assignee and owner are the ownedBy edge, and its times are the work spans and the
 * decision that closed it. The tracker field set itself is gone (the audit of 2026-11-15): copying it onto a kind made
 * the kind's own properties unreadable.
 */
const ELSEWHERE: Partial<Record<keyof typeof ISSUE, string>> = {
  issue_type: 'the kind of the entity: a task, a defect, an epic, a feature, a stage or a milestone',
  assignee: 'the ownedBy edge from the entity to the person',
  owner: 'the ownedBy edge from the entity to the person',
  created_at: 'the work span that records the work, not the entity',
  updated_at: 'the work span that records the work, not the entity',
  closed_at: 'the decision that closed the entity',
  close_reason: 'the decision that closed the entity',
};

/** The ways one dependency field misses its declared home; empty when every field has one. */
function dependencyMisses(declared: Map<string, EdgeDeclaration>): string[] {
  const missing: string[] = [];
  for (const key of Object.keys(ISSUE.dependencies[0]).sort(byCodePoint)) {
    const home = DEPENDENCY_HOME[key];
    if (home === undefined) { missing.push(`${key}: no home is named`); continue; }
    if ('elsewhere' in home) {
      if (home.elsewhere.trim() === '') missing.push(`${key}: the words saying where it lives are empty`);
      continue;
    }
    if ('end' in home) continue;
    const edge = declared.get(home.edge);
    if (edge === undefined) { missing.push(`${key}: the edge ${home.edge} is not declared`); continue; }
    const field = edge.fields?.find((one) => one.name === home.field);
    if (field === undefined) { missing.push(`${key}: ${home.edge} declares no field ${home.field}`); continue; }
    if (field.type !== home.type) missing.push(`${key}: ${home.edge}.${home.field} has type ${field.type ?? 'none'}, not ${home.type}`);
  }
  return missing;
}

describe('the work kinds hold the tracker export (madarch-64o5.68)', () => {
  const catalogue = kinds();
  const declared = edges();

  test('every field of an exported issue has a declared home', () => {
    const missing: string[] = [];
    for (const key of Object.keys(ISSUE).sort(byCodePoint)) {
      const home = HOME[key as keyof typeof HOME];
      const elsewhere = ELSEWHERE[key as keyof typeof ELSEWHERE];
      if (home === undefined && elsewhere === undefined) { missing.push(`${key}: no home is named`); continue; }
      if (home === undefined) continue;
      const kind = catalogue.get(home.kind);
      if (kind === undefined) { missing.push(`${key}: the kind ${home.kind} is not declared`); continue; }
      if ('edge' in home) {
        const edge = declared.get(home.edge);
        if (edge === undefined) { missing.push(`${key}: the edge ${home.edge} is not declared`); continue; }
        if (!edge.from.includes(home.kind)) missing.push(`${key}: ${home.edge} does not start at ${home.kind}`);
        if (!edge.to.includes(home.kind)) missing.push(`${key}: ${home.edge} does not end at ${home.kind}`);
        continue;
      }
      const field = kind.fields.find((one) => one.name === home.field);
      if (field === undefined) { missing.push(`${key}: ${home.kind} declares no field ${home.field}`); continue; }
      if (home.type !== undefined && field.type !== home.type) missing.push(`${key}: ${home.kind}.${home.field} has type ${field.type ?? 'none'}, not ${home.type}`);
    }
    expect(missing).toEqual([]);
    // The fields the export wrote that say how the tracker was run are not fields of a kind any more.
    const task = catalogue.get('task')!;
    for (const gone of ['legacy_id', 'body', 'front', 'issue_type', 'assignee', 'owner', 'created_at', 'updated_at', 'closed_at', 'close_reason', 'dependencies', 'comments']) {
      expect([gone, task.fields.some((field) => field.name === gone)]).toEqual([gone, false]);
    }
  });

  test('every field of an exported dependency has a declared home', () => {
    expect(dependencyMisses(declared)).toEqual([]);
    expect(Object.keys(ISSUE.dependencies[0]).sort(byCodePoint)).toEqual([...Object.keys(DEPENDENCY_HOME)].sort(byCodePoint));
  });

  test('a dependency is one edge between the six work kinds, and a comment is an entity of its own', () => {
    const workKinds = ['task', 'defect', 'epic', 'feature', 'stage', 'milestone'].sort(byCodePoint);
    const dependency = declared.get('work.depends-on');
    expect(dependency).toBeDefined();
    if (dependency === undefined) return;
    expect(dependency.from).toEqual(workKinds);
    expect(dependency.to).toEqual(workKinds);
    expect(dependency.cardinality).toEqual({ from: { min: 0, max: null }, to: { min: 0, max: null } });
    expect(dependency.repeats).toBeUndefined();
    expect(dependency.fields?.map((field) => ({ name: field.name, type: field.type, nullable: field.nullable ?? false })))
      .toEqual([{ name: 'type', type: 'value-set-value', nullable: false }]);
    for (const kind of workKinds) {
      const constraints = catalogue.get(kind)?.constraints;
      expect([kind, 'out', constraints?.out?.includes('work.depends-on') ?? false]).toEqual([kind, 'out', true]);
      expect([kind, 'in', constraints?.in?.includes('work.depends-on') ?? false]).toEqual([kind, 'in', true]);
    }
    for (const kind of ['task', 'stage']) {
      const constraints = catalogue.get(kind)?.constraints;
      expect([kind, 'out', constraints?.out?.includes('dependsOn') ?? false]).toEqual([kind, 'out', false]);
      expect([kind, 'in', constraints?.in?.includes('dependsOn') ?? false]).toEqual([kind, 'in', false]);
    }
    expect(catalogue.get('task')?.constraints?.out).toContain('hasPart');
    expect(catalogue.has('link')).toBe(false);
    const comment = catalogue.get('comment');
    expect(comment?.fields.map((field) => field.name)).toEqual(expect.arrayContaining(['body', 'created_at']));
    expect(comment?.fields.map((field) => field.name)).not.toContain('author');
    // The author is the edge, not a field of the comment: one comment has exactly one author.
    const author = declared.get('comment-author');
    expect(author?.from).toEqual(['comment']);
    expect(author?.to).toEqual(['person']);
    expect(author?.cardinality.from).toEqual({ min: 1, max: 1 });
  });

  test('an issue type names a kind the catalogue declares', () => {
    for (const kind of ['task', 'defect', 'epic', 'feature', 'stage', 'milestone']) expect([kind, catalogue.has(kind)]).toEqual([kind, true]);
  });

  test('the starter value sets the work kinds point at are declared with their entries', () => {
    const template = parse(CATALOG_FILES['templates/everything.yaml']!) as { values?: Record<string, { labels?: Record<string, string>; entries?: { value?: string; labels?: Record<string, string>; description?: string; order?: number }[] }> };
    const values = template.values ?? {};
    const expected = ['task-status', 'priority', 'issue-type', 'link-type', 'label'];
    expect(Object.keys(values).sort(byCodePoint)).toEqual(expect.arrayContaining(expected));
    for (const name of expected) {
      const set = values[name]!;
      expect(set.labels?.en?.length ?? 0).toBeGreaterThan(0);
      expect(set.labels?.ru?.length ?? 0).toBeGreaterThan(0);
      expect(set.entries?.length ?? 0).toBeGreaterThan(0);
      for (const entry of set.entries ?? []) {
        expect(entry.value?.length ?? 0).toBeGreaterThan(0);
        expect(entry.labels?.en?.length ?? 0).toBeGreaterThan(0);
        expect(entry.labels?.ru?.length ?? 0).toBeGreaterThan(0);
        expect(entry.description?.length ?? 0).toBeGreaterThan(0);
        expect(typeof entry.order).toBe('number');
      }
    }
  });

  test('a dependency between two tasks is recorded as an edge, and a comment at its end is refused', async () => {
    const root = mkdtempSync(join(tmpdir(), 'madarch-work-depends-'));
    let owner: Awaited<ReturnType<typeof createTestDatabaseOwner>> | undefined;
    try {
      const draft = createDraft({ home: root, name: 'work-depends', template: 'everything', gitEnv: gitEnv(SAMPLE_IDENTITY) });
      if (draft.outcome !== 'created') throw new Error(JSON.stringify(draft));
      const read = validateProductManifests(draft.folder);
      if (!read.ok) throw new Error(read.findings.map((one) => `${one.file}:${one.line}: ${one.message}`).join('\n'));
      if (read.value === undefined) throw new Error(`${draft.folder}:1: no manifest`);
      const validated = read.value;
      const contract = withManifestContract(graphContractOf(validated.manifest));
      owner = await createTestDatabaseOwner({ graphContract: contract });
      await publishValidatedManifests(owner, validated);
      const commentUid = newUid();
      const personUid = newUid();
      await owner.transaction('write', async (tx) => {
        const { contract: bound } = await startupBinding(tx, contract, 'test');
        await publishGraphDrafts(tx, bound, {
          vertices: [
            { kind: 'task', key: { tracker: 'test', key: 'T-1' }, values: { title: 'First task' }, producer: 'test', producerVersion: '1' },
            { kind: 'task', key: { tracker: 'test', key: 'T-2' }, values: { title: 'Second task' }, producer: 'test', producerVersion: '1' },
            { kind: 'comment', key: {}, uid: commentUid, values: { body: 'A remark', created_at: '2026-11-13T11:00:00Z' }, producer: 'test', producerVersion: '1' },
            { kind: 'person', key: {}, uid: personUid, values: { installation: 'work-depends-fixture' }, producer: 'test', producerVersion: '1' },
          ],
          edges: [{ kind: 'comment-author', from: { kind: 'comment', key: {}, uid: commentUid }, to: { kind: 'person', key: {}, uid: personUid }, producer: 'test', producerVersion: '1' }],
          removals: [],
        });
      });
      await owner.transaction('write', async (tx) => {
        const { contract: bound } = await startupBinding(tx, contract, 'test');
        await publishGraphDrafts(tx, bound, { vertices: [], edges: [{
          kind: 'work.depends-on',
          from: { kind: 'task', key: { tracker: 'test', key: 'T-1' } },
          to: { kind: 'task', key: { tracker: 'test', key: 'T-2' } },
          values: { type: 'blocks' },
          producer: 'test',
          producerVersion: '1',
        }], removals: [] });
      });
      const tasks = await owner.run((tx) => readKindAssertions(tx, 'vertex', 'task', ['title'], { contract }));
      const dependencies = await owner.run((tx) => readKindAssertions(tx, 'edge', 'work.depends-on', ['type'], { contract }));
      expect(tasks.map((task) => String(task.key['key'])).sort(byCodePoint)).toEqual(['T-1', 'T-2']);
      expect(dependencies).toHaveLength(1);
      const byId = new Map(tasks.map((task) => [task.id, task]));
      expect(byId.get(dependencies[0]!.from!)?.key['key']).toBe('T-1');
      expect(byId.get(dependencies[0]!.to!)?.key['key']).toBe('T-2');
      expect(dependencies[0]!.values['type']).toBe('blocks');
      await expect(owner.transaction('write', async (tx) => {
        const { contract: bound } = await startupBinding(tx, contract, 'test');
        await publishGraphDrafts(tx, bound, { vertices: [], edges: [{
          kind: 'work.depends-on',
          from: { kind: 'task', key: { tracker: 'test', key: 'T-1' } },
          to: { kind: 'comment', key: {}, uid: commentUid },
          values: { type: 'blocks' },
          producer: 'test',
          producerVersion: '1',
        }], removals: [] });
      })).rejects.toThrow(/ENDPOINT_KIND work\.depends-on/u);
    } finally { await owner?.close(); rmSync(root, { recursive: true, force: true }); }
  }, 120_000); // Measured 20-26 s on 2026-11-19: the everything template published to a test database, then three writes.
});
