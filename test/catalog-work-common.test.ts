/**
 * The catalog's two areas of 2026-11-08: Work (the tracker) and Common (the records every kind may carry), with the
 * schema subgroup of the manifest's own building blocks. The test holds the rows to the owner's agreement: one concept
 * is one kind, every kind has its Russian and English names and its relations from the catalog's vocabulary, and the
 * kinds the tracker replaces are merged, never added a second time.
 */
import { describe, expect, test } from 'bun:test';
import { CATALOG_GROUPS, CATALOG_KINDS } from '../src/knowledge/catalog-starter.js';
import { readFileSync } from 'node:fs';
import { parse as parseCatalogYaml } from 'yaml';
const CATALOG_RELATIONS = parseCatalogYaml(readFileSync(new URL('../catalog/catalog.yaml', import.meta.url), 'utf8')).catalog.relations as Record<string, string | null>;

const rows = new Map(CATALOG_KINDS.map((kind) => [kind.name, kind]));
const groups = new Map(CATALOG_GROUPS.map((group) => [group.name, group]));

/** The kinds of the two areas, by the subgroup each stands in. */
const AREA_KINDS: Readonly<Record<string, string>> = {
  'accounting': 'common.schema',
  'approval': 'common.attachment',
  'approval-package': 'common.attachment',
  'code-convention': 'work.ways',
  'comment': 'common.attachment',
  'constitution': 'work.ways',
  'epic': 'work.planning',
  'evidence': 'work.sync',
  'external-reference': 'common.attachment',
  'feature': 'work.planning',
  'field-set': 'common.schema',
  'handoff': 'work.coordination',
  'kind': 'common.schema',
  'link-behaviour': 'common.schema',
  'link-type': 'common.schema',
  'merge': 'work.sync',
  'milestone': 'work.planning',
  'operation': 'common.attachment',
  'practice': 'work.ways',
  'proposed-kind': 'common.schema',
  'question': 'work.coordination',
  'request': 'common.attachment',
  'responsibility': 'common.schema',
  'review-finding': 'work.sync',
  'skill': 'work.ways',
  'snapshot': 'common.attachment',
  'stage': 'work.planning',
  'task': 'work.execution',
  'value-set': 'common.values',
  'value-set-entry': 'common.values',
  'work-span': 'work.execution',
  'workflow': 'common.schema',
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
      ['common.values', 'Values', 'Справочники'],
      ['work.ways', 'Ways of working', 'Способы работы'],
    ] as const) {
      const group = groups.get(name);
      expect(group).toMatchObject({ en, ru, parent: name.startsWith('work.') ? 'work' : 'common' });
      expect(group?.shortEn.length).toBeGreaterThan(0);
      expect(group?.shortRu.length).toBeGreaterThan(0);
    }
  });

  test('every kind of the two areas has its row, both names and relations the catalog declares', () => {
    expect(Object.keys(AREA_KINDS)).toHaveLength(32);
    for (const [name, group] of Object.entries(AREA_KINDS)) {
      const row = rows.get(name);
      expect(row, `${name} is a kind of the catalog`).toBeDefined();
      if (row === undefined) continue;
      expect(row.group).toBe(group);
      expect(row.definition.length).toBeGreaterThan(0);
      expect(row.sources.length).toBeGreaterThan(0);
      expect(row.acquisition.length).toBeGreaterThan(0);
      expect(row.en).toBeDefined();
      expect(row.ru).toBeDefined();
      const page = ['accounting', 'code-convention', 'comment', 'constitution', 'epic', 'feature', 'field-set', 'kind', 'link-behaviour', 'link-type', 'milestone', 'practice', 'proposed-kind', 'question', 'responsibility', 'skill', 'stage', 'task', 'value-set', 'value-set-entry', 'work-span', 'workflow'];
      expect(row.policy).toBe(page.includes(name) ? 'page' : 'none');
      for (const relation of [...row.out, ...row.into]) expect(Object.hasOwn(CATALOG_RELATIONS, relation)).toBe(true);
    }
  });

  test('one concept is one kind: the tracker replaces four old rows and never adds a second kind for a moved one', () => {
    for (const merged of ['review-comment', 'review-approval', 'issue', 'workflow-definition']) expect(rows.has(merged)).toBe(false);
    // A defect is the ISTQB imperfection, not the tracker's work item: the two senses stay two kinds.
    expect(rows.get('defect')).toMatchObject({ group: 'testing.defect', id: 'istqb.defect' });
    expect(rows.get('comment')).toMatchObject({ group: 'common.attachment', id: 'practice.comment' });
    expect(rows.get('approval')).toMatchObject({ group: 'common.attachment', id: 'practice.approval' });
    expect(rows.get('task')).toMatchObject({ group: 'work.execution', id: 'practice.product-task', policy: 'page' });
    expect(rows.get('question')).toMatchObject({ group: 'work.coordination', id: 'practice.question', policy: 'page' });
    expect(rows.get('epic')?.group).toBe('work.planning');
    expect(rows.get('feature')?.group).toBe('work.planning');
    expect(rows.get('workflow')).toMatchObject({ group: 'common.schema', id: 'manifest.workflows' });
    // One defect kind holds a bug: the tracker's work item and the ISTQB imperfection were two kinds, and the bug is the defect.
    expect(rows.has('bug')).toBe(false);
    expect(rows.has('tracker-task')).toBe(false);
    // One time kind: time-entry, time-cost and lifecycle-step are one work span.
    for (const old of ['time-entry', 'time-cost', 'lifecycle-step']) expect(rows.has(old)).toBe(false);
    expect(rows.get('work-span')).toMatchObject({ group: 'work.execution', id: 'practice.work-span' });
    // One life cycle family: the state machine, its states and transitions; the manifest's statuses and transitions are those.
    for (const old of ['lifecycle', 'workflow-status', 'workflow-transition']) expect(rows.has(old)).toBe(false);
  });

  test('one work span holds what the time entry, the time cost and the life-cycle step recorded, and a review raises findings of its own', () => {
    const span = rows.get('work-span');
    expect(span).toBeDefined();
    for (const type of ['a person', 'an agent']) expect(span?.definition.includes(type)).toBe(true);
    expect(span?.sources.length).toBeGreaterThanOrEqual(2);
    expect(span?.sources.some((source) => source.includes('opentelemetry'))).toBe(true);
    // The external reference is a kind because the catalog has no other shared record for one.
    expect(rows.get('external-reference')).toMatchObject({ group: 'common.attachment', policy: 'none' });
  });

  test('a pending change is an approval package, and an approval is the decision on it', () => {
    const pack = rows.get('approval-package');
    expect(pack).toMatchObject({ group: 'common.attachment', id: 'practice.approval-package', policy: 'none' });
    for (const word of ['created or altered', 'links', 'risks', 'approve']) expect(pack?.definition.includes(word)).toBe(true);
    expect(rows.get('approval')?.definition).toContain('approval package');
    expect(rows.get('approval')?.definition).toContain('refused with a reason');
    expect(rows.get('approval')?.out).toContain('approves');
  });

  test('a kind that has states says so through the state machine that gives its life cycle, and an open question blocks rather than becoming a status', () => {
    // The manifest's own status and transition kinds became the state machine family: a machine whose `lifecycle_of` names a
    // kind is that kind's life cycle, and every state and transition of it belongs to the machine.
    const machine = rows.get('state-machine');
    expect(machine).toBeDefined();
    expect(machine?.definition).toContain('states');
    expect(machine?.id).toBe('uml.state-machine');
    expect(rows.get('state')?.id).toBe('uml.state');
    expect(rows.get('transition')?.id).toBe('uml.transition');
    for (const old of ['lifecycle', 'workflow-status', 'workflow-transition']) expect(rows.has(old)).toBe(false);
    expect(rows.get('question')?.definition).toContain('blocked');
    expect(rows.get('question')?.definition).toContain('without becoming a status');
    expect([...rows.keys()].filter((name) => name.endsWith('-status'))).toEqual([]);
  });

  test('the schema carries the manifest\'s own concepts as entities, and the proposal a person accepts or rejects', () => {
    for (const name of ['kind', 'field-set', 'link-type', 'link-behaviour', 'responsibility', 'accounting', 'workflow', 'proposed-kind']) {
      const row = rows.get(name);
      expect([name, row?.group]).toEqual([name, 'common.schema']);
      expect([name, (row?.sources.length ?? 0) > 0]).toEqual([name, true]);
    }
    expect(rows.get('responsibility')?.definition).toContain('who answers for');
    expect(rows.get('responsibility')?.definition).toContain('carries its work out');
    expect(rows.get('accounting')?.definition).toContain('work spans');
    expect(rows.get('proposed-kind')?.definition).toContain('accepts or rejects');
    expect(rows.get('proposed-kind')?.into).toContain('decides');
    expect(rows.get('task')?.definition).toContain('unit of work');
  });
});
