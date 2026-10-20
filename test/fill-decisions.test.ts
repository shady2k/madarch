/**
 * A person's decisions as Markdown in the product's git (the self-filling charter's
 * outcome 5; decision 0026, "Pages": "a person's edits and answers are git as well").
 *
 * What is held here is the contract the wiki writes and the graph reads back: an answer
 * names the question it closes, an acceptance names the page it decides about and what
 * was decided, both are dated and signed, and the person's own Markdown stands under the
 * words' heading **unchanged** — including headings of their own. A file that is neither
 * is refused where it stands, with its full path and 1-based line, and nothing is
 * guessed.
 */
import { describe, expect, test } from 'bun:test';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ACCEPTANCES_FOLDER,
  ANSWERS_FOLDER,
  answerDocument,
  acceptanceDocument,
  decisionFile,
  discardDecision,
  parseDecisionDocument,
  readDecisions,
  stageDecision,
  writeDecision,
} from '../src/fill/decisions.js';

const QUESTION = `question:${'1'.repeat(64)}`;
const PAGE = `module:${'2'.repeat(64)}`;
const AT = '2026-10-20T07:09:19Z';
const BY = 'a reader of the wiki';

/** A scratch product folder, made and removed by the test. */
function product(): { readonly folder: string; close(): void } {
  const folder = mkdtempSync(join(tmpdir(), 'madarch-decisions-'));
  return { folder, close: () => rmSync(folder, { recursive: true, force: true }) };
}

describe('the decision documents the wiki writes', () => {
  test('an answer names its question, is dated and signed, and carries the person\'s Markdown as written', () => {
    const text = answerDocument({ subject: QUESTION, prompt: 'Is an order placed at authorization or at capture?', text: 'At authorization.\n\n## Why\n\n`place()` is called before capture.', by: BY, at: AT });
    expect(text).toBe([
      '# Answer: Is an order placed at authorization or at capture?',
      '',
      `Question: ${QUESTION}`,
      `Decided: ${AT}`,
      `By: ${BY}`,
      '',
      '## Question',
      '',
      'Is an order placed at authorization or at capture?',
      '',
      '## Answer',
      '',
      'At authorization.',
      '',
      '## Why',
      '',
      '`place()` is called before capture.',
      '',
    ].join('\n'));
    const read = parseDecisionDocument('/tmp/x.md', text, 'answers/x.md');
    expect(read.ok).toBe(true);
    if (read.ok === false) return;
    expect(read.record).toEqual({ kind: 'answer', subject: QUESTION, text: 'At authorization.\n\n## Why\n\n`place()` is called before capture.', by: BY, at: AT, file: 'answers/x.md' });
  });

  test('an acceptance says which page and what was decided, and its note may be empty', () => {
    const text = acceptanceDocument({ subject: PAGE, label: 'checkout', verdict: 'rejected', note: '', by: BY, at: AT });
    expect(text).toContain(`Page: ${PAGE}`);
    expect(text).toContain('Verdict: rejected');
    const read = parseDecisionDocument('/tmp/x.md', text, 'acceptances/x.md');
    expect(read.ok).toBe(true);
    if (read.ok === false) return;
    expect(read.record).toEqual({ kind: 'acceptance', subject: PAGE, verdict: 'rejected', note: '', by: BY, at: AT, file: 'acceptances/x.md' });
  });

  test('a file that is no decision is refused at its own path and line, and a field named twice is no field', () => {
    const other = parseDecisionDocument('/tmp/product/answers/a.md', '# Something else\n', 'answers/a.md');
    expect(other.ok).toBe(false);
    if (other.ok) return;
    expect(other.problems).toEqual([{ file: '/tmp/product/answers/a.md', line: 1, message: 'a decision document opens with "# Answer: <the question>" or "# Acceptance: <the page>", not "# Something else"' }]);

    const twice = parseDecisionDocument('/tmp/p/answers/b.md', `# Answer: x\n\nQuestion: ${QUESTION}\nQuestion: ${QUESTION}\nDecided: ${AT}\nBy: ${BY}\n\n## Answer\n\n` + 'the card is authorized first', 'answers/b.md');
    expect(twice.ok).toBe(false);
    if (twice.ok) return;
    expect(twice.problems).toEqual([{ file: '/tmp/p/answers/b.md', line: 4, message: '"Question" is named twice: a decision document names each of its fields once' }]);

    // An empty answer closes nothing: the words' heading is there and the person wrote nothing.
    const empty = parseDecisionDocument('/tmp/p/answers/c.md', `# Answer: x\n\nQuestion: ${QUESTION}\nDecided: ${AT}\nBy: ${BY}\n\n## Answer\n`, 'answers/c.md');
    expect(empty.ok).toBe(false);
    if (empty.ok) return;
    expect(empty.problems.map((problem) => problem.line)).toEqual([7]);
  });

  test('a question is named by a fact id and a moment by an ISO time: neither is invented from a near miss', () => {
    const bad = parseDecisionDocument('/tmp/p/answers/d.md', '# Answer: x\n\nQuestion: QST-1\nDecided: yesterday\nBy: \n\n## Answer\n\nok', 'answers/d.md');
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    expect(bad.problems.map((problem) => [problem.line, problem.message])).toEqual([
      [3, '"Question" names "QST-1", which is no fact id: a question is named by its own fact id, a kind, a colon and 64 lower-case hexadecimal digits'],
      [4, '"Decided" names "yesterday", which is no moment: a decision is dated as 2026-10-20T07:09:19Z'],
      [1, 'an answer says who wrote it, in a "By: <who>" line'],
    ]);
    const verdict = parseDecisionDocument('/tmp/p/acceptances/e.md', `# Acceptance: x\n\nPage: ${PAGE}\nVerdict: maybe\nDecided: ${AT}\nBy: ${BY}\n`, 'acceptances/e.md');
    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.problems).toEqual([{ file: '/tmp/p/acceptances/e.md', line: 4, message: '"Verdict" is "maybe": a person accepts a page or rejects it, so the verdict is one of accepted, rejected' }]);
  });
});

describe('the product\'s git holds the decisions, one file per decided node', () => {
  test('a write lands whole at the path the record names and is read back as written', () => {
    const made = product();
    try {
      const relative = writeDecision(made.folder, ANSWERS_FOLDER, QUESTION, answerDocument({ subject: QUESTION, prompt: 'Why?', text: 'Because the card is captured last.', by: BY, at: AT }));
      expect(relative).toBe(`answers/${'1'.repeat(64)}.md`);
      expect(readFileSync(join(made.folder, relative), 'utf8')).toContain('Because the card is captured last.');
      writeDecision(made.folder, ACCEPTANCES_FOLDER, PAGE, acceptanceDocument({ subject: PAGE, label: 'checkout', verdict: 'accepted', note: 'the boundary is right', by: BY, at: AT }));
      const read = readDecisions(made.folder);
      expect(read.problems).toEqual([]);
      expect(read.records.map((record) => [record.kind, record.subject])).toEqual([['acceptance', PAGE], ['answer', QUESTION]]);
      // A file the folders hold that is no decision document is a problem with its path, never a record nobody wrote.
      writeFileSync(join(made.folder, ANSWERS_FOLDER, 'notes.md'), 'a scribble\n');
      const withStray = readDecisions(made.folder);
      expect(withStray.problems.map((problem) => [problem.file, problem.line])).toEqual([[join(made.folder, ANSWERS_FOLDER, 'notes.md'), 1]]);
      // A staged decision that is dropped writes nothing: the document already at its path stands as it was.
      const staged = stageDecision(made.folder, ANSWERS_FOLDER, QUESTION, answerDocument({ subject: QUESTION, prompt: 'Why?', text: 'A second answer nobody committed.', by: BY, at: AT }));
      expect(readFileSync(join(made.folder, staged.file), 'utf8')).toContain('Because the card is captured last.');
      discardDecision(staged);
      // The committed answer and the acceptance stand; the staged one wrote nothing.
      expect(readDecisions(made.folder).records.map((record) => [record.kind, record.kind === 'answer' ? record.text : ''])).toEqual([['acceptance', ''], ['answer', 'Because the card is captured last.']]);
    } finally {
      made.close();
    }
  });

  test('a product that answered nothing holds no decisions, and a folder nobody wrote is not a problem', () => {
    const made = product();
    try {
      expect(readDecisions(made.folder)).toEqual({ records: [], problems: [] });
      mkdirSync(join(made.folder, ANSWERS_FOLDER));
      expect(readDecisions(made.folder)).toEqual({ records: [], problems: [] });
    } finally {
      made.close();
    }
  });

  test('a decision file\'s name is the node\'s digest: one name per decision, and no colon a filesystem refuses', () => {
    expect(decisionFile(ANSWERS_FOLDER, QUESTION)).toBe(`answers/${'1'.repeat(64)}.md`);
    expect(() => decisionFile(ANSWERS_FOLDER, 'QST-1')).toThrow('src/fill/decisions.ts: the decision of "QST-1" has no file: a decision is about a node of the graph, named by its fact id');
  });
});
