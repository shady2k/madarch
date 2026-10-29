import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  buildAnswerKeyCheck,
  matchedQuestionCount,
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
  readonly questions?: readonly EvidenceQuestion[];
}

class FixtureSource implements EvidenceSource {
  readonly productFolder = '/fixture/product';
  private readonly pages = new Map<string, FixturePage>();
  private readonly docs = new Map<string, FixtureDocument>();
  private readonly questionRows: readonly EvidenceQuestion[];

  constructor(pages: FixturePages) {
    for (const page of pages.pages) this.pages.set(page.id, page);
    for (const document of pages.documents) this.docs.set(`${document.repo ?? ''}\u0000${document.path}`, document);
    this.questionRows = pages.questions ?? [];
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
    return this.questionRows;
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
  test('states only what it can prove and leaves every verdict to the judge', async () => {
    const check = await fixtureCheck();
    // A word match gathers evidence; it never decides that the wiki answers an item, so the layer above the
    // judge never says fully, partly or none (madarch-j6ho.2, review findings 1 and 2).
    expect(check.items.every((item) => item.classification === 'unsure')).toBe(true);
    expect(check.items.map((item) => [item.item.id, item.reason])).toEqual([
      ['fixture.full', 'required-elements-and-links-present'],
      ['fixture.partly', 'some-locations-have-no-page'],
      ['fixture.none', 'no-location-has-a-page'],
      ['fixture.unsure', 'semantic-reading-needed'],
      ['open.fixture', 'expected-question-needs-a-reader'],
      ['fixture.negation', 'required-elements-and-links-present'],
      ['fixture.elsewhere', 'evidence-elsewhere-needs-a-reader'],
    ]);
    expect(check.counts).toEqual({ fully: 0, partly: 0, none: 0, unsure: 7 });
  });

  test('the structural facts are named without calling the item fully', async () => {
    const check = await fixtureCheck();
    const full = byId(check, 'fixture.full');
    expect(full.classification).toBe('unsure');
    expect(full.reason).toBe('required-elements-and-links-present');
    expect(full.checks.mustShowMissing).toEqual([]);
    expect(full.checks.mustLinkMatched).toEqual(['src/alpha.ts']);
    expect(full.locations[0]?.present).toBe(true);
    expect(full.locations[0]?.found).toBe(true);
    expect(full.passages.some((passage) => passage.line === 1 && passage.text.includes('const value = 1;'))).toBe(true);
  });

  test('a page that says «send has no retry and no timeout» is not fully answered by the word match', async () => {
    const check = await fixtureCheck();
    const negation = byId(check, 'fixture.negation');
    // Every mustShow word is on the page, which is exactly why the words alone cannot decide the meaning.
    expect(negation.checks.mustShowMatched).toEqual(['retry', 'timeout']);
    expect(negation.checks.mustShowMissing).toEqual([]);
    expect(negation.classification).toBe('unsure');
    expect(negation.reason).toBe('required-elements-and-links-present');
    // The sentence a judge must read travels in the pack.
    expect(negation.passages.some((passage) => passage.text.includes('send has no retry and no timeout.'))).toBe(true);
  });

  test('a missing page at the location is not none: the wiki is searched and the judge reads what it finds', async () => {
    const check = await fixtureCheck();
    const elsewhere = byId(check, 'fixture.elsewhere');
    expect(elsewhere.checks.locationsPresent).toBe(0);
    expect(elsewhere.classification).toBe('unsure');
    expect(elsewhere.reason).toBe('evidence-elsewhere-needs-a-reader');
    // The product's own page answers the item completely, and it is evidence the judge can quote.
    expect(elsewhere.elsewhere.map((passage) => passage.page)).toEqual(['document:fixture:docs/product.md']);
    expect(elsewhere.elsewhere.some((passage) => passage.text.includes('The worker retries every job.'))).toBe(true);
    expect(elsewhere.elsewhere.every((passage) => elsewhere.passages.some((held) => held.id === passage.id))).toBe(true);
  });

  test('partly names the location with no page and its full path', async () => {
    const check = await fixtureCheck();
    const partly = byId(check, 'fixture.partly');
    expect(partly.classification).toBe('unsure');
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

  test('a missing page with nothing anywhere in the wiki stays unsure, never none', async () => {
    const check = await fixtureCheck();
    const none = byId(check, 'fixture.none');
    expect(none.classification).toBe('unsure');
    expect(none.reason).toBe('no-location-has-a-page');
    expect(none.checks.locationsPresent).toBe(0);
    expect(none.checks.mustShowMissing).toEqual(['nothing']);
    expect(none.elsewhere).toEqual([]);
  });

  test('unsure is written out for the later reader instead of being called a pass', async () => {
    const check = await fixtureCheck();
    const unsure = byId(check, 'fixture.unsure');
    expect(unsure.reason).toBe('semantic-reading-needed');
    expect(unsure.checks.mustShowMissing).toEqual(['Beta is described on another page.']);
    // The expected questions and the product's question pages travel with every pack, not only the open.* ones,
    // so a judge reading an ordinary item can see whether the eight were asked (madarch-j6ho.2, finding 5).
    expect(unsure.expectedQuestions).toEqual([{ type: 'contradiction', subject: 'Which value is authoritative?', file: 'docs/alpha.md' }]);
    expect(unsure.currentQuestions).toEqual([{ slug: 'which-value', id: 'question:which-value', title: 'Which value is authoritative?', type: 'contradiction', state: 'open', about: ['docs/alpha.md'] }]);
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

  test('the eight expected questions are checked against actual question pages, not against a list of eight', () => {
    const expected = Array.from({ length: 8 }, (_, index) => ({ type: 'contradiction', subject: `Question ${index}?`, file: `docs/q${index}.md` }));
    const unrelated = Array.from({ length: 8 }, (_, index) => ({ slug: `other-${index}`, id: `question:other-${index}`, title: `An unrelated matter ${index}`, type: 'contradiction', state: 'open', about: [] }));
    const pages = expected.map((question, index) => ({ slug: `q${index}`, id: `question:q${index}`, title: question.subject, type: question.type, state: 'open', about: [question.file] }));
    // Eight pages of the right length are not eight answers to the questions that were asked.
    expect(matchedQuestionCount(expected, unrelated)).toBe(0);
    expect(matchedQuestionCount(expected, pages)).toBe(8);
    // The kind is part of the correspondence: the same words under another kind are not the same question.
    expect(matchedQuestionCount(expected, pages.map((page) => ({ ...page, type: 'term' })))).toBe(0);
    expect(matchedQuestionCount(expected, pages.slice(0, 7))).toBe(7);
  });

  test('the fixture’s one expected question corresponds to the product’s one question page', async () => {
    const check = await fixtureCheck();
    expect(check.questions.matched).toBe(1);
    expect(thresholdLine(check)).toContain('expected questions matched to question pages: 1 of 1');
  });

  test('writes packs, the unsure file and a report without gating', async () => {
    const check = await fixtureCheck();
    const out = mkdtempSync(join(tmpdir(), 'answer-key-check-'));
    try {
      const written = writeAnswerKeyCheck(check, out);
      const packs = JSON.parse(readFileSync(written.packs, 'utf8'));
      const unsure = JSON.parse(readFileSync(written.unsure, 'utf8'));
      const report = JSON.parse(readFileSync(written.report, 'utf8'));
      expect(packs.items).toHaveLength(7);
      expect(unsure.items.map((item: { item: { id: string } }) => item.item.id)).toEqual(['fixture.full', 'fixture.partly', 'fixture.none', 'fixture.unsure', 'open.fixture', 'fixture.negation', 'fixture.elsewhere']);
      expect(report.gate).toBe('reported-only');
      expect(report.thresholdMet).toBe(false);
      expect(report.questions.expected).toHaveLength(1);
      expect(reportText(check)).toContain('threshold (computed, not gated)');
      expect(thresholdLine(check)).toContain('fully 0/7 = 0.0%');
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
