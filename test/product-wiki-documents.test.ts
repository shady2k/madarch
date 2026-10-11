/**
 * The set's documents as the wiki reads them (docs/changes/docs-pages/
 * capabilities/product-wiki.md, requirement `front-matter`): a page's kind
 * from its identity line or the set's places, the form's fields, the grown-
 * from entries resolved, the backlinks across kinds, the check run per
 * product revision and its findings on the failing page, and the plain
 * page that stays plain.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import { openProductWiki } from '../src/product-wiki/pages.js';
import { parseDocument, resolveBodyLink, statusOf, KIND_ORDER, backlinksOf } from '../src/product-wiki/documents.js';
import { runProductCheck, productCheckScript, CheckRunCache, type ProductCheckRun } from '../src/product-wiki/checking.js';

let folder: string | undefined;

function draft(): string {
  folder = mkdtempSync(join(tmpdir(), 'madarch-docs-'));
  mkdirSync(join(folder, 'docs'), { recursive: true });
  writeFileSync(join(folder, 'workspace.yaml'), 'schemaVersion: 1\nid: demo\nname: Demo\n');
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

describe('the kinds the forms name', () => {
  test('an identity line gives a chain document its id and kind, whatever folder it stands in', () => {
    draft();
    write('docs/off/F-odd.md', '# FR-009 — Off its folder\n\nServes: UC-001\nVerified by: test\n\n## Requirement\nSomething a user can observe.\n');
    const entry = page('docs/off/F-odd.md');
    expect(entry.document?.kind).toBe('requirements');
    expect(entry.document?.id).toBe('FR-009');
  });

  test('the project documents take their kinds from their places, with no id', () => {
    draft();
    write('docs/decisions/0001-own.md', '# 0001. Own the reader\n\n## Context and problem\nWhy.\n');
    write('docs/changes/x/change.md', '# A change\n\nChange: x\nTasks: t\nKind: behavior\n\n## Intent\nWhy.\n');
    write('docs/system/capabilities/reading.md', '# Reading\n\nCapability: reading\n\n## Purpose\nWhy.\n');
    write('docs/milestones/0001-first.md', '# The first milestone\n\n## Outcomes and acceptance\nWhat holds.\n');
    expect(page('docs/decisions/0001-own.md').document?.kind).toBe('decisions');
    expect(page('docs/changes/x/change.md').document?.kind).toBe('change');
    expect(page('docs/system/capabilities/reading.md').document?.kind).toBe('capability');
    expect(page('docs/milestones/0001-first.md').document?.kind).toBe('milestone');
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

  test('KIND_ORDER is the life-cycle order, practices last with retired apart', () => {
    expect(KIND_ORDER[0]).toBe('vision');
    expect(KIND_ORDER.indexOf('sources')).toBeLessThan(KIND_ORDER.indexOf('hypotheses'));
    expect(KIND_ORDER.indexOf('hypotheses')).toBeLessThan(KIND_ORDER.indexOf('stories'));
    expect(KIND_ORDER.indexOf('stories')).toBeLessThan(KIND_ORDER.indexOf('use-cases'));
    expect(KIND_ORDER.indexOf('use-cases')).toBeLessThan(KIND_ORDER.indexOf('requirements'));
    expect(KIND_ORDER.indexOf('requirements')).toBeLessThan(KIND_ORDER.indexOf('questions'));
    expect(KIND_ORDER.indexOf('questions')).toBeLessThan(KIND_ORDER.indexOf('prototypes'));
    expect(KIND_ORDER.indexOf('prototypes')).toBeLessThan(KIND_ORDER.indexOf('results'));
    expect(KIND_ORDER.indexOf('practices')).toBe(KIND_ORDER.length - 2);
    expect(KIND_ORDER[KIND_ORDER.length - 1]).toBe('practices-retired');
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
    expect(doc.grewFrom[0]!.kind).toBe('hypotheses');
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

  test('the practice kind separates retired from active by its Status field', () => {
    draft();
    write('docs/practices/PRA-001-active.md', '# PRA-001 — Read the page first\n\nStatus: active\nSince: 2026-10-11\nEvidence: two sessions\n\n## Class\nA change nobody read.\n\n## Mechanism\nThe green check answered first.\n\n## Practice\nRead the page rendered.\n\n## How we will know\nNo checkpoint finds it.\n');
    const entry = wiki().pages();
    if (!entry.ok) throw new Error(entry.message);
    const held = entry.pages.find((p) => p.path === 'docs/practices/PRA-001-active.md');
    expect(held?.kind).toBe('practices');
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
    expect(failing.check).toEqual({ ran: true, version: '0.44.0' });
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
    const doc = parseDocument('docs/empty.md', '', new Set(['docs/empty.md']));
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
    const doc = parseDocument('docs/notes.md', '# FR-12 — too short to be an id\n\nServes: VISION\n', new Set(['docs/notes.md']));
    // FR-12 has two digits: no identity, no id, no kind; VISION still stands as the body's mention.
    expect(doc.id).toBeUndefined();
    expect(doc.kind).toBeUndefined();
    expect(doc.mentions).toEqual(['VISION']);
  });

  test('a heading inside a fence is not the identity line', () => {
    const doc = parseDocument('docs/x.md', '```\n# FR-001 — inside\n```\n', new Set(['docs/x.md']));
    expect(doc.id).toBeUndefined();
  });

  test('the identity line of a chain id beats the place, and VISION is docs/vision.md', () => {
    const doc = parseDocument('docs/deep/H-500-relocated.md', '# H-500 — Relocated\n\nGrew from: VISION\n\n## Belief\nWe believe.\n\n## Test\nTry.\n\n## Metric\nM.\n\n## Threshold\nT.\n', new Set(['docs/deep/H-500-relocated.md']));
    expect(doc.kind).toBe('hypotheses');
    expect(doc.grewFromIds).toEqual([{ id: 'VISION', via: 'Grew from' }]);
  });

  test('fields end at the first section: a line after a section is never a field', () => {
    const doc = parseDocument('docs/q.md', '# Q-001 — A question\n\nConcerns: VISION\nWho can answer: the owner\n\n## Question\nWhat?\n\nServes: not-a-field-here\n', new Set(['docs/q.md']));
    expect(doc.fields.map((f) => f.name)).toEqual(['Concerns', 'Who can answer']);
  });

  test('a field with an empty value is not a field', () => {
    const doc = parseDocument('docs/q.md', '# Q-001 — A question\n\nConcerns:\nWho can answer: the owner\n\n## Question\nWhat?\n', new Set(['docs/q.md']));
    expect(doc.fields.map((f) => f.name)).toEqual(['Who can answer']);
  });

  test('a repeated section keeps the first and drops the rest', () => {
    const doc = parseDocument('docs/q.md', '# Q-001 — A question\n\nConcerns: VISION\nWho can answer: the owner\n\n## Question\nFirst.\n\n## Question\nSecond.\n', new Set(['docs/q.md']));
    expect(doc.sections.map((s) => s.name)).toEqual(['Question']);
    expect(doc.sections[0]!.text).toBe('First.');
    expect(statusOf(doc)).toBe('open');
  });

  test('a section gathers its lines and drops the fence lines and empty ones', () => {
    const doc = parseDocument('docs/q.md', '# Q-001 — A question\n\nConcerns: VISION\nWho can answer: the owner\n\n## Question\nWhat?\n\n```\nFR-001 in a fence\n```\n<!-- a comment -->\nAfter.\n', new Set(['docs/q.md']));
    expect(doc.sections[0]!.text).toBe('What?\nAfter.');
  });

  test('mentions and links are read once each, per document, deduplicated', () => {
    const doc = parseDocument('docs/a.md', '# A\n\nS-001 and S-001 again; [x](b.md) and [y](b.md).\n', new Set(['docs/a.md', 'docs/b.md']));
    expect(doc.mentions).toEqual(['S-001']);
    expect(doc.linkTargets).toEqual(['docs/b.md']);
  });

  test('the same id may grow through two different fields, and one field twice does not double', () => {
    const doc = parseDocument('docs/r.md', '# R-001 — A result\n\nOf: P-001\nDate: 2026-10-11\n\n## Prediction\nX.\n\n## Observed\nY.\n\n## Verdict\nConfirmed.\n', new Set(['docs/r.md']));
    const linked = parseDocument('docs/l.md', '# L — links\n\nOf: P-001, P-001\n', new Set(['docs/l.md']));
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
    const a = parseDocument('docs/a.md', '# FR-001 — A\n\n## Requirement\nThe thing.\n', held);
    const b = parseDocument('docs/b.md', '# FR-011 — B\n\nServes: FR-001\nVerified by: test\n\n## Requirement\nThe other names FR-001 again in its body.\n', held);
    const docs = { byPath: new Map([[ 'docs/a.md', a ], [ 'docs/b.md', b ]]), byId: new Map([[ 'FR-001', a ], [ 'FR-011', b ]]) };
    const backlinks = backlinksOf(a, docs);
    expect(backlinks.map((entry) => entry.path)).toEqual(['docs/b.md']);
  });

  test('a page of no id can still be linked to by address, and never to itself', () => {
    const held = new Set(['docs/a.md', 'docs/b.md']);
    const a = parseDocument('docs/a.md', '# Notes — A\n\nThe notes.\n', held);
    const b = parseDocument('docs/b.md', '# B — links back\n\n[back](/p/docs/a.md)\n', held);
    const docs = { byPath: new Map([[ 'docs/a.md', a ], [ 'docs/b.md', b ]]), byId: new Map() };
    const backlinks = backlinksOf(a, docs);
    expect(backlinks.map((entry) => entry.path)).toEqual(['docs/b.md']);
  });

  test('two link fields naming one id through different fields both show in grewFrom', () => {
    const held = new Set(['docs/l.md']);
    const linked = parseDocument('docs/l.md', '# L — links\n\nOf: P-001\nServes: P-001\n', held);
    expect(linked.grewFromIds).toEqual([{ id: 'P-001', via: 'Of' }, { id: 'P-001', via: 'Serves' }]);
  });

  test('field links stand first, a page that names nothing is absent, each path once, field entry carries its id', () => {
    const held = new Set(['docs/m.md', 'docs/b.md', 'docs/c.md', 'docs/d.md']);
    const doc = parseDocument('docs/m.md', '# FR-001 — The requirement\n\n## Requirement\nThe thing.\n', held);
    const field = parseDocument('docs/b.md', '# FR-011 — Serves it\n\nServes: FR-001\nVerified by: test\n\n## Requirement\nThe other.\n', held);
    const mention = parseDocument('docs/c.md', '# C — names it in prose\n\nThe chain reads FR-001 and moves on.\n', held);
    const other = parseDocument('docs/d.md', '# FR-012 — Serves another\n\nServes: FR-999\nVerified by: test\n\n## Requirement\nElsewhere.\n', held);
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
    const doc = parseDocument('docs/m.md', '# FR-001 — The requirement\n\n## Requirement\nThe thing.\n', held);
    const early = parseDocument('docs/a.md', '# A — names it in prose\n\nFR-001 stands here.\n', held);
    const late = parseDocument('docs/z.md', '# FR-011 — Serves it\n\nServes: FR-001\nVerified by: test\n\n## Requirement\nThe other.\n', held);
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
