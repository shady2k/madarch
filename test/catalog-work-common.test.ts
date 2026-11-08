/**
 * The catalog's two areas of 2026-11-08: Work (the tracker) and Common (the records every kind may carry), with the
 * schema subgroup of the manifest's own building blocks. The test holds the rows to the owner's agreement: one concept
 * is one kind, every kind has its Russian and English names and its relations from the catalog's vocabulary, and the
 * kinds the tracker replaces are merged, never added a second time.
 */
import { describe, expect, test } from 'bun:test';
import { CATALOG_GROUPS, CATALOG_KINDS, CATALOG_RELATIONS } from '../src/knowledge/starter-catalog.js';

const rows = new Map(CATALOG_KINDS.map((kind) => [kind.name, kind]));
const groups = new Map(CATALOG_GROUPS.map((group) => [group.name, group]));

/** The kinds of the two areas, by the subgroup each stands in. */
const AREA_KINDS: Readonly<Record<string, string>> = {
  'link': 'common.attachment',
  'comment': 'common.attachment',
  'time-entry': 'common.attachment',
  'request': 'common.attachment',
  'approval': 'common.attachment',
  'external-reference': 'common.attachment',
  'operation': 'common.attachment',
  'snapshot': 'common.attachment',
  'kind': 'common.schema',
  'field-set': 'common.schema',
  'workflow': 'common.schema',
  'workflow-status': 'common.schema',
  'workflow-transition': 'common.schema',
  'link-type': 'common.schema',
  'link-behaviour': 'common.schema',
  'milestone': 'work.planning',
  'epic': 'work.planning',
  'feature': 'work.planning',
  'stage': 'work.planning',
  'task': 'work.execution',
  'bug': 'work.execution',
  'lifecycle-step': 'work.execution',
  'question': 'work.coordination',
  'reservation': 'work.coordination',
  'handoff': 'work.coordination',
  'review-finding': 'work.sync',
  'evidence': 'work.sync',
  'merge': 'work.sync',
};

describe('the Work and Common areas of the catalog', () => {
  test('the two areas and their subgroups stand with both names and a short label each', () => {
    expect(groups.get('work')).toMatchObject({ en: 'Work', ru: 'Работа', shortEn: 'Work', shortRu: 'Работа' });
    expect(groups.get('common')).toMatchObject({ en: 'Common', ru: 'Общие', shortEn: 'Common', shortRu: 'Общие' });
    for (const [name, en, ru] of [
      ['work.planning', 'Planning', 'Планирование'],
      ['work.execution', 'Execution', 'Исполнение'],
      ['work.coordination', 'Coordination', 'Координация'],
      ['work.sync', 'Sync', 'Синхронизация'],
      ['common.attachment', 'Attached records', 'Приложенные записи'],
      ['common.schema', 'Schema', 'Схема'],
    ] as const) {
      const group = groups.get(name);
      expect(group).toMatchObject({ en, ru, parent: name.startsWith('work.') ? 'work' : 'common' });
      expect(group?.shortEn.length).toBeGreaterThan(0);
      expect(group?.shortRu.length).toBeGreaterThan(0);
    }
  });

  test('every kind of the two areas has its row, both names and relations the catalog declares', () => {
    expect(Object.keys(AREA_KINDS)).toHaveLength(28);
    for (const [name, group] of Object.entries(AREA_KINDS)) {
      const row = rows.get(name);
      expect(row, `${name} is a kind of the catalog`).toBeDefined();
      if (row === undefined) continue;
      expect(row.group).toBe(group);
      expect(row.definition.length).toBeGreaterThan(0);
      expect(row.sources.length).toBeGreaterThan(0);
      expect(row.acquisition.length).toBeGreaterThan(0);
      expect(row.status).toBe(name === 'task' || name === 'question' ? 'implemented' : 'not-implemented');
      expect(row.en).toBeDefined();
      expect(row.ru).toBeDefined();
      expect(row.policy).toBe(name === 'task' || name === 'question' ? 'page' : 'none');
      for (const relation of [...row.out, ...row.into]) expect(CATALOG_RELATIONS).toHaveProperty(relation);
    }
  });

  test('one concept is one kind: the tracker replaces four old rows and never adds a second kind for a moved one', () => {
    for (const merged of ['review-comment', 'review-approval', 'issue', 'workflow-definition']) expect(rows.has(merged)).toBe(false);
    // A defect is the ISTQB imperfection, not the tracker's work item: the two senses stay two kinds.
    expect(rows.get('defect')).toMatchObject({ group: 'testing.defect', id: 'istqb.defect' });
    expect(rows.get('comment')).toMatchObject({ group: 'common.attachment', id: 'practice.comment' });
    expect(rows.get('approval')).toMatchObject({ group: 'common.attachment', id: 'practice.approval' });
    expect(rows.get('bug')).toMatchObject({ group: 'work.execution', id: 'practice.bug' });
    expect(rows.get('task')).toMatchObject({ group: 'work.execution', id: 'practice.product-task', policy: 'page' });
    expect(rows.get('question')).toMatchObject({ group: 'work.coordination', id: 'practice.question', policy: 'page' });
    expect(rows.get('epic')?.group).toBe('work.planning');
    expect(rows.get('feature')?.group).toBe('work.planning');
    expect(rows.get('workflow')).toMatchObject({ group: 'common.schema', id: 'manifest.workflows' });
    // The UML state machine keeps its `transition`; the manifest's status move is the separate workflow-transition.
    expect(rows.get('transition')).toMatchObject({ group: 'architecture.behaviour', id: 'uml.transition' });
    expect(rows.get('workflow-transition')).toMatchObject({ group: 'common.schema', id: 'manifest.transitions' });
  });

  test('the time entry names the types its sources declare, and the external reference is a kind because the catalog has no other shared record', () => {
    const time = rows.get('time-entry');
    expect(time).toBeDefined();
    for (const type of ['work time', 'waiting', "agent's run"]) expect(time?.definition.includes(type)).toBe(true);
    expect(time?.sources.length).toBeGreaterThanOrEqual(3);
    expect(time?.sources.some((source) => source.includes('jira'))).toBe(true);
    expect(time?.sources.some((source) => source.includes('opentelemetry'))).toBe(true);
    expect(rows.get('external-reference')).toMatchObject({ group: 'common.attachment', policy: 'none' });
  });
});
