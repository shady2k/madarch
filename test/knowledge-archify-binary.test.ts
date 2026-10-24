
import { afterAll, describe, expect, test } from 'bun:test';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderArchifyPage } from '../src/wiki/archify-page.js';
import type { ArchifyDocument } from '../src/wiki/archify.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const VENDOR = join(ROOT, 'vendor', 'archify');
const work = mkdtempSync(join(tmpdir(), 'madarch-archify-render-'));
afterAll(() => rmSync(work, { recursive: true, force: true }));

/** The tree a compiled binary carries: the vendored renderer under `dist/archify`, as `build-wiki-archify.ts` lays it. */
function embeddedApp(): string {
  const app = join(work, 'wiki-app');
  mkdirSync(join(app, 'dist'), { recursive: true });
  cpSync(VENDOR, join(app, 'dist', 'archify', 'vendor', 'archify'), { recursive: true });
  return app;
}

const document: ArchifyDocument = {
  schema_version: 1,
  diagram_type: 'architecture',
  meta: { title: 'The containers', output: 'view.html' },
  components: [
    { id: 'ca', type: 'backend', label: 'payments', sublabel: 'service', pos: [0, 0], size: [180, 70] },
    { id: 'cb', type: 'database', label: 'payments', sublabel: 'database', pos: [320, 0], size: [180, 70] },
  ],
  boundaries: [],
  connections: [{ from: 'ca', to: 'cb', label: 'SQL' }],
};

describe('the archify page a compiled binary draws', () => {
  test('the renderer the binary carries writes a page with an svg in it', async () => {
    const app = embeddedApp();
    const input = join(work, 'document.json');
    const output = join(work, 'rendered.html');
    const rendered = await renderArchifyPage(document, input, output, { app });
    expect(rendered.output).not.toContain('could not');
    expect(rendered.status).toBe(0);
    expect(existsSync(output)).toBe(true);
    const html = readFileSync(output, 'utf8');
    expect(html).toContain('<svg');
    expect(html.length).toBeGreaterThan(10_000);
  }, 120_000);
});
