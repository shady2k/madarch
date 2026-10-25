
import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ArchifyDocument } from '../src/wiki/archify.js';
import { renderArchifyPage } from '../src/wiki/archify-page.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const VENDOR = join(ROOT, 'vendor', 'archify');
const work = mkdtempSync(join(tmpdir(), 'madarch-archify-render-'));
afterAll(() => rmSync(work, { recursive: true, force: true }));

/** The tree a compiled binary carries: the vendored renderer under `dist/archify`, as `build-wiki-archify.ts` lays it. */
function embeddedApp(): string {
  const app = join(work, 'wiki-app');
  mkdirSync(join(app, 'dist'), { recursive: true });
  writeFileSync(join(app, 'dist', 'index.html'), '<div id="root"></div>');
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
  test('a compiled renderer runs its embedded asset outside the checkout and writes rendered.html with an svg', () => {
    const app = embeddedApp();
    const input = join(work, 'document.json');
    const output = join(work, 'rendered.html');
    writeFileSync(input, JSON.stringify(document));
    const entry = join(work, 'entry.ts');
    writeFileSync(entry, `import { renderArchifyPage } from ${JSON.stringify(join(ROOT, 'src/wiki/archify-page.ts'))};
import { readFileSync } from 'node:fs';
const [input, output] = process.argv.slice(2);
const result = await renderArchifyPage(JSON.parse(readFileSync(input, 'utf8')), input, output);
console.log(result.output);
process.exitCode = result.status ?? 1;
`);
    const binary = join(work, 'render');
    const built = spawnSync(process.execPath, ['build', '--compile', entry, '--asset', app, '--outfile', binary], { encoding: 'utf8', timeout: 90_000 });
    expect(`${built.stdout}${built.stderr}`).not.toContain('error:');
    expect(built.status).toBe(0);
    const run = spawnSync(binary, [input, output], { cwd: work, encoding: 'utf8', timeout: 90_000 });
    expect(`${run.stdout}${run.stderr}`).not.toContain('error:');
    expect(run.status).toBe(0);
    expect(existsSync(output)).toBe(true);
    const html = readFileSync(output, 'utf8');
    expect(html).toContain('<svg');
    expect(html.length).toBeGreaterThan(10_000);
  }, 120_000);
});


test('a missing embedded renderer names its full path and line', async () => {
  const app=join(work,'missing-app');
  const result=await renderArchifyPage(document,join(work,'missing.json'),join(work,'missing.html'),{app});
  expect(result.status).toBe(1);
  expect(result.output).toContain(join(app,'dist','archify','vendor','archify','renderers','architecture','render-architecture.mjs')+':1:');
});

test('renderer exit 1 retains the renderer diagnostic rather than claiming a drawing', async () => {
  const app=join(work,'failing-app');
  const renderer=join(app,'dist','archify','vendor','archify','renderers','architecture','render-architecture.mjs');
  mkdirSync(dirname(renderer),{recursive:true});
  writeFileSync(renderer,'console.error(import.meta.path + ":1: invalid diagram fixture"); process.exit(1);');
  const result=await renderArchifyPage(document,join(work,'failure.json'),join(work,'failure.html'),{app});
  expect(result.status).toBe(1); expect(result.output).toContain(':1: invalid diagram fixture');
  expect(existsSync(join(work,'failure.html'))).toBe(false);
});
