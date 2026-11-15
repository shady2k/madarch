/**
 * The work kinds hold what the beads tracker export holds (madarch-64o5.68): every field of `.beads/issues.jsonl`
 * has a declared field on a work kind or an entity kind of its own, so moving the tracker into the catalogue loses
 * nothing. The starter value sets the work kinds point at are declared with their entries.
 */
import { describe, expect, test } from 'bun:test';
import { parse } from 'yaml';
import { CATALOG_FILES } from '../src/knowledge/catalog-assets.js';
import { byCodePoint } from '../src/model/order.js';

interface KindDeclaration {
  readonly name: string;
  readonly fields: readonly { name: string; reference?: string }[];
  readonly description?: Record<string, unknown>;
}

function kinds(): Map<string, KindDeclaration> {
  const held = new Map<string, KindDeclaration>();
  for (const path of Object.keys(CATALOG_FILES).sort(byCodePoint)) {
    if (path === 'catalog.yaml' || path.startsWith('templates/')) continue;
    const declaration = parse(CATALOG_FILES[path]!) as Record<string, unknown>;
    const name = path.split('/').pop()!.slice(0, -'.yaml'.length);
    held.set(name, {
      name,
      fields: (declaration['fields'] as { name: string; reference?: string }[] | undefined) ?? [],
      description: declaration['description'] as Record<string, unknown> | undefined,
    });
  }
  return held;
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

/** Where each field of the export lives: a work kind's field, the kind that is the entity, or an edge. */
const HOME: Partial<Record<keyof typeof ISSUE, { kind: string; field?: string; reference?: string }>> = {
  id: { kind: 'task', field: 'key' },
  title: { kind: 'task', field: 'title' },
  description: { kind: 'task', field: 'description' },
  status: { kind: 'task', field: 'status', reference: 'value-set-entry' },
  priority: { kind: 'task', field: 'priority', reference: 'value-set-entry' },
  labels: { kind: 'task', field: 'labels', reference: 'value-set-entry' },
  // A dependency and a comment are entities and edges of their own: the task points at them, the fields are theirs.
  dependencies: { kind: 'comment', field: 'author' },
  comments: { kind: 'comment', field: 'body' },
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

describe('the work kinds hold the tracker export (madarch-64o5.68)', () => {
  const catalogue = kinds();

  test('every field of an exported issue has a declared home', () => {
    const missing: string[] = [];
    for (const key of Object.keys(ISSUE).sort(byCodePoint)) {
      const home = HOME[key as keyof typeof HOME];
      const elsewhere = ELSEWHERE[key as keyof typeof ELSEWHERE];
      if (home === undefined && elsewhere === undefined) { missing.push(`${key}: no home is named`); continue; }
      if (home === undefined) continue;
      const kind = catalogue.get(home.kind);
      if (kind === undefined) { missing.push(`${key}: the kind ${home.kind} is not declared`); continue; }
      const field = kind.fields.find((one) => one.name === home.field);
      if (field === undefined) { missing.push(`${key}: ${home.kind} declares no field ${home.field}`); continue; }
      if (home.reference !== undefined && field.reference !== home.reference) missing.push(`${key}: ${home.kind}.${home.field} does not reference ${home.reference}`);
    }
    expect(missing).toEqual([]);
    // The fields the export wrote that say how the tracker was run are not fields of a kind any more.
    const task = catalogue.get('task')!;
    for (const gone of ['legacy_id', 'body', 'front', 'issue_type', 'assignee', 'owner', 'created_at', 'updated_at', 'closed_at', 'close_reason', 'dependencies', 'comments']) {
      expect([gone, task.fields.some((field) => field.name === gone)]).toEqual([gone, false]);
    }
  });

  test('a dependency is an edge and a comment is an entity of its own', () => {
    const task = parse(CATALOG_FILES['work/execution/task.yaml']!) as { 'relation-constraints': { out: string[] } };
    expect(task['relation-constraints'].out).toContain('dependsOn');
    expect(task['relation-constraints'].out).toContain('hasPart');
    expect(catalogue.has('link')).toBe(false);
    const comment = catalogue.get('comment');
    expect(comment?.fields.map((field) => field.name)).toEqual(expect.arrayContaining(['author', 'body', 'created_at']));
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
});
