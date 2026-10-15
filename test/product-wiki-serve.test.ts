import { mkdtempSync, mkdirSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import { serveWiki, type ServeResult } from '../src/product-wiki/serve.js';
import type { StartedServer } from '../src/server/http.js';

const folders: string[] = [];
const servers: StartedServer[] = [];

function scratch(): string {
  const folder = mkdtempSync(join(tmpdir(), 'madarch-product-wiki-serve-'));
  folders.push(folder);
  return folder;
}

function builtApp(base: string): string {
  const appFolder = join(base, 'app');
  mkdirSync(join(appFolder, 'dist'), { recursive: true });
  writeFileSync(join(appFolder, 'dist', 'index.html'), '<!doctype html><title>test app</title>');
  return appFolder;
}

function serving(result: ServeResult): Extract<ServeResult, { outcome: 'serving' }> {
  if (result.outcome !== 'serving') throw new Error(`expected a serving result, got ${result.outcome}: ${result.message}`);
  servers.push(result.server);
  return result;
}

afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop();
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

describe('serveWiki with a product or a manifestless directory', () => {
  test('serves the empty current folder with a temporary name and no product id or writes', async () => {
    const base = scratch();
    const folder = join(base, 'empty-home');
    mkdirSync(folder);
    const before = readdirSync(folder);
    const result = serving(await serveWiki({ cwd: folder, appFolder: builtApp(base), port: 0, open: false, print: () => {}, printError: () => {} }));
    const product = await (await fetch(`${result.url}/api/product`)).json() as { id?: string; name: string; folder: string };
    expect(product).toEqual({ name: 'empty-home', folder: 'empty-home' });
    const pages = await (await fetch(`${result.url}/api/pages`)).json() as { revision: string; pages: unknown[] };
    expect(pages.revision).not.toBe('');
    expect(pages.pages).toEqual([]);
    expect(readdirSync(folder)).toEqual(before);
  });

  test('preserves the manifest identity for a valid product', async () => {
    const base = scratch();
    const folder = join(base, 'valid-product');
    mkdirSync(folder);
    writeFileSync(join(folder, 'workspace.yaml'), 'schemaVersion: 1\nid: manifest-id\nname: Manifest name\n');
    const result = serving(await serveWiki({ productFolder: folder, appFolder: builtApp(base), port: 0, open: false, print: () => {}, printError: () => {} }));
    const product = await (await fetch(`${result.url}/api/product`)).json() as { id: string; name: string; folder: string };
    expect(product).toEqual({ id: 'manifest-id', name: 'Manifest name', folder: 'valid-product' });
  });

  test('serves a no-manifest directory with non-page files by explicit path', async () => {
    const base = scratch();
    const folder = join(base, 'no-manifest');
    mkdirSync(folder);
    writeFileSync(join(folder, 'notes.txt'), 'not a wiki page');
    const before = readdirSync(folder);
    const result = serving(await serveWiki({ productFolder: folder, appFolder: builtApp(base), port: 0, open: false, print: () => {}, printError: () => {} }));
    const product = await (await fetch(`${result.url}/api/product`)).json() as { id?: string; name: string; folder: string };
    expect(product).toEqual({ name: 'no-manifest', folder: 'no-manifest' });
    const pages = await (await fetch(`${result.url}/api/pages`)).json() as { pages: unknown[] };
    expect(pages.pages).toEqual([]);
    expect(readdirSync(folder)).toEqual(before);
  });

  test('does not fall back for a missing path, non-directory, invalid manifest or dangling manifest symlink', async () => {
    const base = scratch();
    const appFolder = builtApp(base);
    const missingPath = join(base, 'missing');
    const absent = await serveWiki({ productFolder: missingPath, appFolder, port: 0, open: false, print: () => {}, printError: () => {} });
    expect(absent.outcome).toBe('refused');
    if (absent.outcome === 'refused') {
      expect(absent.message).toContain(missingPath);
      expect(absent.message).toContain('workspace.yaml');
    }

    const file = join(base, 'file');
    writeFileSync(file, 'not a directory');
    expect((await serveWiki({ productFolder: file, appFolder, port: 0, open: false, print: () => {}, printError: () => {} })).outcome).toBe('refused');

    const invalid = join(base, 'invalid');
    mkdirSync(invalid);
    writeFileSync(join(invalid, 'workspace.yaml'), 'schemaVersion: 999\n');
    expect((await serveWiki({ productFolder: invalid, appFolder, port: 0, open: false, print: () => {}, printError: () => {} })).outcome).toBe('refused');

    const dangling = join(base, 'dangling');
    mkdirSync(dangling);
    symlinkSync(join(dangling, 'missing-target.yaml'), join(dangling, 'workspace.yaml'));
    expect((await serveWiki({ productFolder: dangling, appFolder, port: 0, open: false, print: () => {}, printError: () => {} })).outcome).toBe('refused');
  });
});
