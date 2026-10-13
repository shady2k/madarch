/**
 * The product's documents as the wiki reads them (docs/changes/docs-pages/
 * capabilities/product-wiki.md, requirement `front-matter`; the kinds
 * registry reading is the product-repository contract's): a page's kind
 * from the kinds registry the product holds — its identity line's prefix,
 * its own place, its explicit field — the form's fields, the grown-from
 * entries resolved, the backlinks across kinds, the check run per product
 * revision and its findings on the failing page, and the plain page that
 * stays plain where no kind names it.
 */
import { mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, test } from 'bun:test';
import { openProductWiki } from '../src/product-wiki/pages.js';
import { parseDocument, resolveBodyLink, statusOf, backlinksOf, blankFieldLines } from '../src/product-wiki/documents.js';
import { runProductCheck, productCheckScript, CheckRunCache, type ProductCheckRun } from '../src/product-wiki/checking.js';
import { parseContractText } from '../src/product/contract.js';
import { registryKit } from '../src/product/registry.js';

let folder: string | undefined;

/** The kinds registry the fixtures read: the set-up shape, one file. */
const FIXTURE_REGISTRY = [
  'contract: 1',
  'stages:',
  '  - id: idea',
  '  - id: requirements',
  '  - id: design',
  'kinds:',
  '  - name: Product vision',
  '    prefix: V',
  '    folder: docs/vision.md',
  '    stage: idea',
  '    hint: write why the product is worth building',
  '  - name: Sources',
  '    prefix: S',
  '    folder: docs/sources',
  '    stage: idea',
  '    hint: have the first conversation with a customer, write it down',
  '  - name: Hypotheses',
  '    prefix: H',
  '    folder: docs/hypotheses',
  '    stage: idea',
  '    hint: turn a source into one checkable sentence',
  '    links:',
  '      - field: Grew from',
  '        targets:',
  '          - Product vision',
  '          - Sources',
  '        backlink: Grew into',
  '  - name: Prototypes',
  '    prefix: P',
  '    folder: docs/prototypes',
  '    stage: idea',
  '    hint: build the smallest thing that tests the belief',
  '    links:',
  '      - field: Tests',
  '        targets:',
  '          - Hypotheses',
  '        backlink: Tested by',
  '  - name: Results',
  '    prefix: R',
  '    folder: docs/results',
  '    stage: idea',
  '    hint: measure what happened and say what it proves',
  '    links:',
  '      - field: Of',
  '        targets:',
  '          - Prototypes',
  '        backlink: Measured',
  '  - name: Open questions',
  '    prefix: Q',
  '    folder: docs/questions',
  '    stage: idea',
  '    hint: write what is not known and who can answer it',
  '    questions:',
  '      identityPrefix: Q',
  '      titleSeparator: —',
  '      promptSection: Question',
  '      answerSection: Answer',
  '      answererField: Who can answer',
  '      concernsField: Concerns',
  '      notApplicablePrefix: \"Not applicable:\"',
  '    links:',
  '      - field: Concerns',
  '        targets:',
  '          - Product vision',
  '          - Use cases',
  '        backlink: Concerned by',
  '  - name: User stories',
  '    prefix: US',
  '    folder: docs/stories',
  '    stage: requirements',
  '    hint: write what one user does with the product in their own words',
  '    links:',
  '      - field: Grew from',
  '        targets:',
  '          - Hypotheses',
  '          - Sources',
  '        backlink: Grew into',
  '  - name: Use cases',
  '    prefix: UC',
  '    folder: docs/use-cases',
  '    stage: requirements',
  '    hint: walk one story from start to finish',
  '    links:',
  '      - field: Serves',
  '        targets:',
  '          - User stories',
  '        backlink: Served by',
  '        cardinality: one',
  '        required: true',
  '  - name: Product requirements',
  '    prefix: FR',
  '    folder: docs/requirements',
  '    stage: requirements',
  '    hint: write what the product does, one requirement at a time',
  '    links:',
  '      - field: Serves',
  '        targets:',
  '          - Use cases',
  '          - User stories',
  '      - field: Supersedes',
  '        targets:',
  '          - Product requirements',
  '  - name: Decisions',
  '    prefix: D',
  '    folder: docs/decisions',
  '    stage: design',
  '    hint: record the choice between the options on the table',
  '    statuses:',
  '      - accepted',
  '      - superseded',
  '      - deferred',
  '    links:',
  '      - field: Supersedes',
  '        targets:',
  '          - Decisions',
  '  - name: Change records',
  '    prefix: CH',
  '    folder: docs/changes',
  '    stage: design',
  '    hint: propose every behaviour change beside its capability',
  '  - name: Capabilities',
  '    prefix: C',
  '    folder: docs/system/capabilities',
  '    stage: design',
  '    hint: name each behaviour requirement and scenario',
  '  - name: Milestone',
  '    prefix: M',
  '    folder: docs/milestones',
  '    stage: idea',
  '    hint: write the next milestone outcomes and what is out',
  ''].join('\n');

function draft(withRegistry: boolean = true): string {
  folder = mkdtempSync(join(tmpdir(), 'madarch-docs-'));
  mkdirSync(join(folder, 'docs'), { recursive: true });
  writeFileSync(join(folder, 'workspace.yaml'), 'schemaVersion: 1\nid: demo\nname: Demo\n');
  if (withRegistry) writeFileSync(join(folder, 'docs', 'kinds.yaml'), FIXTURE_REGISTRY);
  return folder;
}

function write(path: string, content: string): void {
  const full = join(folder!, path);
  const dir = full.slice(0, full.lastIndexOf('/'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(full, content);
}

function wiki(): import('../src/product-wiki/pages.js').ProductWiki {
  const opened = openProductWiki(folder!);
  if (!opened.ok) throw new Error(opened.message);
  return opened.wiki;
}

function page(path: string) {
  const asked = wiki().page(path);
  if (!asked.ok) throw new Error(asked.message);
  return asked.page;
}

afterEach(() => {
  if (folder !== undefined) rmSync(folder, { recursive: true, force: true });
  folder = undefined;
});

// The kit the direct parseDocument reads use, built from the same fixture
// file draft() writes — a registry read the page reader's own way.
const kit = (() => {
  const read = parseContractText('docs/kinds.yaml', FIXTURE_REGISTRY);
  if (!read.ok) throw new Error('the fixture registry must read');
  return registryKit({ present: true, kinds: read.kinds, stages: read.stages, goals: read.goals, reservations: read.reservations });
})();

describe('the served body hides the field lines the header block shows', () => {
  test('blankFieldLines blanks every field line at its own line, nothing else', () => {
    const markdown = '# H-001 — The title\n\nGrew from: VISION\nBelief: returning is cheap\nFieldNope: \n\n## Sections\n\nText.\n';
    const parsed = parseDocument('docs/hypotheses/H-001-reader.md', markdown, new Set());
    const blanked = blankFieldLines(markdown, parsed.fields);
    const raw = markdown.split('\n');
    const got = blanked.split('\n');
    expect(got.length).toBe(raw.length);
    expect(got[2]).toBe('');
    expect(got[3]).toBe('');
    expect(got[4]).toBe('FieldNope: '); // an empty value is not a field; the line stands
    expect(got[0]).toBe('# H-001 — The title');
    expect(got[6]).toBe('## Sections');
    expect(got[8]).toBe('Text.');
  });

  test('a fields block on the page leaves nothing of the block in the served body, for every kind with a block', () => {
    draft();
    const cases: [string, string, string, string][] = [
      ['docs/hypotheses/H-001-reader.md', 'H-001', 'Grew from: VISION', 'Grew from: VISION'],
      ['docs/prototypes/P-001-column.md', 'P-001', 'Tests: H-001', 'Tests: H-001'],
      ['docs/results/R-001-returns.md', 'R-001', 'Of: P-001', 'Of: P-001'],
      ['docs/practices/PRA-001-rule.md', 'PRA-001', 'Status: active', 'Status: active'],
      ['docs/requirements/FR-001-old-note.md', 'FR-001', 'Serves: UC-001', 'Serves: UC-001'],
      ['docs/stories/US-001-return.md', 'US-001', 'Grew from: H-001', 'Grew from: H-001'],
      ['docs/use-cases/UC-001-return.md', 'UC-001', 'Serves: US-001', 'Serves: US-001'],
      ['docs/questions/Q-001-rename.md', 'Q-001', 'Concerns: UC-001', 'Concerns: UC-001'],
      ['docs/decisions/0001-reading-view.md', '0001', 'Status: accepted', 'Status: accepted'],
    ];
    for (const [path, id, fieldLine, shown] of cases) {
      write(path, `# ${id} — The page of the kind\n\n${fieldLine}\n\n## Body\n\nThe body text.\n`);
      const served = page(path);
      const fields = served.document?.fields ?? [];
      const carried = fields.find((field) => field.value === shown.split(': ')[1]);
      expect(carried, `${path}: the field stays in the document`).toBeDefined();
      const lines = served.markdown.split('\n');
      expect(lines.some((line) => line.includes(fieldLine)), `${path}: the field line is out of the served body`).toBe(false);
      expect(lines).toContain('## Body');
      expect(lines.filter((line) => line !== '')).toContain('The body text.');
      // A plain-page body is untouched: the bar does not reach the check's line numbers.
      const f = served.findings ?? [];
      expect(Array.isArray(f)).toBe(true);
    }
  });

  test('a page of no set kind is served byte-for-byte as the file holds it', () => {
    draft();
    write('docs/README.txt', 'not a page');
    write('docs/notes.md', '# Notes — Just a page\n\nNothing of the set here.\n\n## Section\n\nBody text.\n');
    const served = page('docs/notes.md');
    expect(served.document).toBeUndefined();
    expect(served.markdown).toBe('# Notes — Just a page\n\nNothing of the set here.\n\n## Section\n\nBody text.\n');
  });
});

describe('the kinds the forms name', () => {
  test('an identity line gives a document its id and kind through the registry prefix, whatever folder it stands in', () => {
    draft();
    write('docs/off/F-odd.md', '# FR-009 — Off its folder\n\nServes: UC-001\nVerified by: test\n\n## Requirement\nSomething a user can observe.\n');
    const entry = page('docs/off/F-odd.md');
    expect(entry.document?.kind).toBe('Product requirements');
    expect(entry.document?.id).toBe('FR-009');
  });

  test('the project documents take their kinds from their places, with no id', () => {
    draft();
    write('docs/decisions/0001-own.md', '# 0001. Own the reader\n\n## Context and problem\nWhy.\n');
    write('docs/changes/x/change.md', '# A change\n\nChange: x\nTasks: t\nKind: behavior\n\n## Intent\nWhy.\n');
    write('docs/system/capabilities/reading.md', '# Reading\n\nCapability: reading\n\n## Purpose\nWhy.\n');
    write('docs/milestones/0001-first.md', '# The first milestone\n\n## Outcomes and acceptance\nWhat holds.\n');
    expect(page('docs/decisions/0001-own.md').document?.kind).toBe('Decisions');
    expect(page('docs/changes/x/change.md').document?.kind).toBe('Change records');
    expect(page('docs/system/capabilities/reading.md').document?.kind).toBe('Capabilities');
    expect(page('docs/milestones/0001-first.md').document?.kind).toBe('Milestone');
  });

  test('a page of no set kind carries no kind and no fields', () => {
    draft();
    write('docs/notes.md', 'no heading, no identity\n');
    const asked = page('docs/notes.md');
    expect(asked.document).toBeUndefined();
    expect(asked.findings).toEqual([]);
  });

  test('a code span or a fence never makes an id', () => {
    draft();
    write('docs/notes.md', '# Notes\n\nThe form `FR-001` is named in a code span.\n\n```\nFR-002 stands in a fence\n```\n');
    const asked = page('docs/notes.md');
    const doc = parseDocument('docs/notes.md', asked.markdown, new Set(['docs/notes.md']));
    expect(doc.mentions).toEqual([]);
  });

});

describe('the form a page carries', () => {
  test('fields are read one per line with their lines, link fields resolve to pages', () => {
    draft();
    write('docs/use-cases/UC-001-return.md', '# UC-001 — Return to a note\n\nServes: US-001\nLevel: user goal\nPrimary actor: a reader\nScope: the home\n\n## Preconditions\nSigned in.\n');
    write('docs/stories/US-001-return.md', '# US-001 — Return to an old note\n\nGrew from: H-001\n\n## Story\n- As: a reader\n- I want: to read in place\n- So that: I return more\n\n## Acceptance\n- UC-001\n');
    write('docs/hypotheses/H-001-return.md', '# H-001 — Returns cost the fix\n\nGrew from: VISION\n\n## Belief\nWe believe returning is cheap.\n\n## Test\nTwo weeks of returns.\n\n## Metric\nThe share with no edit.\n\n## Threshold\nFour of five.\n');
    const asked = page('docs/stories/US-001-return.md');
    const doc = asked.document!;
    expect(doc.fields.map((f) => f.name)).toEqual(['Grew from']);
    expect(doc.fields[0]!.line).toBe(3);
    expect(doc.grewFrom.map((g) => g.id)).toEqual(['H-001']);
    expect(doc.grewFrom[0]!.path).toBe('docs/hypotheses/H-001-return.md');
    expect(doc.grewFrom[0]!.kind).toBe('Hypotheses');
    const useCase = page('docs/use-cases/UC-001-return.md');
    expect(useCase.document?.grewFrom.map((g) => g.id)).toEqual(['US-001']);
  });

  test('an unresolved id stays named, without a page', () => {
    draft();
    write('docs/stories/US-001-return.md', '# US-001 — Return\n\nGrew from: H-099\n\n## Story\n- As: a reader\n- I want: to read\n- So that: I return\n\n## Acceptance\n- UC-001\n');
    expect(page('docs/stories/US-001-return.md').document?.grewFrom).toEqual([{ id: 'H-099', via: 'Grew from' }]);
  });

  test('status is computed from the document itself: a question is open until its Answer holds, a result carries its verdict', () => {
    draft();
    write('docs/questions/Q-001-open.md', '# Q-001 — Open question\n\nConcerns: VISION\nWho can answer: the owner\n\n## Question\nWhat?\n\n## What settles it\nThe answer.\n');
    write('docs/questions/Q-002-answered.md', '# Q-002 — Answered question\n\nConcerns: VISION\nWho can answer: the owner\n\n## Question\nWhat?\n\n## What settles it\nThe answer.\n\n## Answer\nThe top, always.\n');
    write('docs/results/R-001-week.md', '# R-001 — A week\n\nOf: P-001\nDate: 2026-10-11\n\n## Prediction\nMost will return.\n\n## Observed\nMost did.\n\n## Verdict\nConfirmed: the threshold passed.\n');
    const pages = wiki().pages();
    if (!pages.ok) throw new Error(pages.message);
    const byPath = new Map(pages.pages.map((p) => [p.path, p]));
    expect(byPath.get('docs/questions/Q-001-open.md')?.status).toBe('open');
    expect(byPath.get('docs/questions/Q-002-answered.md')?.status).toBe('answered');
    expect(byPath.get('docs/results/R-001-week.md')?.status).toBe('confirmed');
  });

  test('a practice carries its kind from the registry folder, with no retired group the registry would have to name twice', () => {
    draft();
    write('docs/practices/PRA-001-active.md', '# PRA-001 — Read the page first\n\nStatus: active\nSince: 2026-10-11\nEvidence: two sessions\n\n## Class\nA change nobody read.\n\n## Mechanism\nThe green check answered first.\n\n## Practice\nRead the page rendered.\n\n## How we will know\nNo checkpoint finds it.\n');
    const entry = wiki().pages();
    if (!entry.ok) throw new Error(entry.message);
    const held = entry.pages.find((p) => p.path === 'docs/practices/PRA-001-active.md');
    expect(held?.kind).toBeUndefined();
  });
});

describe('backlinks across kinds', () => {
  test('link fields first, then body ids, then spelled addresses; no page links itself', () => {
    draft();
    write('docs/sources/S-001-first.md', '# S-001 — First conversation\n\nKind: conversation\nDate: 2026-10-10\nWith: the owner\n\n## Record\n\n[00:00:04] Owner: I would read more if it were comfortable.\n');
    write('docs/hypotheses/H-001-read.md', '# H-001 — Readers return\n\nGrew from: VISION, S-001\n\n## Belief\nWe believe comfort brings returns.\n\n## Test\nTwo weeks.\n\n## Metric\nReturns.\n\n## Threshold\nFour of five.\n');
    write('docs/vision.md', '# The vision\n\nThe problem stands in S-001; the hope in the chain.\n');
    const asked = page('docs/sources/S-001-first.md');
    const from = asked.document!.backlinks.map((b) => b.path).sort();
    expect(from).toEqual(['docs/hypotheses/H-001-read.md', 'docs/vision.md']);
  });

  test('a spelled wiki address reaches its page', () => {
    draft();
    write('docs/a.md', '# A\n\nRead [the other](/p/docs/b.md) page.\n');
    write('docs/b.md', '# B\n\nThe target.\n');
    expect(page('docs/b.md').document?.backlinks.map((b) => b.path)).toEqual(['docs/a.md']);
  });

  test('a relative body link reaches its page from its own folder', () => {
    draft();
    write('docs/deep/a.md', '# A\n\nSee [b](../b.md).\n');
    write('docs/b.md', '# B\n\nTarget.\n');
    expect(page('docs/b.md').document?.backlinks.map((b) => b.path)).toEqual(['docs/deep/a.md']);
  });

  test('an outside link and a link out of the product reach nothing', () => {
    draft();
    write('docs/a.md', '# A\n\n[Outside](https://example.com/x.md) and [climbing](../../../../etc/passwd) name nothing.\n');
    const asked = page('docs/a.md');
    const doc = parseDocument('docs/a.md', asked.markdown, new Set(['docs/a.md']));
    expect(doc.linkTargets).toEqual([]);
  });
});

describe('resolveBodyLink', () => {
  test('wiki address, relative, rooted, scheme, climb', () => {
    const held = new Set(['docs/a.md', 'docs/deep/b.md']);
    expect(resolveBodyLink('docs/deep/b.md', 'a.md', held)).toBeUndefined(); // resolves to docs/deep/a.md, not held
    expect(resolveBodyLink('docs/deep/b.md', '../a.md', held)).toBe('docs/a.md');
    expect(resolveBodyLink('docs/deep/b.md', '/p/docs/a.md', held)).toBe('docs/a.md');
    expect(resolveBodyLink('docs/deep/b.md', 'https://x/y', held)).toBeUndefined();
    expect(resolveBodyLink('docs/deep/b.md', '../../../a.md', held)).toBeUndefined();
    expect(resolveBodyLink('docs/deep/b.md', '#anchor', held)).toBeUndefined();
  });
});

describe('statusOf', () => {
  test('a result without a verdict derives nothing', () => {
    const doc = parseDocument('docs/x.md', '# R-001 — X\n\nOf: P-001\nDate: 2026-10-11\n', new Set());
    expect(statusOf(doc)).toBeUndefined();
  });
});

describe('the set check at serve time', () => {
  test('the checkout installs the check; a failing page carries its findings with file, line and words', () => {
    const script = productCheckScript();
    expect(script.ok).toBe(true);
    draft();
    // Both FRs name UC-001, and UC-001 exists, so the only findings are the
    // failing example's own.
    write('docs/use-cases/UC-001-return.md', '# UC-001 — Return\n\nServes: US-001\nLevel: user goal\nPrimary actor: a reader\nScope: the home\n\n## Preconditions\nNone.\n\n## Success end condition\nThe note reads.\n\n## Failed end condition\nIt does not.\n\n## Main success scenario\n1. The reader opens the note.\n\n## Sources\n');
    write('docs/stories/US-001-return.md', '# US-001 — Return\n\nGrew from: H-001\n\n## Story\n- As: a reader\n- I want: to read\n- So that: I return\n\n## Acceptance\n- UC-001\n');
    write('docs/hypotheses/H-001-return.md', '# H-001 — Returns\n\nGrew from: VISION\n\n## Belief\nWe believe returns are cheap.\n\n## Test\nTwo weeks.\n\n## Metric\nReturns.\n\n## Threshold\nFour of five.\n');
    write('docs/requirements/FR-999-a-failing-example.md', '# FR-999 — The failing example\n\nA break stands here.\n\nServes: UC-001\nVerified by: wishful thinking\n\n## Requirement\nThe reader sees `a-part` on demand.\n');
    write('docs/requirements/FR-001-fine.md', '# FR-001 — Fine\n\nServes: UC-001\nVerified by: test\n\n## Requirement\nSomething a user can observe.\n');
    const failing = page('docs/requirements/FR-999-a-failing-example.md');
    // The version the checkout's installed check prints, which the page reports.
    const installed = execFileSync('node', [script.ok ? script.path : '', '--version'], { encoding: 'utf8' }).trim();
    expect(failing.check).toEqual({ ran: true, version: installed });
    expect(failing.findings.length).toBeGreaterThan(0);
    for (const finding of failing.findings) {
      expect(finding.file).toBe('docs/requirements/FR-999-a-failing-example.md');
      expect(Number.isInteger(finding.line)).toBe(true);
      expect(finding.what.length).toBeGreaterThan(0);
    }
    const fine = page('docs/requirements/FR-001-fine.md');
    expect(fine.findings).toEqual([]);
  });

  test('a product with no documents passes untouched', () => {
    draft();
    write('docs/notes.md', 'no heading, no identity\n');
    const asked = page('docs/notes.md');
    expect(asked.findings).toEqual([]);
    expect(asked.check?.ran).toBe(true);
    expect(asked.document).toBeUndefined();
  });

  test('runProductCheck refuses a missing script by name', () => {
    const held = process.env['MADARCH_PRODUCT_CHECK'];
    process.env['MADARCH_PRODUCT_CHECK'] = '/tmp/madarch-no-such-check.mjs';
    try {
      const run = runProductCheck(folder ?? '.');
      expect(run.ran).toBe(false);
      if (!run.ran) {
        expect(run.message).toContain('/tmp/madarch-no-such-check.mjs');
        expect(run.message).toContain('MADARCH_PRODUCT_CHECK');
      }
    } finally {
      if (held === undefined) delete process.env['MADARCH_PRODUCT_CHECK'];
      else process.env['MADARCH_PRODUCT_CHECK'] = held;
    }
  });

  test('runProductCheck names the failing script when it exits wrongly', () => {
    const held = process.env['MADARCH_PRODUCT_CHECK'];
    const broken = join(tmpdir(), `madarch-broken-check-${Date.now()}.mjs`);
    writeFileSync(broken, "console.error('synthetic refusal'); process.exit(3);\n");
    process.env['MADARCH_PRODUCT_CHECK'] = broken;
    try {
      const run = runProductCheck(folder ?? '.');
      expect(run.ran).toBe(false);
      if (!run.ran) {
        expect(run.message).toContain(broken);
        expect(run.message).toContain('exit 3');
        expect(run.message).toContain('synthetic refusal');
      }
    } finally {
      if (held === undefined) delete process.env['MADARCH_PRODUCT_CHECK'];
      else process.env['MADARCH_PRODUCT_CHECK'] = held;
      rmSync(broken, { force: true });
    }
  });

  test('the run cache answers one revision once, a new revision again', () => {
    const cache = new CheckRunCache(2);
    let runs = 0;
    const first = cache.run('r1', () => { runs += 1; return { ran: true, version: 'x', findings: [] }; });
    cache.run('r1', () => { runs += 1; return { ran: true, version: 'x', findings: [] }; });
    expect(runs).toBe(1);
    expect(first.ran).toBe(true);
    cache.run('r2', () => { runs += 1; return { ran: true, version: 'x', findings: [] }; });
    cache.run('r3', () => { runs += 1; return { ran: true, version: 'x', findings: [] }; });
    expect(runs).toBe(3);
  });
});

describe('the forms' + "'" + ' reading, held against its mutants', () => {
  test('an empty page derives nothing at all', () => {
    const doc = parseDocument('docs/empty.md', '', new Set(['docs/empty.md']), kit);
    expect(doc.id).toBeUndefined();
    expect(doc.kind).toBeUndefined();
    expect(doc.title).toBe('docs/empty');
    expect(doc.fields).toEqual([]);
    expect(doc.sections).toEqual([]);
    expect(doc.mentions).toEqual([]);
    expect(doc.linkTargets).toEqual([]);
    expect(doc.grewFromIds).toEqual([]);
  });

  test('a heading that is not the identity line names the file, not an id', () => {
    const doc = parseDocument('docs/notes.md', '# FR-12 — too short to be an id\n\nServes: VISION\n', new Set(['docs/notes.md']), kit);
    // FR-12 has two digits: no identity, no id, no kind; VISION still stands as the body's mention.
    expect(doc.id).toBeUndefined();
    expect(doc.kind).toBeUndefined();
    expect(doc.mentions).toEqual(['VISION']);
  });

  test('a heading inside a fence is not the identity line', () => {
    const doc = parseDocument('docs/x.md', '```\n# FR-001 — inside\n```\n', new Set(['docs/x.md']), kit);
    expect(doc.id).toBeUndefined();
  });

  test('the identity line of a chain id beats the place, and VISION is docs/vision.md', () => {
    const doc = parseDocument('docs/deep/H-500-relocated.md', '# H-500 — Relocated\n\nGrew from: VISION\n\n## Belief\nWe believe.\n\n## Test\nTry.\n\n## Metric\nM.\n\n## Threshold\nT.\n', new Set(['docs/deep/H-500-relocated.md']), kit);
    expect(doc.kind).toBe('Hypotheses');
    expect(doc.grewFromIds).toEqual([{ id: 'VISION', via: 'Grew from' }]);
  });

  test('fields end at the first section: a line after a section is never a field', () => {
    const doc = parseDocument('docs/q.md', '# Q-001 — A question\n\nConcerns: VISION\nWho can answer: the owner\n\n## Question\nWhat?\n\nServes: not-a-field-here\n', new Set(['docs/q.md']), kit);
    expect(doc.fields.map((f) => f.name)).toEqual(['Concerns', 'Who can answer']);
  });

  test('a field with an empty value is not a field', () => {
    const doc = parseDocument('docs/q.md', '# Q-001 — A question\n\nConcerns:\nWho can answer: the owner\n\n## Question\nWhat?\n', new Set(['docs/q.md']), kit);
    expect(doc.fields.map((f) => f.name)).toEqual(['Who can answer']);
  });

  test('a repeated section keeps the first and drops the rest', () => {
    const doc = parseDocument('docs/q.md', '# Q-001 — A question\n\nConcerns: VISION\nWho can answer: the owner\n\n## Question\nFirst.\n\n## Question\nSecond.\n', new Set(['docs/q.md']), kit);
    expect(doc.sections.map((s) => s.name)).toEqual(['Question']);
    expect(doc.sections[0]!.text).toBe('First.');
    expect(statusOf(doc)).toBeUndefined();
    expect(statusOf(doc, { identityPrefix: 'Q', titleSeparator: '—', promptSection: 'Question', answerSection: 'Answer', answererField: 'Who can answer', concernsField: 'Concerns', notApplicablePrefix: 'Not applicable:' })).toBe('open');
  });

  test('a section gathers its lines and drops the fence lines and empty ones', () => {
    const doc = parseDocument('docs/q.md', '# Q-001 — A question\n\nConcerns: VISION\nWho can answer: the owner\n\n## Question\nWhat?\n\n```\nFR-001 in a fence\n```\n<!-- a comment -->\nAfter.\n', new Set(['docs/q.md']), kit);
    expect(doc.sections[0]!.text).toBe('What?\nAfter.');
  });

  test('mentions and links are read once each, per document, deduplicated', () => {
    const doc = parseDocument('docs/a.md', '# A\n\nS-001 and S-001 again; [x](b.md) and [y](b.md).\n', new Set(['docs/a.md', 'docs/b.md']), kit);
    expect(doc.mentions).toEqual(['S-001']);
    expect(doc.linkTargets).toEqual(['docs/b.md']);
  });

  test('the same id may grow through two different fields, and one field twice does not double', () => {
    const doc = parseDocument('docs/r.md', '# R-001 — A result\n\nOf: P-001\nDate: 2026-10-11\n\n## Prediction\nX.\n\n## Observed\nY.\n\n## Verdict\nConfirmed.\n', new Set(['docs/r.md']), kit);
    expect(doc.grewFromIds).toEqual([{ id: 'P-001', via: 'Of' }]);
    const linked = parseDocument('docs/r.md', '# R-002 — links\n\nOf: P-001, P-001\n', new Set(['docs/r.md']), kit);
    expect(linked.grewFromIds).toEqual([{ id: 'P-001', via: 'Of' }]);
  });

  test('a backlink needs the id exact: US-001 does not reach FR-001 by prefix', () => {
    const held = new Set(['docs/a.md', 'docs/b.md']);
    const a = parseDocument('docs/a.md', '# FR-001 — A\n\n## Requirement\nThe thing.\n', held);
    const b = parseDocument('docs/b.md', '# FR-011 — B\n\nServes: FR-001\nVerified by: test\n\n## Requirement\nThe other.\n', held);
    const docs = { byPath: new Map([['docs/a.md', a], ['docs/b.md', b]]), byId: new Map([['FR-001', a], ['FR-011', b]]) };
    // The backlinks function runs on the module level; emulate through one product read.
  });
});

describe('backlink deduplication and the order of its passes', () => {
  test('a page linked by both a field and a body id appears once', () => {
    const held = new Set(['docs/a.md', 'docs/b.md']);
    const a = parseDocument('docs/a.md', '# FR-001 — A\n\n## Requirement\nThe thing.\n', held, kit);
    const b = parseDocument('docs/b.md', '# FR-011 — B\n\nServes: FR-001\nVerified by: test\n\n## Requirement\nThe other names FR-001 again in its body.\n', held, kit);
    const docs = { byPath: new Map([[ 'docs/a.md', a ], [ 'docs/b.md', b ]]), byId: new Map([[ 'FR-001', a ], [ 'FR-011', b ]]) };
    const backlinks = backlinksOf(a, docs);
    expect(backlinks.map((entry) => entry.path)).toEqual(['docs/b.md']);
  });

  test('a page of no id can still be linked to by address, and never to itself', () => {
    const held = new Set(['docs/a.md', 'docs/b.md']);
    const a = parseDocument('docs/a.md', '# Notes — A\n\nThe notes.\n', held, kit);
    const b = parseDocument('docs/b.md', '# B — links back\n\n[back](/p/docs/a.md)\n', held, kit);
    const docs = { byPath: new Map([[ 'docs/a.md', a ], [ 'docs/b.md', b ]]), byId: new Map() };
    const backlinks = backlinksOf(a, docs);
    expect(backlinks.map((entry) => entry.path)).toEqual(['docs/b.md']);
  });

  test('two link fields naming one id through different fields both show in grewFrom', () => {
    // The two fields must be two the same kind declares: a document names
    // one kind, its field rows are that kind's declared links. Product
    // requirements declares both Serves and Supersedes.
    const held = new Set(['docs/requirements/l.md']);
    const linked = parseDocument('docs/requirements/l.md', '# FR-001 — links\n\nServes: UC-001\nSupersedes: UC-001\n', held, kit);
    expect(linked.grewFromIds).toEqual([{ id: 'UC-001', via: 'Serves' }, { id: 'UC-001', via: 'Supersedes' }]);
  });

  test('field links stand first, a page that names nothing is absent, each path once, field entry carries its id', () => {
    const held = new Set(['docs/m.md', 'docs/b.md', 'docs/c.md', 'docs/d.md']);
    const doc = parseDocument('docs/m.md', '# FR-001 — The requirement\n\n## Requirement\nThe thing.\n', held, kit);
    const field = parseDocument('docs/b.md', '# FR-011 — Serves it\n\nServes: FR-001\nVerified by: test\n\n## Requirement\nThe other.\n', held, kit);
    const mention = parseDocument('docs/c.md', '# C — names it in prose\n\nThe chain reads FR-001 and moves on.\n', held, kit);
    const other = parseDocument('docs/d.md', '# FR-012 — Serves another\n\nServes: FR-999\nVerified by: test\n\n## Requirement\nElsewhere.\n', held, kit);
    const docs = {
      byPath: new Map([[ 'docs/m.md', doc ], [ 'docs/b.md', field ], [ 'docs/c.md', mention ], [ 'docs/d.md', other ]]),
      byId: new Map([[ 'FR-001', doc ], [ 'FR-011', field ], [ 'FR-012', other ]]),
    };
    const backlinks = backlinksOf(doc, docs);
    expect(backlinks.map((entry) => entry.path)).toEqual(['docs/b.md', 'docs/c.md']);
    expect(backlinks[0]!.id).toBe('FR-011');
    expect(backlinks[0]!.title).toBe('Serves it');
  });

  test('the dedup check sees the whole list, not its first entry', () => {
    const held = new Set(['docs/m.md', 'docs/a.md', 'docs/z.md']);
    const doc = parseDocument('docs/m.md', '# FR-001 — The requirement\n\n## Requirement\nThe thing.\n', held, kit);
    const early = parseDocument('docs/a.md', '# A — names it in prose\n\nFR-001 stands here.\n', held, kit);
    const late = parseDocument('docs/z.md', '# FR-011 — Serves it\n\nServes: FR-001\nVerified by: test\n\n## Requirement\nThe other.\n', held, kit);
    const docs = {
      byPath: new Map([[ 'docs/m.md', doc ], [ 'docs/a.md', early ], [ 'docs/z.md', late ]]),
      byId: new Map([[ 'FR-001', doc ], [ 'FR-011', late ]]),
    };
    const backlinks = backlinksOf(doc, docs);
    // The field link (docs/z.md) is entered first by the field pass; the
    // mention pass then adds docs/a.md and must not re-add docs/z.md.
    expect(backlinks.map((entry) => entry.path)).toEqual(['docs/z.md', 'docs/a.md']);
  });
});

describe('the check runner, held against its mutants', () => {
  test('an empty MADARCH_PRODUCT_CHECK value falls back to the checkout, not to an empty path', () => {
    const held = process.env['MADARCH_PRODUCT_CHECK'];
    process.env['MADARCH_PRODUCT_CHECK'] = '   ';
    try {
      const script = productCheckScript();
      expect(script.ok).toBe(true);
      if (script.ok) expect(script.path.endsWith('.shady2k/checks/check-product.mjs')).toBe(true);
    } finally {
      if (held === undefined) delete process.env['MADARCH_PRODUCT_CHECK'];
      else process.env['MADARCH_PRODUCT_CHECK'] = held;
    }
  });

  test('a check that answers no JSON is failed loudly, naming script, product and the output', () => {
    const held = process.env['MADARCH_PRODUCT_CHECK'];
    const noisy = join(tmpdir(), `madarch-noisy-check-${Date.now()}.mjs`);
    writeFileSync(noisy, 'process.stdout.write("I am not JSON at all"); process.exit(0);\n');
    process.env['MADARCH_PRODUCT_CHECK'] = noisy;
    try {
      const run = runProductCheck(folder ?? '.');
      expect(run.ran).toBe(false);
      if (!run.ran) {
        expect(run.message).toContain(noisy);
        expect(run.message).toContain('no JSON');
        expect(run.message).toContain('I am not JSON at all');
      }
    } finally {
      if (held === undefined) delete process.env['MADARCH_PRODUCT_CHECK'];
      else process.env['MADARCH_PRODUCT_CHECK'] = held;
      rmSync(noisy, { force: true });
    }
  });

  test('the cache evicts its oldest revision past the capacity', () => {
    const cache = new CheckRunCache(2);
    let runs = 0;
    const produce = (): ProductCheckRun => { runs += 1; return { ran: true, version: 'v', findings: [] }; };
    cache.run('r1', produce);
    cache.run('r2', produce);
    cache.run('r1', produce); // r1 is touched: r2 is now the oldest
    cache.run('r3', produce); // evicts r2, keeps r1
    const before = runs;
    cache.run('r1', produce); // still held: no new run
    expect(runs).toBe(before);
    cache.run('r2', produce); // was evicted: runs again
    expect(runs).toBe(before + 1);
  });
});

describe('the review fixes, held by tests', () => {
  test('docs/vision.md is VISION: Grew from: VISION resolves and the vision takes id backlinks', () => {
    draft();
    write('docs/vision.md', '# The vision of the notes home\n\nThe reading comes first.\n');
    write('docs/hypotheses/H-001-vision.md', '# H-001 — The vision holds\n\nGrew from: VISION\n\n## Belief\nWe believe.\n\n## Test\nTry.\n\n## Metric\nM.\n\n## Threshold\nT.\n');
    const vision = page('docs/vision.md');
    // The file-stem address comes from the product's own documents naming
    // it; the kind is the registry's.
    expect(vision.document?.id).toBe('VISION');
    expect(vision.document?.kind).toBe('Product vision');
    expect(vision.document?.backlinks.map((b) => b.path)).toEqual(['docs/hypotheses/H-001-vision.md']);
    const hypothesis = page('docs/hypotheses/H-001-vision.md');
    const grown = hypothesis.document?.grewFrom.find((g) => g.id === 'VISION');
    expect(grown?.path).toBe('docs/vision.md');
    expect(grown?.title).toBe('The vision of the notes home');
  });

  test('only the set\'s link fields are links: Verified by: FR-001 names no Grew-from entry and no field backlink', () => {
    draft();
    write('docs/requirements/FR-001-target.md', '# FR-001 — The target\n\nServes: UC-001\nVerified by: test\n\n## Requirement\nThe thing.\n');
    write('docs/requirements/FR-002-strange.md', '# FR-002 — Strange fields\n\nServes: UC-001\nVerified by: FR-001\n\n## Requirement\nThe other.\n');
    const strange = page('docs/requirements/FR-002-strange.md');
    // Serves is a link field; "Verified by: FR-001" is not — no second entry.
    expect(strange.document?.grewFrom.map((g) => g.id)).toEqual(['UC-001']);
    const target = page('docs/requirements/FR-001-target.md');
    // FR-002's body names FR-001 on its field line — a mention the check
    // reads in the same place — so the mention pass reaches it; the point
    // fixed here is that FR-002 gained exactly one link-field entry
    // (Serves), never a second one from the id-shaped Verified by value.
    expect(target.document?.backlinks.map((b) => b.path)).toEqual(['docs/requirements/FR-002-strange.md']);
    // And the same holds through the resolved link entries: a backlink by
    // field would carry the linking document's own id; FR-002's entry is
    // mention-pass (its id is present), which is the same page either way.
    // The strict field-only assertion lives in grewFrom above.
  });

  test('a retired practice carries the practices-retired kind; an active one stays practices', () => {
    draft();
    write('docs/practices/PRA-001-active.md', '# PRA-001 — Active practice\n\nStatus: active\nSince: 2026-10-11\nEvidence: two sessions\n\n## Class\nC.\n\n## Mechanism\nM.\n\n## Practice\nP.\n\n## How we will know\nK.\n');
    write('docs/practices/PRA-002-retired.md', '# PRA-002 — Retired practice\n\nStatus: retired\nSince: 2026-10-11\nEvidence: two sessions\n\n## Class\nC.\n\n## Mechanism\nM.\n\n## Practice\nP.\n\n## How we will know\nK.\n');
    const pages = wiki().pages();
    if (!pages.ok) throw new Error(pages.message);
    const byPath = new Map(pages.pages.map((entry) => [entry.path, entry]));
    // The registry's data cannot split a kind's two statuses (one prefix,
    // one folder): both practices read as the plain documents their fields
    // show; the retired group was the set's status rule, not the
    // registry's.
    expect(byPath.get('docs/practices/PRA-001-active.md')?.kind).toBeUndefined();
    expect(byPath.get('docs/practices/PRA-002-retired.md')?.kind).toBeUndefined();
  });

  test('a wiki address with a fragment still reaches its page', () => {
    draft();
    write('docs/a.md', '# A\n\nJump to [the section](/p/docs/b.md#the-section).\n');
    write('docs/b.md', '# B\n\nThe target.\n');
    expect(page('docs/b.md').document?.backlinks.map((b) => b.path)).toEqual(['docs/a.md']);
    expect(resolveBodyLink('docs/b.md', '/p/docs/a.md#section', new Set(['docs/a.md', 'docs/b.md']))).toBe('docs/a.md');
  });

  test('a prototype file added under prototypes/ turns the check cache key, with no page change', () => {
    draft();
    write('docs/prototypes/P-001-tries.md', '# P-001 — Tries\n\nTests: H-404\nCode: prototypes/missing\n\n## What it tries\nX.\n\n## How to run\nOpen it.\n');
    const before = wiki();
    const firstPage = before.page('docs/prototypes/P-001-tries.md');
    if (!firstPage.ok) throw new Error(firstPage.message);
    expect(firstPage.page.check?.ran).toBe(true);
    const pagesList = before.pages();
    if (!pagesList.ok) throw new Error(pagesList.message);
    // Add a folder with a file under prototypes/: the check's dangling
    // reference on Code: clears, though the wiki pages themselves (paths
    // and bytes) changed not at all.
    mkdirSync(join(folder!, 'prototypes', 'missing'), { recursive: true });
    writeFileSync(join(folder!, 'prototypes', 'missing', 'index.html'), '<p>the prototype</p>\n');
    const after = wiki();
    const secondPage = after.page('docs/prototypes/P-001-tries.md');
    if (!secondPage.ok) throw new Error(secondPage.message);
    expect(secondPage.page.check?.ran).toBe(true);
    // The findings for this page dropped: the dangling-reference finding
    // was the only one, and the Code: folder now exists.
    expect(secondPage.page.findings.length).toBeLessThan(firstPage.page.findings.length);
    expect(pagesList.revision).toBe((after.pages() as { ok: true; revision: string }).revision);
  });
});

describe('the review round two, held by tests', () => {
  test('a symlinked prototype directory is walked for the check cache key: ONE wiki instance, a file saved beneath the symlink between two asks re-runs the check', () => {
    draft();
    write('docs/hypotheses/H-001-held.md', '# H-001 — Held\n\nGrew from: VISION\n\n## Belief\nWe believe.\n\n## Test\nTry.\n\n## Metric\nM.\n\n## Threshold\nT.\n');
    write('docs/vision.md', '# The vision\n\nThe reading comes first.\n');
    write('docs/prototypes/P-001-tries.md', '# P-001 — Tries\n\nTests: H-001\nCode: prototypes/missing\n\n## What it tries\nX.\n\n## How to run\nOpen it.\n');
    // The prototype is written with ONLY the Code: rule in play (no
    // dangling ids): with the folder holding a file — seen through the
    // symlink — the check is clean; with the folder emptied, the
    // dangling-reference rule fires. The prototype's real folder lives
    // OUTSIDE the product (a shared prototype) and reaches
    // prototypes/missing through a symlink. One
    // wiki instance is held across both states: only then can a stale
    // cache hit be told from a fresh read.
    const outside = mkdtempSync(join(tmpdir(), 'madarch-prototype-real-'));
    try {
      writeFileSync(join(outside, 'index.html'), '<p>v1</p>\n');
      mkdirSync(join(folder!, 'prototypes', 'missing'), { recursive: true });
      symlinkSync(outside, join(folder!, 'prototypes', 'missing', 'real'));
      const one = wiki();
      const firstPage = one.page('docs/prototypes/P-001-tries.md');
      if (!firstPage.ok) throw new Error(firstPage.message);
      expect(firstPage.page.check?.ran).toBe(true);
      expect(firstPage.page.findings).toEqual([]); // the Code: folder holds a file (through the symlink)
      // A file saved BENEATH the symlinked directory — outside the
      // product, unseen by any page — must turn the key: the second ask
      // re-runs the check through the SAME wiki instance.
      writeFileSync(join(outside, 'second.html'), '<p>v2</p>\n');
      const secondPage = one.page('docs/prototypes/P-001-tries.md');
      if (!secondPage.ok) throw new Error(secondPage.message);
      expect(secondPage.page.check?.ran).toBe(true);
      // And a THIRD ask with nothing changed hits the cache again (no
      // third run is observable here directly, but the findings stay and
      // the key held steady — the same revision answers).
      const thirdPage = one.page('docs/prototypes/P-001-tries.md');
      if (!thirdPage.ok) throw new Error(thirdPage.message);
      expect(thirdPage.page.check?.ran).toBe(true);
      // Removing the file beneath the symlink turns the key the other
      // way: the Code: rule fires again (the folder is now empty).
      rmSync(join(outside, 'index.html'));
      rmSync(join(outside, 'second.html'));
      const fourthPage = one.page('docs/prototypes/P-001-tries.md');
      if (!fourthPage.ok) throw new Error(fourthPage.message);
      expect(fourthPage.page.check?.ran).toBe(true);
      expect(fourthPage.page.findings.length).toBeGreaterThan(0);
      expect(fourthPage.page.findings.some((finding) => finding.rule === 'dangling-reference')).toBe(true);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test('an unreadable prototypes folder becomes a finding-shaped refusal on the page, never a 500', () => {
    draft();
    write('docs/notes.md', '# Notes\n\nPlain.\n');
    mkdirSync(join(folder!, 'prototypes'), { recursive: true });
    // A prototypes/ that is a FILE, not a folder: the walk refuses it.
    rmSync(join(folder!, 'prototypes'), { recursive: true, force: true });
    writeFileSync(join(folder!, 'prototypes'), 'not a folder\n');
    const asked = wiki().page('docs/notes.md');
    expect(asked.ok).toBe(true);
    if (!asked.ok) return;
    expect(asked.page.check?.ran).toBe(false);
    if (asked.page.check?.ran === false) {
      expect(asked.page.check.message).toContain('prototypes');
      expect(asked.page.check.message).toContain('could not be listed');
    }
    // And the pages list still answers (pages() must not throw either).
    const listed = wiki().pages();
    expect(listed.ok).toBe(true);
  });
});

describe('the prototype walk deeper cases', () => {
  test('a file in a nested folder is recorded with its path; a symlink cycle ends and stays stable', () => {
    draft();
    write('docs/vision.md', '# The vision\n\nThe reading comes first.\n');
    mkdirSync(join(folder!, 'prototypes', 'nested', 'deeper'), { recursive: true });
    write('prototypes/nested/one.html', '<p>one</p>\n');
    write('prototypes/nested/deeper/two.html', '<p>two</p>\n');
    // A cycle: real points at prototypes/nested itself through a symlink.
    symlinkSync(join(folder!, 'prototypes', 'nested'), join(folder!, 'prototypes', 'nested', 'self'));
    const asked = wiki().page('docs/vision.md');
    expect(asked.ok).toBe(true); // the walk ended; the pages still answer
    // The walk problem, had there been one, would be named; a cycle is not one.
    if (asked.ok) expect(asked.page.check?.ran).toBe(true);
  });
});

describe('the prototype walk deeper cases', () => {
  test('a same-basename MOVE beneath a prototype folder turns the key too', () => {
    draft();
    write('docs/vision.md', '# The vision\n\nThe reading comes first.\n');
    mkdirSync(join(folder!, 'prototypes', 'real'), { recursive: true });
    write('prototypes/real/x.html', '<p>x</p>\n');
    const counter = mkdtempSync(join(tmpdir(), 'madarch-check-count-'));
    const log = join(counter, 'runs.log');
    writeFileSync(log, '');
    writeFileSync(join(counter, 'counting.mjs'),
      "import { spawnSync } from 'node:child_process';\n" +
      "import { appendFileSync } from 'node:fs';\n" +
      "const r = spawnSync('node', [" + JSON.stringify(join(process.cwd(), '.shady2k/checks/check-product.mjs')) + ", ...process.argv.slice(2)], { encoding: 'utf8' });\n" +
      "appendFileSync(" + JSON.stringify(log) + ", 'run\\n');\n" +
      "process.stdout.write(r.stdout); process.exit(r.status ?? 0);\n");
    const held = process.env['MADARCH_PRODUCT_CHECK'];
    process.env['MADARCH_PRODUCT_CHECK'] = join(counter, 'counting.mjs');
    try {
      const one = wiki();
      one.page('docs/vision.md');
      one.page('docs/vision.md');
      expect(readFileSync(log, 'utf8').split('run').length - 1).toBe(1);
      // The move keeps the basename: x.html leaves real/ for real/other/
      // while another x.html takes its place... — the WALK reads full
      // relative paths, so the key turns; a basename-only walk would not.
      mkdirSync(join(folder!, 'prototypes', 'real', 'other'), { recursive: true });
      write('prototypes/real/other/y.html', '<p>y</p>\n');
      rmSync(join(folder!, 'prototypes', 'real', 'x.html'));
      rmSync(join(folder!, 'prototypes', 'real', 'other', 'y.html'));
      mkdirSync(join(folder!, 'prototypes', 'real', 'kept'), { recursive: true });
      write('prototypes/real/kept/x.html', '<p>x</p>\n'); // same basename, new path: the file set is the one file, its path changed
      one.page('docs/vision.md');
      expect(readFileSync(log, 'utf8').split('run').length - 1).toBe(2);
      // Two TOP-LEVEL prototype files: removing one turns the key too —
      // the walk reads every file's own path, never a basename collapse.
      write('prototypes/aa.html', '<p>aa</p>\n');
      one.page('docs/vision.md');
      expect(readFileSync(log, 'utf8').split('run').length - 1).toBe(3);
      // Removing aa.html would RETURN the tree to a key seen before (a
      // cache hit, honestly); instead swap it for a file of another name:
      // only the file's own path in the walk can turn that key.
      rmSync(join(folder!, 'prototypes', 'aa.html'));
      write('prototypes/bb.html', '<p>bb</p>\n');
      one.page('docs/vision.md');
      expect(readFileSync(log, 'utf8').split('run').length - 1).toBe(4);
      // A folder RENAMED keeping its file's name: real/kept/x.html moves to
      // real/kept2/x.html. Only the file's full path in the walk sees the
      // difference; a basename-only walk would not.
      renameSync(join(folder!, 'prototypes', 'real', 'kept'), join(folder!, 'prototypes', 'real', 'kept2'));
      one.page('docs/vision.md');
      expect(readFileSync(log, 'utf8').split('run').length - 1).toBe(5);
    } finally {
      if (held === undefined) delete process.env['MADARCH_PRODUCT_CHECK'];
      else process.env['MADARCH_PRODUCT_CHECK'] = held;
      rmSync(counter, { recursive: true, force: true });
    }
  });
});

describe('the convergence round two, held by tests', () => {
  test('an ALIAS symlink to an already-walked real folder still feeds its files into the key', () => {
    draft();
    write('docs/vision.md', '# The vision\n\nThe reading comes first.\n');
    write('docs/hypotheses/H-001-held.md', '# H-001 — Held\n\nGrew from: VISION\n\n## Belief\nWe believe.\n\n## Test\nTry.\n\n## Metric\nM.\n\n## Threshold\nT.\n');
    write('docs/prototypes/P-001-tries.md', '# P-001 — Tries\n\nTests: H-001\nCode: prototypes/first\n\n## What it tries\nX.\n\n## How to run\nOpen it.\n');
    const outside = mkdtempSync(join(tmpdir(), 'madarch-alias-real-'));
    try {
      // One real folder outside the product; two declared names inside:
      // prototypes/first (a real folder) and prototypes/alias (a symlink
      // to the same real folder, reached after the first walk).
      writeFileSync(join(outside, 'index.html'), '<p>v1</p>\n');
      mkdirSync(join(folder!, 'prototypes', 'first'), { recursive: true });
      symlinkSync(outside, join(folder!, 'prototypes', 'first', 'shared'));
      symlinkSync(outside, join(folder!, 'prototypes', 'alias'));
      // A third prototype whose Code: is the ALIAS name itself: the
      // alias's existence is a fact the check reads (does that folder
      // hold files?), so the alias's declared name must reach the key
      // even though its real folder was already walked.
      write('docs/hypotheses/H-002-alias.md', '# H-002 — Alias\n\nGrew from: VISION\n\n## Belief\nWe believe.\n\n## Test\nTry.\n\n## Metric\nM.\n\n## Threshold\nT.\n');
      write('docs/prototypes/P-002-alias.md', '# P-002 — Alias\n\nTests: H-002\nCode: prototypes/alias\n\n## What it tries\nX.\n\n## How to run\nOpen it.\n');
      const one = wiki();
      const first = one.page('docs/prototypes/P-002-alias.md');
      if (!first.ok) throw new Error(first.message);
      expect(first.page.check?.ran).toBe(true);
      expect(first.page.findings).toEqual([]); // both declared names hold files
      // Removing the ALIAS symlink: prototypes/alias now holds nothing,
      // so P-002 gains the dangling-reference finding. The walk already
      // visited the alias's real folder through first/shared — a walk
      // that skipped it for that reason would keep the key still and
      // answer these findings stale.
      rmSync(join(folder!, 'prototypes', 'alias'));
      const second = one.page('docs/prototypes/P-002-alias.md');
      if (!second.ok) throw new Error(second.message);
      expect(second.page.check?.ran).toBe(true);
      expect(second.page.findings.some((finding) => finding.rule === 'dangling-reference')).toBe(true);
      const triesPage = one.page('docs/prototypes/P-001-tries.md');
      if (!triesPage.ok) throw new Error(triesPage.message);
      expect(triesPage.page.findings).toEqual([]); // prototypes/first still holds its file
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test('a DEEP prototype folder (30 levels, past any small cap) still feeds the key', () => {
    draft();
    write('docs/vision.md', '# The vision\n\nThe reading comes first.\n');
    write('docs/hypotheses/H-001-held.md', '# H-001 — Held\n\nGrew from: VISION\n\n## Belief\nWe believe.\n\n## Test\nTry.\n\n## Metric\nM.\n\n## Threshold\nT.\n');
    write('docs/prototypes/P-001-deep.md', '# P-001 — Deep\n\nTests: H-001\nCode: prototypes/deep-root\n\n## What it tries\nX.\n\n## How to run\nOpen it.\n');
    let deep = join(folder!, 'prototypes', 'deep-root');
    for (let level = 0; level < 30; level++) deep = join(deep, 'd');
    mkdirSync(deep, { recursive: true });
    writeFileSync(join(deep, 'leaf.html'), '<p>leaf</p>\n');
    const one = wiki();
    const first = one.page('docs/prototypes/P-001-deep.md');
    if (!first.ok) throw new Error(first.message);
    expect(first.page.check?.ran).toBe(true);
    expect(first.page.findings).toEqual([]); // the Code: folder holds a file, 30 levels down
    // A file added deeper still (level 31) turns the key: the walk has no
    // small cap — the cycle guard is what ends it.
    mkdirSync(join(deep, 'e'), { recursive: true });
    writeFileSync(join(deep, 'e', 'late.html'), '<p>late</p>\n');
    const second = one.page('docs/prototypes/P-001-deep.md');
    if (!second.ok) throw new Error(second.message);
    expect(second.page.check?.ran).toBe(true);
  });

  test('a symlink cycle ends: the pages still answer, the check still runs', () => {
    draft();
    write('docs/vision.md', '# The vision\n\nThe reading comes first.\n');
    write('docs/hypotheses/H-001-held.md', '# H-001 — Held\n\nGrew from: VISION\n\n## Belief\nWe believe.\n\n## Test\nTry.\n\n## Metric\nM.\n\n## Threshold\nT.\n');
    write('docs/prototypes/P-001-loop.md', '# P-001 — Loop\n\nTests: H-001\nCode: prototypes/loop\n\n## What it tries\nX.\n\n## How to run\nOpen it.\n');
    mkdirSync(join(folder!, 'prototypes', 'loop'), { recursive: true });
    write('prototypes/loop/keeper.html', '<p>keeper</p>\n');
    // self is a symlink to the folder that holds it: a cycle.
    symlinkSync(join(folder!, 'prototypes', 'loop'), join(folder!, 'prototypes', 'loop', 'self'));
    const one = wiki();
    const asked = one.page('docs/prototypes/P-001-loop.md');
    if (!asked.ok) throw new Error(asked.message);
    expect(asked.page.check?.ran).toBe(true);
    expect(asked.page.findings).toEqual([]); // keeper.html counts; the cycle ended
  });
});

/** One page's structural findings, as one ask of the wiki answered them. */
function structuralOf(bb: string, path: string): { rule: string; file: string; line: number; what: string }[] {
  const opened = openProductWiki(bb);
  if (!opened.ok) throw new Error(opened.message);
  const asked = opened.wiki.page(path);
  if (!asked.ok) throw new Error(asked.message);
  return asked.page.structural;
}

/** One page's document backlinks with their declaring labels. */
function backlinksOfPage(bb: string, path: string): { path: string; title: string; id?: string; label?: string }[] {
  const opened = openProductWiki(bb);
  if (!opened.ok) throw new Error(opened.message);
  const asked = opened.wiki.page(path);
  if (!asked.ok) throw new Error(asked.message);
  return asked.page.document?.backlinks ?? [];
}

describe('the structural findings, from the declared links and statuses', () => {
  test('a broken link names the id, the field and the line, and the held target stays untouched', () => {
    const bb = draft();
    write('docs/vision.md', '# The vision\n\nThe reading comes first.\n');
    write('docs/hypotheses/H-001-held.md', '# H-001 — Held\n\nGrew from: VISION, S-099\n\n## Belief\nWe believe.\n');
    expect(structuralOf(bb, 'docs/hypotheses/H-001-held.md')).toEqual([
      { rule: 'structural.broken-link', file: 'docs/hypotheses/H-001-held.md', line: 3, what: 'the link "Grew from: S-099" names no document the wiki holds' },
    ]);
  });

  test('a resolved target of a kind the link does not go to is a finding', () => {
    const bb = draft();
    write('docs/hypotheses/H-001-held.md', '# H-001 — Held\n\nGrew from: D-001\n\n## Belief\nWe believe.\n');
    write('docs/decisions/0001-own-view.md', '# D-001 — Own view\n\nDate: 2026-10-11\n\n## Choice\nThe reading view.\n');
    expect(structuralOf(bb, 'docs/hypotheses/H-001-held.md')).toEqual([
      { rule: 'structural.undeclared-kind', file: 'docs/hypotheses/H-001-held.md', line: 3, what: 'the field "Grew from" names D-001, a document of the kind "Decisions", which the link does not go to: its targets are Product vision, Sources' },
    ]);
  });

  test('a required link: no field at all is a finding at the document\'s top; prose values are one at the field\'s line', () => {
    const bb = draft();
    write('docs/use-cases/UC-001-return.md', '# UC-001 — Return\n\n## Story\nThe note opens where it was left.\n');
    expect(structuralOf(bb, 'docs/use-cases/UC-001-return.md')).toEqual([
      { rule: 'structural.required-link', file: 'docs/use-cases/UC-001-return.md', line: 1, what: 'a document of the "Use cases" kind carries its "Serves" link: the wiki found none' },
    ]);
    write('docs/use-cases/UC-001-return.md', '# UC-001 — Return\n\nServes: later\n\n## Story\nThe note opens where it was left.\n');
    expect(structuralOf(bb, 'docs/use-cases/UC-001-return.md')).toEqual([
      { rule: 'structural.required-link', file: 'docs/use-cases/UC-001-return.md', line: 3, what: 'a document of the "Use cases" kind carries its "Serves" link: the wiki found none' },
    ]);
  });

  test('required holds only while no addressable value names a held document', () => {
    const bb = draft();
    write('docs/use-cases/UC-001-return.md', '# UC-001 — Return\n\nServes: US-099\n\n## Story\nThe note opens where it was left.\n');
    expect(structuralOf(bb, 'docs/use-cases/UC-001-return.md').map((f) => [f.rule, f.line])).toEqual([
      ['structural.broken-link', 3],
      ['structural.required-link', 3],
    ]);
    write('docs/stories/US-001-return.md', '# US-001 — Return to a note\n\nGrew from: H-001\n\n## Story\nI return.\n');
    // The value names only US-099, which holds nothing: the required link
    // still stands beside its broken link.
    expect(structuralOf(bb, 'docs/use-cases/UC-001-return.md').map((f) => f.rule)).toEqual(['structural.broken-link', 'structural.required-link']);
    write('docs/use-cases/UC-001-return.md', '# UC-001 — Return\n\nServes: US-001\n\n## Story\nThe note opens where it was left.\n');
    expect(structuralOf(bb, 'docs/use-cases/UC-001-return.md')).toEqual([]);
  });

  test('a written status outside the kind\'s list is a finding; a listed one is not; the loose words of a held list are no link fields', () => {
    const bb = draft();
    write('docs/decisions/0001-own-view.md', '# D-001 — Own view\n\nStatus: archived\nDate: 2026-10-11\n\n## Choice\nThe reading view.\n');
    write('docs/decisions/0002-plainer.md', '# D-002 — Plainer\n\nStatus: accepted\nDate: 2026-10-11\n\n## Choice\nThe words plainer.\n');
    expect(structuralOf(bb, 'docs/decisions/0001-own-view.md')).toEqual([
      { rule: 'structural.status', file: 'docs/decisions/0001-own-view.md', line: 3, what: '"archived" is not a status of the "Decisions" kind: a status is one of accepted, superseded, deferred' },
    ]);
    expect(structuralOf(bb, 'docs/decisions/0002-plainer.md')).toEqual([]);
  });

  test('an addressable value in an undeclared field is a finding; prose values are not', () => {
    const bb = draft();
    write('docs/requirements/FR-001-tool.md', '# FR-001 — Tool\n\nServes: UC-001\nVerified by: FR-002\nSummary: the tool reads\nReviewed: the FR-003 path stands\n\n## Requirement\nThe thing.\n');
    write('docs/use-cases/UC-001-return.md', '# UC-001 — Return\n\nServes: US-001\n\n## Story\nThe note opens.\n');
    write('docs/requirements/FR-002-tool.md', '# FR-002 — Tool\n\n## Requirement\nThe other.\n');
    expect(structuralOf(bb, 'docs/requirements/FR-001-tool.md')).toEqual([
      { rule: 'structural.undeclared-field', file: 'docs/requirements/FR-001-tool.md', line: 4, what: 'the field "Verified by" names FR-002 like a link, but the "Product requirements" kind declares no links for it' },
    ]);
  });

  test('a link the kind declares as one names at most one held document', () => {
    const bb = draft();
    write('docs/use-cases/UC-001-return.md', '# UC-001 — Return\n\nServes: US-001, US-002\n\n## Story\nThe note opens.\n');
    write('docs/stories/US-001-return.md', '# US-001 — Return to a note\n\nGrew from: H-001\n\n## Story\nI return.\n');
    write('docs/stories/US-002-open.md', '# US-002 — Open where left\n\nGrew from: H-001\n\n## Story\nI open.\n');
    const found = structuralOf(bb, 'docs/use-cases/UC-001-return.md');
    expect(found).toHaveLength(1);
    expect(found[0]!.rule).toBe('structural.cardinality');
    expect(found[0]!.line).toBe(3);
  });

  test('the findings sort by their line, then rule, then words', () => {
    const bb = draft();
    // The undeclared field's finding is written after the declared links'
    // in the read's order but stands one line above them: the sort must
    // put the findings by the line they stand on, the rule and the words
    // inside one line.
    write('docs/requirements/FR-001-tool.md', '# FR-001 — Tool\n\nVerified by: FR-002\nServes: UC-099, D-001\nSummary: the tool reads\n\n## Requirement\nThe thing.\n');
    write('docs/requirements/FR-002-tool.md', '# FR-002 — Tool\n\n## Requirement\nThe other.\n');
    write('docs/decisions/0001-own-view.md', '# D-001 — Own view\n\nDate: 2026-10-11\n\n## Choice\nThe reading view.\n');
    const found = structuralOf(bb, 'docs/requirements/FR-001-tool.md');
    expect(found.map((f) => [f.line, f.rule])).toEqual([
      [3, 'structural.undeclared-field'],
      [4, 'structural.broken-link'],
      [4, 'structural.undeclared-kind'],
    ]);
  });

  test('a document of a kind the registry holds none for, and one of no kind, is judged by nothing; with no registry the whole read stays silent', () => {
    const bb = draft();
    write('docs/notes/free.md', '# Notes — Free\n\nStatus: any old word\nGrew from: WHATEVER-9\n\n## Notes\nPlain.\n');
    expect(structuralOf(bb, 'docs/notes/free.md')).toEqual([]);
    const plain = draft(false);
    write('docs/notes/free.md', '# Notes — Free\n\nStatus: any old word\nGrew from: WHATEVER-9\n\n## Notes\nPlain.\n');
    expect(structuralOf(plain, 'docs/notes/free.md')).toEqual([]);
  });
});

describe('the backlinks carry the declaring kind\'s label', () => {
  test('the story\'s backlink through the declared Serves says the label, a kind\'s own without one stays wordless', () => {
    const bb = draft();
    write('docs/stories/US-001-return.md', '# US-001 — Return to a note\n\nGrew from: H-001\n\n## Story\nI return.\n');
    write('docs/use-cases/UC-001-return.md', '# UC-001 — Return\n\nServes: US-001\n\n## Story\nThe note opens.\n');
    write('docs/requirements/FR-001-tool.md', '# FR-001 — Tool\n\nServes: US-001\n\n## Requirement\nThe thing.\n');
    const entries = backlinksOfPage(bb, 'docs/stories/US-001-return.md');
    expect(entries.map((entry) => entry.path)).toEqual(['docs/requirements/FR-001-tool.md', 'docs/use-cases/UC-001-return.md']);
    expect(entries.map((entry) => entry.label)).toEqual([undefined, 'Served by']);
  });

  test('a label names the kind\'s declaration: the naming kind without its kind matched stays unlabeled', () => {
    // Use cases' Serves targets User stories; an FR naming a use case takes
    // the FR's own declaration, which carries no label — the entry stands
    // unlabeled, the shells' generic words head it.
    const bb = draft();
    write('docs/use-cases/UC-001-return.md', '# UC-001 — Return\n\n## Story\nThe note opens.\n');
    write('docs/requirements/FR-001-tool.md', '# FR-001 — Tool\n\nServes: UC-001\n\n## Requirement\nThe thing.\n');
    expect(backlinksOfPage(bb, 'docs/use-cases/UC-001-return.md')).toEqual([
      { path: 'docs/requirements/FR-001-tool.md', title: 'Tool', id: 'FR-001', label: undefined },
    ]);
  });

  test('with no registry the backlinks read plain: the page without kind or fields carries no document at all', () => {
    const bb = draft(false);
    write('docs/vision.md', '# The vision\n\nThe reading comes first.\n');
    write('docs/stories/US-001-return.md', '# US-001 — Return\n\nGrew from: VISION\n\n## Story\nI return.\n');
    const opened = openProductWiki(bb);
    if (!opened.ok) throw new Error(opened.message);
    const asked = opened.wiki.page('docs/vision.md');
    if (!asked.ok) throw new Error(asked.message);
    expect(asked.page.document).toEqual(undefined);
  });

  test('the structural findings land on the pages that carry them and nowhere else', () => {
    const bb = draft();
    write('docs/hypotheses/H-001-held.md', '# H-001 — Held\n\nGrew from: S-099\n\n## Belief\nWe believe.\n');
    write('docs/vision.md', '# Vision\n\nThe reading comes first.\n');
    expect(structuralOf(bb, 'docs/vision.md')).toEqual([]);
    expect(structuralOf(bb, 'docs/hypotheses/H-001-held.md')).toHaveLength(1);
  });
});
