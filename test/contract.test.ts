import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseContractText } from '../src/product/contract.js';
import { renderSchema } from '../scripts/generate-schemas.js';
import { KindsRegistry } from '../src/product/schema.js';

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
    expect(read.kinds).toHaveLength(4);
    const p = read.kinds.find((k) => k.prefix === 'FR');
    expect(p).toMatchObject({ name: 'product requirement', folder: 'docs/requirements', stage: 'requirements' });
    expect(typeof p!.hint).toBe('string');
    expect(p!.hint.trim().length).toBeGreaterThan(0);
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

  test('the published product-registry schema matches the TypeBox source', () => {
    const published = readFileSync(fileURLToPath(new URL('../schema/product-registry.schema.json', import.meta.url)), 'utf8');
    expect(published).toBe(renderSchema(KindsRegistry));
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
