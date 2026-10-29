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
import { KINDS_FILE } from '../src/knowledge/kinds.js';
import { listProblems } from '../src/loop/views.js';
import { starterProblemSettings } from '../src/knowledge/seed.js';
import type { Resolution } from '../src/knowledge/resolve.js';

const folder = (): string => mkdtempSync(join(tmpdir(), 'madarch-problems-wiki-'));
const resolve = async (): Promise<Resolution> => ({ state: 'ok', target: 'x', kind: 'entity', label: 'x', href: null });
const input = (productFolder: string, extra: Partial<Parameters<typeof listProblems>[0]> = {}) => ({
  productFolder, owner: {} as DatabaseOwner, resolve, findings: [], settings: starterProblemSettings(), ...extra,
});

describe('the wiki section', () => {
  test('a manifest finding is its own rule: a bug for a person, on the manifest file a task can change', async () => {
    const listing = await listProblems(input(folder(), {
      findings: [{ file: KINDS_FILE, line: 8, message: 'kind "question": "group" names a group of "groups" but has the wrong shape, got "product"' }],
    }));
    expect(listing.problems).toHaveLength(1);
    expect(listing.problems[0]).toMatchObject({
      id: 'wiki.manifest\u0000madarch/kinds.yaml:8:manifest:kind "question": "group" names a group of "groups" but has the wrong shape, got "product"',
      section: 'wiki', rule: 'wiki.manifest', kind: 'manifest', sonar: 'bug', severity: 'major', fixer: 'person',
      file: KINDS_FILE, line: 8, scope: { type: 'file', path: KINDS_FILE }, place: { label: 'madarch/kinds.yaml:8', href: '/k/src?path=madarch%2Fkinds.yaml&line=8' },
    });
    expect(listing.sections).toEqual({ code: 0, documents: 0, wiki: 1 });
  });

  test('a passage no reader decided and an answer that reaches no page keep their old kinds and gain their rules', async () => {
    const listing = await listProblems(input(folder(), {
      findings: [{ file: 'repos/shop/docs/notes.md', line: 4, message: 'no kind read this passage', kind: 'unread-passage', source: '/srv/checkouts/shop/docs/notes.md' }],
      unplaced: [{ kind: 'question', slug: 'discount', title: 'Which discount?', reason: 'the question names no page' }],
    }));
    const passage = listing.problems.find((problem) => problem.kind === 'unread-passage')!;
    expect(passage).toMatchObject({ section: 'wiki', rule: 'wiki.unread-passage', sonar: 'code-smell', severity: 'minor', fixer: 'agent', line: 4, source: '/srv/checkouts/shop/docs/notes.md' });
    const unplaced = listing.problems.find((problem) => problem.kind === 'unplaced')!;
    expect(unplaced).toMatchObject({ section: 'wiki', rule: 'wiki.unplaced', sonar: 'code-smell', severity: 'minor', fixer: 'person', place: { label: 'docs/questions/discount.md', href: '/k/src?path=docs%2Fquestions%2Fdiscount.md' } });
    expect(unplaced.entity).toMatchObject({ href: '/k/questions/discount', key: 'question:discount' });
  });

  test('a dismissal leaves a problem out and is counted; the manifest can lower a wiki rule\'s severity', async () => {
    const first = await listProblems(input(folder(), { findings: [{ file: KINDS_FILE, line: 8, message: 'bad kind' }] }));
    const id = first.problems[0]!.id;
    const dismissed = await listProblems(input(first.problems.length === 1 ? folder() : '', { findings: [{ file: KINDS_FILE, line: 8, message: 'bad kind' }], dismissed: new Set([id]) }));
    expect(dismissed.problems).toEqual([]);
    expect(dismissed.dismissed).toBe(1);
    const lowered = await listProblems(input(folder(), {
      findings: [{ file: KINDS_FILE, line: 8, message: 'bad kind' }], settings: { ...starterProblemSettings(), rules: { ...starterProblemSettings().rules, 'wiki.manifest': { ...starterProblemSettings().rules['wiki.manifest']!, severity: 'info' } } },
    }));
    expect(lowered.problems[0]!.severity).toBe('info');
  });

  test('a rule the manifest switches off is not listed, and the rest of the page is kept', async () => {
    const manifest = starterProblemSettings();
    const disabled = { ...manifest, rules: { ...manifest.rules, 'wiki.manifest': { ...manifest.rules['wiki.manifest']!, enabled: false } } };
    const listing = await listProblems(input(folder(), {
      findings: [{ file: KINDS_FILE, line: 8, message: 'bad kind' }], settings: disabled,
    }));
    expect(listing.problems).toEqual([]);
    expect(listing.sections).toEqual({ code: 0, documents: 0, wiki: 0 });
  });
});
