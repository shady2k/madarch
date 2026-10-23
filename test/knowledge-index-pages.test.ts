/**
 * The pure half of the Markdown index (madarch-m38l.8): a page read into its
 * statements, grounds and mentions; a document read into the sections a
 * ground may name. No graph, no git.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, test } from 'bun:test';
import { indexProductMarkdown, readKnowledgePages } from '../src/knowledge/index/index.js';
import { PageReadError, readIndexedPage } from '../src/knowledge/index/page.js';
import { documentSections } from '../src/knowledge/index/sections.js';
import { documentAnchors } from '../src/writer/view.js';

const sha = (text: string): string => `sha:${text.length}`;
const COMMIT = '0123456789abcdef0123456789abcdef01234567';

const PAGE = `---
id: domain:payments
kind: domain
title: Payments
relates:
  - code.service:payments
producer: agent
sources: [docs/requirements.md]
written-at:
  - repository: training
    commit: ${COMMIT.toUpperCase()}
    branch: main
    origin: git@github.com:acme/shop.git
---
## How payments work

Payments are charged by the [payments service](madarch:code.service:payments).[^charge-by-service] A refund is checked first, e.g. against the captured total.[^refund-check]

- Refunds must happen within 14 days.[^refund-window][^refund-policy]

See also [ordering](madarch:domain:ordering).

[^charge-by-service]: [payments](madarch:code.service:payments), [UC-2](madarch:doc:docs/requirements.md#uc-2)
[^refund-check]: [BR-4](madarch:doc:docs/requirements.md#br-4)
[^refund-window]: [BR-4](madarch:doc:docs/requirements.md#br-4)
[^refund-policy]: [refund](madarch:code.symbol\u003asrc/refund.ts#refund)
`;

describe('readIndexedPage', () => {
  const page = readIndexedPage('docs/domains/payments.md', PAGE, sha);

  test('front matter: identity, relations, sources and the basis of the page', () => {
    expect(page.id).toBe('domain:payments');
    expect(page.kind).toBe('domain');
    expect(page.relates).toEqual(['code.service:payments']);
    expect(page.sources).toEqual(['docs/requirements.md']);
    expect(page.writtenAt).toEqual([{ repository: 'training', commit: COMMIT, branch: 'main', origin: 'git@github.com:acme/shop.git' }]);
  });

  test('every grounded sentence is one statement named by its footnote', () => {
    expect(page.statements.map((s) => s.id)).toEqual(['charge-by-service', 'refund-check', 'refund-window']);
    expect(page.statements[0]!.text).toBe('Payments are charged by the payments service.');
    // the "e.g." dot does not end the sentence
    expect(page.statements[1]!.text).toBe('A refund is checked first, e.g. against the captured total.');
  });

  test('a sentence with two footnotes is one statement with the grounds of both, named by the first', () => {
    const window = page.statements.find((s) => s.id === 'refund-window')!;
    expect(window.labels).toEqual(['refund-window', 'refund-policy']);
    expect(window.grounds).toEqual(['doc:docs/requirements.md#br-4', 'code.symbol\u003asrc/refund.ts#refund']);
  });

  test('grounds and mentions are separate: the mention is a link in the text, the ground is a link in the footnote', () => {
    expect(page.statements[0]!.grounds).toEqual(['code.service:payments', 'doc:docs/requirements.md#uc-2']);
    expect(page.statements[0]!.mentions).toEqual(['code.service:payments']);
    expect(page.statements[1]!.mentions).toEqual([]);
    expect(page.mentions).toEqual(['code.service:payments', 'domain:ordering']);
  });

  test('a connecting line is no statement', () => {
    expect(page.statements.some((s) => s.text.startsWith('See also'))).toBe(false);
  });

  test('a label several sentences share names the first, and the others from "~2"', () => {
    const shared = readIndexedPage('docs/product.md', '---\nid: product:shop\nkind: product\n---\nOne thing is true.[^1] Another thing is true.[^1]\n\n[^1]: [x](madarch:code.service:a)\n', sha);
    expect(shared.statements.map((s) => s.id)).toEqual(['1', '1~2']);
  });

  test('numbered footnotes of an older page stay readable', () => {
    const old = readIndexedPage('docs/product.md', '---\nid: product:shop\nkind: product\n---\nFirst claim here.[^1]\n\nSecond claim here.[^2]\n\n[^1]: [x](madarch:code.service:a)\n[^2]: [y](madarch:code.service:b)\n', sha);
    expect(old.statements.map((s) => [s.id, s.grounds])).toEqual([['1', ['code.service:a']], ['2', ['code.service:b']]]);
  });
});

describe('readIndexedPage keeps the punctuation it masked to find sentence ends', () => {
  test('a "!" or "?" in a code span or a link target is not turned into a dot', () => {
    const page = readIndexedPage('docs/x.md', '---\nid: a:b\nkind: a\n---\nCall `run!` and `ask?` to start.[^calls] The [alias](madarch:code.symbol\u003asrc/x.ts#run!) is kept.[^alias]\n\n[^calls]: [x](madarch:code.service:a)\n[^alias]: [y](madarch:code.symbol\u003asrc/x.ts#run!)\n', sha);
    expect(page.statements.map((s) => s.text)).toEqual(['Call run! and ask? to start.', 'The alias is kept.']);
    expect(page.statements[1]!.mentions).toEqual(['code.symbol\u003asrc/x.ts#run!']);
    expect(page.statements[1]!.grounds).toEqual(['code.symbol\u003asrc/x.ts#run!']);
  });
});

describe('readIndexedPage refuses what it cannot read, naming file and line', () => {
  const cases: [string, string, string][] = [
    ['no front matter', 'just text\n', 'docs/x.md:1:'],
    ['broken yaml', '---\nid: [\n---\nbody\n', 'docs/x.md:2:'],
    ['no id', '---\nkind: domain\n---\nbody\n', 'docs/x.md:2:'],
    ['written-at not a list', '---\nid: a:b\nkind: a\nwritten-at: now\n---\nbody\n', 'docs/x.md:2:'],
    ['written-at without commit', '---\nid: a:b\nkind: a\nwritten-at:\n  - repository: r\n---\nbody\n', 'docs/x.md:2:'],
    ['written-at with a bad commit', '---\nid: a:b\nkind: a\nwritten-at:\n  - { repository: r, commit: HEAD }\n---\nbody\n', 'docs/x.md:2:'],
  ];
  for (const [name, text, prefix] of cases) {
    test(name, () => {
      let error: unknown;
      try { readIndexedPage('docs/x.md', text, sha); } catch (caught) { error = caught; }
      expect(error).toBeInstanceOf(PageReadError);
      expect((error as Error).message.startsWith(prefix)).toBe(true);
    });
  }
});

const DOC = `# Requirements

## UC-2 Pay for an order
The shopper pays.

### Steps
Charge the card.

## BR-4 Refund window
- **Refund window.** Refunds within 14 days.
  More words of the item.
- **Other rule.** Something else.

## Later
Text.
`;

describe('documentSections', () => {
  const sections = documentSections(DOC);
  const text = (anchor: string): string | undefined => sections.find((s) => s.anchor === anchor)?.text;

  test('the anchors are exactly those a ground may name', () => {
    expect(sections.map((s) => s.anchor)).toEqual(documentAnchors(DOC));
  });

  test('a heading section runs to the next heading of the same or a higher level', () => {
    expect(text('uc-2-pay-for-an-order')).toBe('## UC-2 Pay for an order\nThe shopper pays.\n\n### Steps\nCharge the card.');
    expect(text('uc-2')).toBe(text('uc-2-pay-for-an-order'));
    expect(text('steps')).toBe('### Steps\nCharge the card.');
  });

  test('a bold list item is its own section with its continuation lines', () => {
    expect(text('refund-window')).toBe('- **Refund window.** Refunds within 14 days.\n  More words of the item.');
    expect(text('other-rule')).toBe('- **Other rule.** Something else.');
  });

  test('a list item holds the items nested under it, so a change below it changes it', () => {
    const nested = '- **Parent rule.** Parent text.\n  - **Child rule.** Child text.\n  - Plain child.\n- **Sibling rule.** Sibling.\n';
    const sections = documentSections(nested);
    expect(sections.find((s) => s.anchor === 'parent-rule')!.text).toBe('- **Parent rule.** Parent text.\n  - **Child rule.** Child text.\n  - Plain child.');
    expect(sections.find((s) => s.anchor === 'child-rule')!.text).toBe('  - **Child rule.** Child text.');
    expect(sections.find((s) => s.anchor === 'sibling-rule')!.text).toBe('- **Sibling rule.** Sibling.');
  });

  test('a change inside one section changes that section only', () => {
    const changed = documentSections(DOC.replace('Charge the card.', 'Charge the card twice.'));
    const diff = (a: string): boolean => changed.find((s) => s.anchor === a)?.text !== text(a);
    expect(diff('steps')).toBe(true);
    expect(diff('uc-2')).toBe(true); // the parent contains it
    expect(diff('later')).toBe(false);
    expect(diff('refund-window')).toBe(false);
  });
});

describe('readKnowledgePages and indexProductMarkdown refuse a product they cannot read whole', () => {
  const folder = (): string => mkdtempSync(path.join(tmpdir(), 'madarch-index-product-'));
  const write = (root: string, file: string, text: string): void => {
    mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    writeFileSync(path.join(root, file), text);
  };
  const KINDS = 'kinds:\n  domain: { template: templates/domain.md, source: markdown, folder: docs/domains }\n';
  const PAGE_TEXT = '---\nid: domain:payments\nkind: domain\ntitle: Payments\n---\nPayments are charged here.[^charged-here]\n\n[^charged-here]: [x](madarch:code.service:payments)\n';

  test('a product with its manifest and a page reads one page and no finding', () => {
    const root = folder();
    try {
      write(root, 'madarch/kinds.yaml', KINDS);
      write(root, 'templates/domain.md', ':::body\n');
      write(root, 'docs/domains/payments.md', PAGE_TEXT);
      const read = readKnowledgePages(root);
      expect(read.findings).toEqual([]);
      expect(read.pages.map((page) => page.id)).toEqual(['domain:payments']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a manifest finding (a template that is not there) stops the index: the pages it would have dropped are not published as the whole', async () => {
    const root = folder();
    try {
      write(root, 'madarch/kinds.yaml', KINDS);
      write(root, 'docs/domains/payments.md', PAGE_TEXT);
      const read = readKnowledgePages(root);
      expect(read.findings.length).toBeGreaterThan(0);
      let message = '';
      try {
        await indexProductMarkdown({ owner: undefined as never, store: undefined as never, productFolder: root, productId: 'shop', at: '2020-01-01T00:00:00.000000Z', repositories: () => undefined });
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toContain('cannot be indexed whole');
      expect(message).toContain('kinds.yaml:');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a page that cannot be read names its file and line', async () => {
    const root = folder();
    try {
      write(root, 'madarch/kinds.yaml', KINDS);
      write(root, 'templates/domain.md', ':::body\n');
      write(root, 'docs/domains/payments.md', '---\nid: domain:payments\nkind: domain\nwritten-at: nonsense\n---\nbody\n');
      const read = readKnowledgePages(root);
      expect(read.findings.map((f) => `${f.file}:${f.line}`)).toEqual(['docs/domains/payments.md:2']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
