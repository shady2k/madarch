import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The misread lines of `bun run contract:check` (scripts/check-contract.ts)
 * must name the cases file the failing case came from, so a reader can go
 * from a red line to the file to edit. The test misreads temporary copies of
 * the two cases files — one registry case, one document case, each with a
 * wrong expected message — runs the checker over them and asserts each
 * printed error carries the temporary file's path, the case name and the
 * line the refusal was raised on.
 */

const REGISTRY_CASES = fileURLToPath(new URL('../examples/contract/registry-cases.json', import.meta.url));
const DOCUMENT_CASES = fileURLToPath(new URL('../examples/contract/document-cases.json', import.meta.url));
const PRODUCTS = fileURLToPath(new URL('../examples/contract', import.meta.url));

describe('check-contract misread lines name their cases file', () => {
  test('a misread registry case and a misread document case print the cases file path, case name and line', () => {
    const registry = JSON.parse(readFileSync(REGISTRY_CASES, 'utf8')) as {
      cases: { name: string; line?: number; path?: string; message?: string }[];
    };
    const documents = JSON.parse(readFileSync(DOCUMENT_CASES, 'utf8')) as {
      cases: { name: string; text: string | null; ok?: Record<string, unknown> | null; line?: number; path?: string; message?: string }[];
    };

    // One registry case: keep its shape, expect a message no refusal carries.
    const registryCase = { ...registry.cases.find((c) => c.message !== undefined)! };
    registryCase.name = 'misread-by-test';
    registryCase.message = 'no refusal names this sentence';

    // One document case: keep its shape, expect a message no refusal carries.
    const documentCase = { ...documents.cases.find((c) => c.message !== undefined)! };
    documentCase.name = 'misread-by-test';
    documentCase.message = 'no refusal names this sentence';

    const home = mkdtempSync(join(tmpdir(), 'check-contract-test-'));
    try {
      const registryCopy = join(home, 'registry-cases.json');
      const documentCopy = join(home, 'document-cases.json');
      writeFileSync(registryCopy, JSON.stringify({ ...registry, cases: [registryCase] }));
      writeFileSync(documentCopy, JSON.stringify({ ...documents, cases: [documentCase] }));

      const proc = Bun.spawnSync(['bun', 'scripts/check-contract.ts', '--cases', registryCopy, '--documents', documentCopy, '--products', PRODUCTS]);
      const out = new TextDecoder().decode(proc.stdout) + new TextDecoder().decode(proc.stderr);

      expect(proc.exitCode).toBe(1);
      for (const where of [registryCopy, documentCopy]) {
        const lines = out.split('\n').filter((line) => line.includes(where));
        expect(lines).toHaveLength(1);
        expect(lines[0]).toMatch(/case (document )?misread-by-test/);
        expect(lines[0]).toMatch(/on line \d+ naming/);
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
