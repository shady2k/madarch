import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseContractText } from '../src/product/contract.js';
import { renderSchema } from '../scripts/generate-schemas.js';
import { KindsRegistry, DocumentFields } from '../src/product/schema.js';
import { parseDocumentFields } from '../src/product/contract.js';

/**
 * The contract of a product repository's kinds registry (decision 0021,
 * outcome 1 of the standalone charter): one JSON schema, the conformance
 * examples, and `bun run contract:check` over them. The test holds the
 * command's own verdicts — every case in `examples/contract/` must read
 * the way its words say — and the published schema's freshness.
 */

const CASES_FILE = fileURLToPath(new URL('../examples/contract/registry-cases.json', import.meta.url));
const REGISTRY_FILE = fileURLToPath(new URL('../examples/contract/registry-product/docs/kinds.yaml', import.meta.url));

const suite = JSON.parse(readFileSync(CASES_FILE, 'utf8')) as { about: string; cases: { name: string; text: string | null; line?: number; path?: string; message?: string }[] };

describe('the contract of a product repository kinds registry', () => {
  test('every registry case of the examples reads the way its words say', () => {
    const mismatches: string[] = [];
    for (const one of suite.cases) {
      if (one.text === null) {
        mismatches.push(`${one.name}: carries no text`);
        continue;
      }
      const read = parseContractText('docs/kinds.yaml', one.text);
      if (one.message === undefined) {
        if (!read.ok) {
          const first = read.errors[0]!;
          mismatches.push(`${one.name}: expected the registry to read, got refused at line ${first.line}: ${first.message}`);
        }
        continue;
      }
      const named = read.ok
        ? false
        : read.errors.some((error) => error.line === (one.line ?? 1) && error.message.includes(one.message!) && (one.path === undefined || error.path === one.path));
      if (!named) {
        const held = read.ok ? 'read as ok' : read.errors.map((error) => `${error.line}: ${error.message}`).join('; ');
        mismatches.push(`${one.name}: expected a refusal on line ${one.line ?? 1} naming ${JSON.stringify(one.message)}, got ${held}`);
      }
    }
    expect(mismatches).toEqual([]);
  });

  test('the example product with a registry reads its kinds and its stage order whole', () => {
    const read = parseContractText('docs/kinds.yaml', readFileSync(REGISTRY_FILE, 'utf8'));
    expect(read).toMatchObject({ ok: true });
    if (!read.ok) return;
    expect(read.stages.map((s) => s.id)).toEqual(['idea', 'requirements', 'design', 'build', 'verify', 'release', 'operate']);
    expect(read.contract).toBe(1);
    expect(read.kinds).toHaveLength(7);
    const p = read.kinds.find((k) => k.prefix === 'FR');
    expect(p).toMatchObject({ name: 'product requirement', folder: 'docs/requirements', stage: 'requirements' });
    expect(typeof p!.hint).toBe('string');
    expect(p!.hint.trim().length).toBeGreaterThan(0);
    // The owner's example, declared as data (the refinement of 2026-10-12):
    // a user story serves a use case and grew from a source or a
    // hypothesis, with the backlink the target's page shows.
    const us = read.kinds.find((k) => k.prefix === 'US');
    expect(us).toMatchObject({ name: 'user story', stage: 'requirements' });
    expect(us!.statuses).toEqual(['draft', 'ready']);
    expect(us!.links).toEqual([
      { field: 'Grew from', targets: ['source', 'hypothesis'], backlink: 'Grew into', cardinality: 'many', required: false },
      { field: 'Serves', targets: ['use case'], backlink: 'Served by', cardinality: 'one', required: true },
    ]);
    // The 0021 amendment's reservations, kept as data the example carries:
    // the fact storage form with its evidence shape, and the goals section
    // the engine names instead of dropping.
    const ci = read.kinds.find((k) => k.prefix === 'CI');
    expect(ci).toMatchObject({ name: 'configuration item', storage: 'fact', evidence: { source: 'Source', ref: 'Ref', record: 'Record' } });
    expect(read.reservations.map((r) => r.path)).toEqual(['kinds[6].storage', 'kinds[6].evidence', 'goals']);
    expect(read.reservations.map((r) => r.line)).toEqual([105, 106, 114]);
    expect(read.reservations[2]!.message).toContain('reserved goals section');
    expect(read.goals).toEqual([
      { name: 'grounded', perspective: 'business', rules: ['every use case links a user story', 'every product requirement serves a use case or a user story'] },
      { name: 'true-to-the-systems', perspective: 'ops', rules: ['every imported fact names its source system and record'] },
    ]);
  });

  test('the contract version gate names the version it does not know, for the wiki to serve', () => {
    const refused = parseContractText('docs/kinds.yaml', 'contract: 99\nstages:\n  - id: idea\nkinds: []\n');
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    const version = refused.errors.find((error) => error.version !== undefined);
    expect(version).toBeDefined();
    expect(version!.version).toBe(99);
    expect(version!.line).toBe(1);
    expect(version!.path).toBe('contract');
    expect(version!.message).toContain('declares contract 99');
    expect(version!.message).toContain('this madarch reads contract 1');
    const carried = parseContractText('docs/kinds.yaml', 'contract: 1\nstages:\n  - id: idea\nkinds: []\n');
    expect(carried.ok).toBe(true);
    if (!carried.ok) return;
    expect(carried.contract).toBe(1);
  });

  test("a link's targets name kinds of the registry: the unknown one is refused at its line", () => {
    const read = parseContractText('docs/kinds.yaml', [
      'contract: 1',
      'stages:',
      '  - id: idea',
      '  - id: requirements',
      'kinds:',
      '  - name: product requirement',
      '    prefix: FR',
      '    folder: docs/requirements',
      '    stage: requirements',
      '    hint: write what the product does',
      '    links:',
      '      - field: Serves',
      '        targets:',
      '          - no such kind',
      ''].join('\n'));
    expect(read.ok).toBe(false);
    if (read.ok) return;
    const named = read.errors.find((error) => error.line === 14 && error.path === 'kinds[0].links[0].targets[0]' && error.message.includes('"no such kind" names no kind of the registry'));
    expect(named).toBeDefined();
  });

  test('a kind declares one link a field: the second is refused, the first line named', () => {
    const read = parseContractText('docs/kinds.yaml', [
      'contract: 1',
      'stages:',
      '  - id: requirements',
      'kinds:',
      '  - name: product requirement',
      '    prefix: FR',
      '    folder: docs/requirements',
      '    stage: requirements',
      '    hint: write what the product does',
      '    links:',
      '      - field: Serves',
      '        targets: [user story]',
      '      - field: serves',
      '        targets: [user story]',
      '  - name: user story',
      '    prefix: US',
      '    folder: docs/stories',
      '    stage: requirements',
      '    hint: write what one user does',
      ''].join('\n'));
    expect(read.ok).toBe(false);
    if (read.ok) return;
    const named = read.errors.find((error) => error.line === 13 && error.path === 'kinds[0].links[1].field' && error.message.includes('is declared twice, first on line 11'));
    expect(named).toBeDefined();
  });

  test('an allowed status is named once: the second is refused at its line', () => {
    const read = parseContractText('docs/kinds.yaml', [
      'contract: 1',
      'stages:',
      '  - id: design',
      'kinds:',
      '  - name: decision',
      '    prefix: D',
      '    folder: docs/decisions',
      '    stage: design',
      '    hint: record the choice',
      '    statuses:',
      '      - accepted',
      '      - Accepted',
      ''].join('\n'));
    expect(read.ok).toBe(false);
    if (read.ok) return;
    const named = read.errors.find((error) => error.line === 12 && error.path === 'kinds[0].statuses[1]' && error.message.includes('the status "Accepted" is named twice'));
    expect(named).toBeDefined();
  });

  test('a kind\'s declared links and statuses read whole: field, targets, backlink label, cardinality and required', () => {
    const read = parseContractText('docs/kinds.yaml', [
      'contract: 1',
      'stages:',
      '  - id: requirements',
      'kinds:',
      '  - name: product requirement',
      '    prefix: FR',
      '    folder: docs/requirements',
      '    stage: requirements',
      '    hint: write what the product does',
      '    statuses: [draft, accepted]',
      '    links:',
      '      - field: Serves',
      '        targets: [user story]',
      '        backlink: Served by',
      '        cardinality: one',
      '        required: true',
      '  - name: user story',
      '    prefix: US',
      '    folder: docs/stories',
      '    stage: requirements',
      '    hint: write what one user does',
      ''].join('\n'));
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    const fr = read.kinds.find((kind) => kind.prefix === 'FR');
    expect(fr?.statuses).toEqual(['draft', 'accepted']);
    expect(fr?.links).toEqual([{ field: 'Serves', targets: ['user story'], backlink: 'Served by', cardinality: 'one', required: true }]);
  });

  test("a document that cannot be parsed is refused with the parser's own words, before the schema is asked", () => {
    const read = parseContractText('docs/kinds.yaml', 'stages:\n  - id: idea\nkinds: [unclosed\n');
    expect(read.ok).toBe(false);
    if (read.ok) return;
    // The refusal is the YAML parser's own message, at the line it names: the schema's failures for an unparseable document are never the words the reader prints.
    const parsed = read.errors.find((error) => error.message.includes('end with a ]'));
    expect(parsed).toBeDefined();
    expect(parsed!.line).toBe(4);
    expect(parsed!.path).toBe('');
  });

  test('a registry that is no mapping at all is the schema refusal, not the version gate', () => {
    const nothing = parseContractText('docs/kinds.yaml', 'null\n');
    expect(nothing.ok).toBe(false);
    if (nothing.ok) return;
    expect(nothing.errors.some((error) => /object/.test(error.message))).toBe(true);
    const word = parseContractText('docs/kinds.yaml', 'just a word\n');
    expect(word.ok).toBe(false);
    if (word.ok) return;
    expect(word.errors.some((error) => /object/.test(error.message))).toBe(true);
  });

  test('the version gate names the whole number only at the field\'s own line, not the document\'s first', () => {
    const refused = parseContractText('docs/kinds.yaml', '# the kinds registry\ncontract: "one"\n');
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    const missing = refused.errors[0];
    expect(missing!.line).toBe(2);
    expect(missing!.path).toBe('contract');
    // The field's own line, wherever it stands: a version carried late in the
    // file is refused at that line, not at the document's first content line.
    const late = parseContractText('docs/kinds.yaml', 'stages:\n  - id: idea\nkinds: []\ncontract: 99\n');
    expect(late.ok).toBe(false);
    if (late.ok) return;
    const unknown = late.errors.find((error) => error.version !== undefined);
    expect(unknown!.line).toBe(4);
    expect(unknown!.version).toBe(99);
  });

  test('the published product-registry and product-document schemas match the TypeBox sources', () => {
    const published = readFileSync(fileURLToPath(new URL('../schema/product-registry.schema.json', import.meta.url)), 'utf8');
    expect(published).toBe(renderSchema(KindsRegistry));
    const docPublished = readFileSync(fileURLToPath(new URL('../schema/product-document.schema.json', import.meta.url)), 'utf8');
    expect(docPublished).toBe(renderSchema(DocumentFields));
  });

  test('the check command runs the whole examples folder and exits 0', () => {
    const run = Bun.spawnSync(['bun', 'scripts/check-contract.ts'], { cwd: fileURLToPath(new URL('..', import.meta.url)) });
    expect(run.exitCode).toBe(0);
    expect(new TextDecoder().decode(run.stdout)).toContain('0 misread');
  });

  test("a document header's generic fields read through the examples' own readings", () => {
    const read = parseDocumentFields('docs/FR-001.md', '# FR-001 — List\n\nId: FR-001\nStatus: open\nKind: product requirement\nLinks: S-001, H-001\n\n## Record\nthe cafe throws away ten portions.\n');
    expect(read).toEqual({ ok: true, fields: { id: 'FR-001', status: 'open', kind: 'product requirement', links: ['S-001', 'H-001'] } });
    const refused = parseDocumentFields('docs/FR-001.md', '# FR-001 — List\n\nId: FR-001\nId: FR-002\n\n## Record\nthe cafe throws away ten portions.\n');
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.errors[0]).toMatchObject({ line: 4, path: 'id' });
    expect(refused.errors[0]!.message).toContain('a field is given once');
  });

  test('a status and a kind are words', () => {
    const refused = parseDocumentFields('docs/S-001.md', '# S-001 — Talk\n\nStatus: 2026-10-09\nKind: conversation\n\n## Record\nthe cafe.\n');
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.errors[0]).toMatchObject({ line: 3, path: 'status' });
    const read = parseDocumentFields('docs/S-001.md', '# S-001 — Talk\n\nStatus: open\nKind: conversation\nLinks: S-001\nLinks: H-001\n\n## Record\nthe cafe.\n');
    expect(read).toEqual({ ok: true, fields: { status: 'open', kind: 'conversation', links: ['S-001', 'H-001'] } });
  });

  test('the example product folders parse as the schema expects them whole', () => {
    // The two conforming examples stand on `examples/contract/`, the way
    // the reference system example stands on `examples/reference-system/`.
    for (const folder of ['plain-product', 'registry-product']) {
      const manifest = readFileSync(fileURLToPath(new URL(`../examples/contract/${folder}/workspace.yaml`, import.meta.url)), 'utf8');
      expect(manifest.startsWith('schemaVersion: 1')).toBe(true);
    }
  });
});
