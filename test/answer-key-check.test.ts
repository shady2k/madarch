import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  buildAnswerKeyCheck,
  questionItems,
  readAnswerKey,
  readExpectedQuestions,
  reportText,
  thresholdLine,
  writeAnswerKeyCheck,
  type Classification,
  type EvidenceDocument,
  type EvidenceDocumentRef,
  type EvidenceQuestion,
  type EvidencePage,
  type EvidenceSource,
  type ResolvedPlace,
} from '../src/knowledge/answer-key-check.js';

interface FixturePage {
  readonly id: string;
  readonly kind: string;
  readonly title: string;
  readonly findings: readonly { readonly file: string; readonly line: number; readonly message: string }[];
  readonly notes: readonly string[];
  readonly blocks: readonly unknown[];
}

interface FixtureDocument {
  readonly repo: string | null;
  readonly path: string;
  readonly title: string;
  readonly markdown: string;
  readonly commit: string | null;
}

interface FixturePages {
  readonly pages: readonly FixturePage[];
  readonly documents: readonly FixtureDocument[];
  readonly questions: readonly EvidenceQuestion[];
}

class FixtureSource implements EvidenceSource {
  readonly productFolder = '/fixture/product';
  private readonly pages = new Map<string, FixturePage>();
  private readonly docs = new Map<string, FixtureDocument>();

  constructor(pages: FixturePages) {
    for (const page of pages.pages) this.pages.set(page.id, page);
    for (const document of pages.documents) this.docs.set(`${document.repo ?? ''}\u0000${document.path}`, document);
  }

  async documents(): Promise<readonly EvidenceDocumentRef[]> {
    return [...this.docs.values()].map((document) => ({ repo: document.repo, path: document.path, title: document.title }));
  }

  async resolvePlace(path: string): Promise<ResolvedPlace | undefined> {
    return { repo: 'fixture', fullPath: `/fixture/repo/${path}` };
  }

  expectedFullPath(path: string): string {
    return `/fixture/repo/${path}`;
  }

  isFinal(snapshot: string): boolean {
    return snapshot === 'snapshot-final';
  }

  async page(id: string): Promise<EvidencePage | undefined> {
    const page = this.pages.get(id);
    return page === undefined ? undefined : page as unknown as EvidencePage;
  }

  async document(repo: string | null, path: string): Promise<EvidenceDocument | undefined> {
    return this.docs.get(`${repo ?? ''}\u0000${path}`);
  }

  questions(): readonly EvidenceQuestion[] {
    return [];
  }
}

const fixture = (name: string): string => join(import.meta.dir, 'fixtures', 'answer-key-check', name);

async function fixtureCheck() {
  const key = readAnswerKey(fixture('answer-key.json'));
  const expected = readExpectedQuestions(fixture('questions.json'));
  const pages = JSON.parse(readFileSync(fixture('pages.json'), 'utf8')) as FixturePages;
  const source = new FixtureSource(pages);
  return await buildAnswerKeyCheck(source, key, expected, fixture('answer-key.json'));
}

function byId(check: Awaited<ReturnType<typeof fixtureCheck>>, id: string) {
  const item = check.items.find((one) => one.item.id === id);
  if (item === undefined) throw new Error(`fixture check has no ${id}`);
  return item;
}

describe('answer-key check evidence packs', () => {
  test('decides fully, partly, none and unsure from structured evidence', async () => {
    const check = await fixtureCheck();
    const classifications = Object.fromEntries(check.items.map((item) => [item.item.id, item.classification])) as Record<string, Classification>;
    expect(classifications['fixture.full']).toBe('fully');
    expect(classifications['fixture.partly']).toBe('partly');
    expect(classifications['fixture.none']).toBe('none');
    expect(classifications['fixture.unsure']).toBe('unsure');
    expect(classifications['open.fixture']).toBe('unsure');
    expect(check.counts).toEqual({ fully: 1, partly: 1, none: 1, unsure: 2 });
  });

  test('fully keeps the exact source passage and its line', async () => {
    const check = await fixtureCheck();
    const full = byId(check, 'fixture.full');
    expect(full.reason).toBe('required-elements-and-links-present');
    expect(full.checks.mustShowMissing).toEqual([]);
    expect(full.checks.mustLinkMatched).toEqual(['src/alpha.ts']);
    expect(full.locations[0]?.present).toBe(true);
    expect(full.locations[0]?.found).toBe(true);
    expect(full.passages.some((passage) => passage.line === 1 && passage.text.includes('const value = 1;'))).toBe(true);
  });

  test('partly names the location with no page and its full path', async () => {
    const check = await fixtureCheck();
    const partly = byId(check, 'fixture.partly');
    expect(partly.reason).toBe('some-locations-have-no-page');
    expect(partly.checks.locationsPresent).toBe(1);
    expect(partly.checks.locationsTotal).toBe(2);
    expect(partly.locations[1]?.error).toEqual({
      file: 'src/missing.ts',
      line: 1,
      fullPath: '/fixture/repo/src/missing.ts',
      message: 'the wiki has no page for src/missing.ts at snapshot-final',
    });
  });

  test('none means no location has a page, not that no phrase matched', async () => {
    const check = await fixtureCheck();
    const none = byId(check, 'fixture.none');
    expect(none.reason).toBe('no-location-has-a-page');
    expect(none.checks.locationsPresent).toBe(0);
    expect(none.checks.mustShowMissing).toEqual(['nothing']);
  });

  test('unsure is written out for the later reader instead of being called a pass', async () => {
    const check = await fixtureCheck();
    const unsure = byId(check, 'fixture.unsure');
    expect(unsure.reason).toBe('semantic-reading-needed');
    expect(unsure.checks.mustShowMissing).toEqual(['Beta is described on another page.']);
    expect(unsure.expectedQuestions).toBeUndefined();
  });

  test('the open item carries the explicit expected question source without claiming a pair', async () => {
    const check = await fixtureCheck();
    const open = byId(check, 'open.fixture');
    expect(open.reason).toBe('expected-question-needs-a-reader');
    expect(open.expectedQuestions).toEqual([{ type: 'contradiction', subject: 'Which value is authoritative?', file: 'docs/alpha.md' }]);
    expect(check.seam.mainKeyOpenItems).toBe(1);
    expect(check.seam.expectedQuestionCount).toBe(1);
    expect(check.seam.questionsMatched).toBe('unsure');
    expect(check.seam.problems[0]).toContain('not the milestone');
  });

  test('writes packs, the unsure file and a report without gating', async () => {
    const check = await fixtureCheck();
    const out = mkdtempSync(join(tmpdir(), 'answer-key-check-'));
    try {
      const written = writeAnswerKeyCheck(check, out);
      const packs = JSON.parse(readFileSync(written.packs, 'utf8'));
      const unsure = JSON.parse(readFileSync(written.unsure, 'utf8'));
      const report = JSON.parse(readFileSync(written.report, 'utf8'));
      expect(packs.items).toHaveLength(5);
      expect(unsure.items.map((item: { item: { id: string } }) => item.item.id)).toEqual(['fixture.unsure', 'open.fixture']);
      expect(report.gate).toBe('reported-only');
      expect(report.thresholdMet).toBe(false);
      expect(report.questions.expected).toHaveLength(1);
      expect(reportText(check)).toContain('threshold (computed, not gated)');
      expect(thresholdLine(check)).toContain('fully 1/5 = 20.0%');
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });
});

describe('answer-key read errors', () => {
  test('name the file, the line and the full path', () => {
    const out = mkdtempSync(join(tmpdir(), 'answer-key-error-'));
    try {
      const file = join(out, 'broken.json');
      writeFileSync(file, '{"snapshots":{},"items":4}\n');
      let message = '';
      try {
        readAnswerKey(file);
      } catch (error) {
        message = String(error);
      }
      expect(message).toContain(`${file}:1:`);
      expect(message).toContain(`full path ${file}`);
      expect(message).toContain('items must be an array');
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });
});

describe('the committed answer keys', () => {
  const root = resolve(import.meta.dir, '..');

  test('the main key has eight open items and the agent-stage key has the eight explicit questions', () => {
    const main = readAnswerKey(resolve(root, 'examples/training-repository/answer-key.json'));
    const questions = readExpectedQuestions(resolve(root, 'examples/training-repository/agent-stage/answer-key.json'));
    expect(questionItems(main)).toHaveLength(8);
    expect(questions.questions).toHaveLength(8);
    expect(questionItems(main).every((item) => item.id.startsWith('open.'))).toBe(true);
    for (const question of questions.questions) {
      expect(question.type).not.toBe('');
      expect(question.subject).not.toBe('');
      expect(question.file).not.toBe('');
    }
    const raw = JSON.parse(readFileSync(resolve(root, 'examples/training-repository/answer-key.json'), 'utf8')) as Record<string, unknown>;
    expect(Object.hasOwn(raw, 'expectedOpenQuestions')).toBe(false);
  });
});
