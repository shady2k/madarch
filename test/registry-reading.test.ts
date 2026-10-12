/**
 * The kinds registry the wiki reads (decision 0021, outcome 3 of the
 * standalone charter): the server reads the product's own kinds registry
 * file (`docs/kinds.yaml`, the file the skill set writes at setup), judged
 * by the contract's own reading; the kinds, their folders and stages and
 * next-step hints drive what the pages and the stage index show; a product
 * with none keeps the plain reading; a file that stands but does not read
 * surfaces the contract's own refusals and keeps the pages plain. The
 * fixture product of the fixed reference — wiki/demo, the set-up case —
 * reads through the registry it carries.
 */
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import { readProductRegistry, registryKit, kindOfPath, kindOfId, REGISTRY_FILE } from '../src/product/registry.js';
import { parseDocument } from '../src/product-wiki/documents.js';
import { parseContractText } from '../src/product/contract.js';
import { openProductWiki } from '../src/product-wiki/pages.js';
import { readStagesIndex } from '../src/wiki/stages.js';

let folder: string | undefined;

const REGISTRY = [
  'stages:',
  '  - id: idea',
  '    name: Idea',
  '  - id: requirements',
  '    name: Requirements',
  '  - id: design',
  '    name: Design',
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
  '  - name: Product requirements',
  '    prefix: FR',
  '    folder: docs/requirements',
  '    stage: requirements',
  '    hint: write what the product does, one requirement at a time',
  '  - name: Decisions',
  '    prefix: D',
  '    folder: docs/decisions',
  '    stage: design',
  '    hint: record the choice between the options on the table',
  ''].join('\n');

function draft(withRegistry: boolean | string = true): string {
  folder = mkdtempSync(join(tmpdir(), 'madarch-registry-'));
  mkdirSync(join(folder, 'docs'), { recursive: true });
  mkdirSync(join(folder, 'model'), { recursive: true });
  mkdirSync(join(folder, 'repos'), { recursive: true });
  mkdirSync(join(folder, 'skills'), { recursive: true });
  mkdirSync(join(folder, 'prototypes'), { recursive: true });
  writeFileSync(join(folder, 'workspace.yaml'), 'schemaVersion: 1\nid: demo\nname: Demo\n');
  if (withRegistry === true) writeFileSync(join(folder, 'docs', 'kinds.yaml'), REGISTRY);
  else if (typeof withRegistry === 'string') writeFileSync(join(folder, 'docs', 'kinds.yaml'), withRegistry);
  return folder;
}

function symlinkRegistry(name: string, target: string): void {
  symlinkSync(target, name);
}

function write(path: string, content: string): void {
  const full = join(folder!, path);
  mkdirSync(full.slice(0, full.lastIndexOf('/')), { recursive: true });
  writeFileSync(full, content);
}

function wiki() {
  const opened = openProductWiki(folder!);
  if (!opened.ok) throw new Error(opened.message);
  return opened.wiki;
}

afterEach(() => {
  if (folder !== undefined) rmSync(folder, { recursive: true, force: true });
  folder = undefined;
});

describe('the kinds registry a product holds', () => {
  test('a product with none reads as one without: nothing is invented, the pages are plain', () => {
    draft(false);
    const read = readProductRegistry(folder!);
    expect(read).toEqual({ present: false });
    const pages = wiki().pages();
    if (!pages.ok) throw new Error(pages.message);
    write('docs/requirements/note.md', '# A note, with no identity line\n\nplain text\n');
    write('docs/requirements/FR-001-tool.md', '# FR-001 — Tool\n\nServes: UC-001\n\n## Requirement\nSomething.\n');
    const readAgain = wiki().pages();
    if (!readAgain.ok) throw new Error(readAgain.message);
    for (const page of readAgain.pages) expect(page.kind).toBeUndefined();
    expect(readAgain.pages).toHaveLength(2);
  });

  test('a valid registry reads whole: the stages in order, the kinds with every field', () => {
    draft();
    const read = readProductRegistry(folder!);
    if (!read.present || !('stages' in read)) throw new Error('the fixture registry must read');
    expect(read.stages).toEqual([
      { id: 'idea', name: 'Idea' },
      { id: 'requirements', name: 'Requirements' },
      { id: 'design', name: 'Design' },
    ]);
    expect(read.kinds).toHaveLength(4);
    expect(read.kinds[0]).toMatchObject({ name: 'Product vision', prefix: 'V', folder: 'docs/vision.md', stage: 'idea', hint: 'write why the product is worth building' });
  });

  test('a bad registry is refused by the contract\u2019s words, the file and the line named', () => {
    draft('stages:\n  - id: idea\nkinds:\n  - name: broken kind\n    prefix: X\n    folder: elsewhere/plain\n    stage: idea\n    hint: x\n');
    const read = readProductRegistry(folder!);
    expect(read).toMatchObject({ present: true });
    if (!read.present || !('refused' in read)) throw new Error('the broken registry must be refused');
    expect(read.refused).toHaveLength(1);
    expect(read.refused[0]!.file).toBe('docs/kinds.yaml');
    expect(read.refused[0]!.line).toBe(6);
    expect(read.refused[0]!.message).toContain('is not a place under the documents');
    // The pages keep the plain behaviour, and the stage index names the
    // refusal the same words.
    const pages = wiki().pages();
    if (!pages.ok) throw new Error(pages.message);
    expect(pages.pages.every((page) => page.kind === undefined)).toBe(true);
    const index = readStagesIndex(folder!);
    expect(index.problems).toEqual([
      { where: 'docs/kinds.yaml', message: 'line 6: kinds[0].folder: "elsewhere/plain" is not a place under the documents: a kind lives inside docs/' },
    ]);
  });

  test('the registry file cannot be smuggled in from outside the product', () => {
    draft(false);
    rmSync(join(folder!, 'docs', 'kinds.yaml'), { force: true });
    write('docs/kinds.yaml', REGISTRY);
    // A symlink standing in the registry place, pointing out of the
    // product, is refused; one pointing at the very place itself reads.
    const inside = join(folder!, 'docs', 'kinds.yaml');
    const real = join(folder!, 'kinds-elsewhere.yaml');
    write('kinds-elsewhere.yaml', REGISTRY);
    rmSync(inside);
    symlinkRegistry(inside, real);
    let read = readProductRegistry(folder!);
    expect(read).toMatchObject({ present: true, refused: [{ file: 'docs/kinds.yaml', line: 0 }] });
    rmSync(inside);
    // A closed loop standing in the registry's place, a self-link: the name
    // exists, the read cannot follow it, so it is refused with its cause,
    // never read as an absence.
    symlinkRegistry(inside, inside);
    read = readProductRegistry(folder!);
    expect(read).toMatchObject({ present: true, refused: [{ file: 'docs/kinds.yaml', line: 0 }] });
    rmSync(inside);
    write('docs/kinds.yaml', REGISTRY);
    read = readProductRegistry(folder!);
    if (!read.present || !('kinds' in read)) throw new Error('the real file must read');
    expect(read.kinds).toHaveLength(4);
  });

  test('a page\u2019s kind comes from an explicit field, then id prefix, then place', () => {
    draft();
    write('docs/vision.md', '# The vision, named by its place\n\nThe words.\n');
    write('docs/sources/S-001-talk.md', '# S-001 — Named by its prefix\n\n## Record\nTalked.\n');
    write('docs/off/FR-009-here.md', '# FR-009 — Named by its prefix, off its folder\n\n## Requirement\nSomething a user can observe.\n');
    write('docs/system/notes.md', '# A note named by an explicit field\n\nKind: product requirements\n\n## Section\nWords.\n');
    const kits = kindOfPath(registryKit(readProductRegistry(folder!))!, 'docs/sources/S-001-talk.md');
    expect(kits?.name).toBe('Sources');
    const byPrefix = wiki().page('docs/off/FR-009-here.md');
    if (!byPrefix.ok) throw new Error(byPrefix.message);
    expect(byPrefix.page.document?.kind).toBe('Product requirements');
    expect(byPrefix.page.document?.id).toBe('FR-009');
    const byPlace = wiki().page('docs/vision.md');
    if (!byPlace.ok) throw new Error(byPlace.message);
    expect(byPlace.page.document?.kind).toBe('Product vision');
    const byField = wiki().page('docs/system/notes.md');
    if (!byField.ok) throw new Error(byField.message);
    expect(byField.page.document?.kind).toBe('Product requirements');
  });

  test('the file kind\u2019s address is used where the product\u2019s own documents name it, nowhere else', () => {
    draft();
    write('docs/vision.md', '# The whole vision\n\nThe words.\n');
    write('docs/sources/S-001-talk.md', '# S-001 — A talk\n\nGrew from: VISION\n\n## Record\nTalked.\n');
    const answer = wiki().page('docs/vision.md');
    if (!answer.ok) throw new Error(answer.message);
    expect(answer.page.document?.id).toBe('VISION');
    expect(answer.page.document?.backlinks.map((b) => b.path)).toEqual(['docs/sources/S-001-talk.md']);
    write('docs/sources/S-002-alone.md', '# S-002 — No one addresses the file\n\n## Record\nNothing mentions it.\n');
    rmSync(join(folder!, 'docs', 'sources', 'S-001-talk.md'));
    const alone = wiki().page('docs/vision.md');
    if (!alone.ok) throw new Error(alone.message);
    expect(alone.page.document?.id).toBeUndefined();
  });
});

describe('the fixed reference: the set-up demo product reads through the registry it carries', () => {
  test('the demo product\u2019s committed registry reads and its pages carry the registry\u2019s kinds', () => {
    const demo = new URL('../wiki/demo/', import.meta.url).pathname;
    const registry = readProductRegistry(demo);
    if (!registry.present || !('stages' in registry)) throw new Error('the demo must carry a registry');
    expect(registry.stages.map((s) => s.id)).toEqual(['idea', 'requirements', 'design', 'build', 'verify', 'release', 'operate']);
    const opened = openProductWiki(demo);
    if (!opened.ok) throw new Error(opened.message);
    const pages = opened.wiki.pages();
    if (!pages.ok) throw new Error(pages.message);
    const kinds = new Map(pages.pages.filter((page) => page.kind !== undefined).map((page) => [page.kind as string, true]));
    for (const name of ['Product vision', 'Sources', 'Hypotheses', 'User stories', 'Use cases', 'Product requirements', 'Decisions', 'Architecture', 'Capabilities', 'Open questions', 'Prototypes', 'Results', 'Practices']) {
      expect(kinds.has(name)).toBe(true);
    }
    expect(pages.pages.find((page) => page.kind === 'Change records')).toBeDefined();
    expect(pages.pages.every((page) => page.path !== 'docs/vision.md' || page.kind === 'Product vision')).toBe(true);
  });

  test('a place that cannot hold a registry file reads as one without: not an absence invented', () => {
    const moved = mkdtempSync(join(tmpdir(), 'madarch-registry-enotdir-'));
    writeFileSync(join(moved, 'docs'), 'planted: docs itself is a file, so docs/kinds.yaml cannot exist\n');
    folder = moved;
    const read = readProductRegistry(folder!);
    expect(read).toEqual({ present: false });
  });

  test('a kind behind the longer folder wins the place’s match, and id prefixes pin the longest first', () => {
    draft(['stages:',
      '  - id: idea',
      '  - id: requirements',
      '  - id: design',
      'kinds:',
      '  - name: Change records',
      '    prefix: CH',
      '    folder: docs/changes',
      '    stage: design',
      '    hint: propose the change',
      '  - name: Decision records',
      '    prefix: D',
      '    folder: docs/changes/decisions',
      '    stage: design',
      '    hint: record the decision',
      '  - name: Notes',
      '    prefix: N',
      '    folder: docs/notes',
      '    stage: idea',
      '    hint: write the note',
      '    ',
      ''].join('\n').replace('    \n', ''));
    write('docs/changes/decisions/0001-own.md', '# 0001. A decision inside another kind\'s walk\n');
    write('docs/changes/0001-mine.md', '# 0001. A change record at the walk\'s root\n');
    const read = readProductRegistry(folder!);
    if (!read.present || !('stages' in read)) throw new Error('the registry must read');
    const kit = registryKit(read);
    if (kit === undefined) throw new Error('the kit must build');
    expect(kindOfPath(kit, 'docs/changes/decisions/0001-own.md')?.name).toBe('Decision records');
    expect(kindOfPath(kit, 'docs/changes/0001-mine.md')?.name).toBe('Change records');
    expect(kindOfId(kit, 'D-001')?.name).toBe('Decision records');
    expect(kindOfId(kit, 'CH-001')?.name).toBe('Change records');
  });

  test('the id shape carries three digits: two-digit or no-number ids are no id of any kind', () => {
    draft();
    const read = readProductRegistry(folder!);
    if (!read.present || !('stages' in read)) throw new Error('the registry must read');
    const kit = registryKit(read);
    if (kit === undefined) throw new Error('the kit must build');
    expect(kit.idShape.test('FR-001')).toBe(true);
    expect(kit.idShape.test('FR-01')).toBe(false);
    expect(kit.idShape.test('FR-1')).toBe(false);
    expect(kit.idShape.test('VISION')).toBe(false);
    const parsed = parseDocument('docs/requirements/FR-01-two.md', '# FR-01 — Two digits\n\nplain\n', new Set(), kit);
    expect(parsed.id).toBeUndefined();
  });
});
