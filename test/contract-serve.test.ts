import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import { startServer, type StartedServer } from '../src/index.js';

/**
 * A served wiki with the product's kinds registry (the owner's refinement
 * of decision 0021, contract v1): the registry's version rides the pages
 * answer, so the served wiki names a contract version the engine does not
 * read and degrades to plain pages, never failing silently.
 */

let folder: string | undefined;
let server: StartedServer | undefined;

function productWithRegistry(text: string): void {
  folder = mkdtempSync(join(tmpdir(), 'madarch-contract-serve-'));
  writeFileSync(join(folder, 'workspace.yaml'), 'schemaVersion: 1\nid: demo\nname: Demo\n');
  mkdirSync(join(folder, 'docs', 'decisions'), { recursive: true });
  mkdirSync(join(folder, 'app'), { recursive: true });
  writeFileSync(join(folder, 'docs', 'decisions', 'D-001.md'), '# D-001 — One decision\n\nrecorded here\n');
  writeFileSync(join(folder, 'docs', 'kinds.yaml'), text);
  writeFileSync(join(folder, 'app', 'index.html'), '<!doctype html><title>t</title>');
}

afterEach(async () => {
  await server?.stop();
  server = undefined;
  if (folder !== undefined) rmSync(folder, { recursive: true, force: true });
  folder = undefined;
});

describe('the served wiki and the product registry', () => {
  test('a product with no registry keeps the answer it had before registries', async () => {
    folder = mkdtempSync(join(tmpdir(), 'madarch-contract-serve-'));
    writeFileSync(join(folder, 'workspace.yaml'), 'schemaVersion: 1\nid: demo\nname: Demo\n');
    mkdirSync(join(folder, 'docs', 'decisions'), { recursive: true });
    mkdirSync(join(folder, 'app'), { recursive: true });
    writeFileSync(join(folder, 'docs', 'decisions', 'D-001.md'), '# D-001 — One decision\n\nrecorded here\n');
    writeFileSync(join(folder, 'app', 'index.html'), '<!doctype html><title>t</title>');
    server = await startServer({ productFolder: folder, port: 0, appFolder: join(folder, 'app'), log: () => {}, errorLog: () => {} });
    const listed = (await (await fetch(`${server.url}/api/pages`)).json()) as Record<string, unknown>;
    expect('contract' in listed).toBe(false);
    expect(Array.isArray(listed.pages)).toBe(true);
    expect((listed.pages as unknown[]).length).toBe(1);
  });

  test('a registry of contract 99 is named by the served pages answer, and the pages serve plain', async () => {
    productWithRegistry('contract: 99\nstages:\n  - id: idea\nkinds:\n  - name: decision\n    prefix: D\n    folder: docs/decisions\n    stage: idea\n    hint: one\n');
    server = await startServer({ productFolder: folder!, port: 0, appFolder: join(folder!, 'app'), log: () => {}, errorLog: () => {} });
    const list = (await (await fetch(`${server.url}/api/pages`)).json()) as { pages: { kind?: string }[]; contract?: { known: boolean; version?: number; message: string } };
    expect(list.contract).toEqual({ known: false, version: 99, message: 'docs/kinds.yaml:1: contract: the registry declares contract 99; this madarch reads contract 1 — the wiki serves these pages as plain documents' });
    expect(list.pages.map((entry) => entry.kind)).toEqual([undefined]);

    const asked = (await (await fetch(`${server.url}/api/page?path=docs/decisions/D-001.md`)).json()) as { document?: unknown; markdown: string };
    expect(asked.document).toBeUndefined();
    expect(asked.markdown).toContain('recorded here');

    // appending the version the engine reads: the served wiki regroups
    writeFileSync(join(folder!, 'docs', 'kinds.yaml'), 'contract: 1\nstages:\n  - id: idea\nkinds:\n  - name: decision\n    prefix: D\n    folder: docs/decisions\n    stage: idea\n    hint: one\n');
    const after = (await (await fetch(`${server.url}/api/pages`)).json()) as { pages: { kind?: string }[]; contract?: { known: boolean; version: number } };
    expect(after.contract).toEqual({ known: true, version: 1 });
    expect(after.pages.map((entry) => entry.kind)).toEqual(['decision']);
  });
});
