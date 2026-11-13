import { STARTER_PROBLEM_RULES } from './catalog-data-fixture.js';
import { DEFAULT_THRESHOLDS } from '../src/problems/types.js';
/**
 * The wiki section of the Problems page (madarch-m38l.19): the findings the
 * wiki already holds keep their meaning and gain the rule data — section,
 * Sonar kind, severity, stable id, place and action. Nothing is re-read here.
 */
import { describe, expect, test } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseOwner } from '../src/adapters/database-owner.js';
import { KINDS_FILE } from '../src/product/manifest/kinds.js';
import { listProblems } from '../src/loop/views.js';

import type { Resolution } from '../src/knowledge/resolve.js';
import { workingTreeFiles } from '../src/plugin/product-files.js';

const folder = (): string => mkdtempSync(join(tmpdir(), 'madarch-problems-wiki-'));
const resolve = async (): Promise<Resolution> => ({ state: 'ok', target: 'x', kind: 'entity', label: 'x', href: null });
const input = (productFolder: string, extra: Partial<Parameters<typeof listProblems>[0]> = {}) => ({
  productFolder, graph: { list: async () => ({ rows: [], next: null, total: 0 }) }, owner: {} as DatabaseOwner, files: workingTreeFiles(productFolder), manifest: { file: 'madarch/catalog.yaml', roles: new Map(), properties: new Map(), kinds: new Map(), declaredTemplates: [], groups: new Map(), excludeDocuments: [], ignoreBlocks: [], findings: [] }, resolve, findings: [], settings: { rules: Object.fromEntries(STARTER_PROBLEM_RULES.map(({ id, ...setting }) => [id, setting])), thresholds: { ...DEFAULT_THRESHOLDS } }, ...extra,
});

describe('the wiki section', () => {
  test('a manifest finding is its own rule: a bug for a person, on the manifest file a task can change', async () => {
    const listing = await listProblems(input(folder(), {
      findings: [{ file: KINDS_FILE, line: 8, message: 'kind "question": "group" names a group of "groups" but has the wrong shape, got "product"' }],
    }));
    expect(listing.problems).toHaveLength(1);
    expect(listing.problems[0]).toMatchObject({
      id: 'wiki.manifest\u0000madarch/catalog.yaml:8:manifest:kind "question": "group" names a group of "groups" but has the wrong shape, got "product"',
      section: 'wiki', rule: 'wiki.manifest', kind: 'manifest', sonar: 'bug', severity: 'major', fixer: 'person',
      file: KINDS_FILE, line: 8, scope: { type: 'file', path: KINDS_FILE }, place: { label: 'madarch/catalog.yaml:8', href: '/src?path=madarch%2Fcatalog.yaml&line=8' },
    });
    expect(listing.sections).toEqual({ code: 0, documents: 0, wiki: 1 });
  });

  test('an answer that reaches no page keeps its old kind and gains its rule', async () => {
    const listing = await listProblems(input(folder(), {
      unplaced: [{ kind: 'question', slug: 'discount', title: 'Which discount?', reason: 'the question names no page' }],
    }));
    const unplaced = listing.problems.find((problem) => problem.kind === 'unplaced')!;
    expect(unplaced).toMatchObject({ section: 'wiki', rule: 'wiki.unplaced', sonar: 'code-smell', severity: 'minor', fixer: 'person', place: { label: 'docs/questions/discount.md', href: '/src?path=docs%2Fquestions%2Fdiscount.md' } });
    expect(unplaced.entity).toMatchObject({ href: '/questions/discount', key: 'question:discount' });
  });

  
  });
