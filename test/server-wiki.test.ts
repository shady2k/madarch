import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import { startServer, type StartedServer } from '../src/index.js';

/** A compiled-model element shaped like the server's tests use, so the sent model is a real one. */
function element(id: string): Record<string, unknown> {
  return { id, kind: 'service', ancestors: [], zones: [], zonesByEnvironment: {}, environments: ['*'], states: ['as-is'] };
}

/** A compiled model holding the given elements: the shape `POST /models` takes. */
function model(elements: Record<string, unknown>[]): Record<string, unknown> {
  return { schemaVersion: 1, elements, interfaces: [], relations: [], categories: [], entities: [], scenarios: [], zones: [], environments: [], states: [{ id: 'as-is' }] };
}

/**
 * The server's product mode (docs/changes/draft-product/capabilities/server.md,
 * requirement `serves-wiki`): a server given a product folder serves that
 * product's wiki — the API the app reads, and the app's built files from the
 * app folder it is given — refusing what it cannot answer, logging one
 * line per request with no document content, changing nothing in the
 * product. Sent models and a product's wiki stay apart when both are
 * given; started with neither it refuses to start.
 */

let folder: string | undefined;
let appFolder: string | undefined;
let server: StartedServer | undefined;
let lines: string[] = [];
let errors: string[] = [];

function draft(): string {
  folder = mkdtempSync(join(tmpdir(), 'madarch-wiki-server-'));
  mkdirSync(join(folder, 'docs'), { recursive: true });
  writeFileSync(join(folder, 'workspace.yaml'), 'schemaVersion: 1\nid: demo\nname: Demo\n');
  writeFileSync(join(folder, 'docs', 'vision.md'), '# Vision\n\nWhat it is for.\n');
  return folder;
}

/** The app's built files: minimal stand-ins for stage 2's build. */
function builtApp(): string {
  appFolder = mkdtempSync(join(tmpdir(), 'madarch-wiki-app-'));
  writeFileSync(join(appFolder, 'index.html'), '<!doctype html><title>demo wiki</title>');
  const assets = join(appFolder, 'assets');
  mkdirSync(assets, { recursive: true });
  writeFileSync(join(assets, 'app.js'), 'export const app = 1;\n');
  writeFileSync(join(assets, 'style.css'), 'body { color: black }\n');
  return appFolder;
}

afterEach(() => {
  server?.stop();
  server = undefined;
  if (appFolder !== undefined) rmSync(appFolder, { recursive: true, force: true });
  appFolder = undefined;
  if (folder !== undefined) rmSync(folder, { recursive: true, force: true });
  folder = undefined;
});

function startProduct(): string {
  lines = [];
  errors = [];
  server = startServer({
    productFolder: folder!,
    appFolder,
    port: 0,
    log: (line) => lines.push(line),
    errorLog: (line) => errors.push(line),
  });
  return server.url;
}

describe('the server\'s product mode', () => {
  test('GET /api/product names the product\'s id and name', async () => {
    draft();
    builtApp();
    const url = startProduct();
    const answer = await fetch(`${url}/api/product`);
    expect(answer.status).toBe(200);
    expect(await answer.json()).toEqual({ id: 'demo', name: 'Demo' });
  });

  test('GET /api/pages lists the pages with paths, titles, addresses and the revision', async () => {
    draft();
    builtApp();
    writeFileSync(join(folder!, 'docs', 'a-notes.md'), 'no heading\n');
    const url = startProduct();
    const answer = await fetch(`${url}/api/pages`);
    expect(answer.status).toBe(200);
    const body = (await answer.json()) as { revision: string; pages: { path: string; title: string; address: string }[] };
    expect(body.pages).toEqual([
      { path: 'docs/a-notes.md', title: 'a-notes', address: '/p/docs/a-notes.md' },
      { path: 'docs/vision.md', title: 'Vision', address: '/p/docs/vision.md' },
    ]);
    expect(body.revision).toBe((await (await fetch(`${url}/api/pages`)).json() as typeof body).revision);
  });

  test('GET /api/page gives one page whole; asking twice after a save gives the new bytes', async () => {
    draft();
    builtApp();
    const url = startProduct();
    const first = await fetch(`${url}/api/page?path=docs%2Fvision.md`);
    expect(first.status).toBe(200);
    const body = (await first.json()) as { path: string; title: string; markdown: string };
    expect(body.title).toBe('Vision');
    expect(body.markdown).toBe('# Vision\n\nWhat it is for.\n');
    writeFileSync(join(folder!, 'docs', 'vision.md'), '# Vision\n\nWhat it is for, now twice.\n');
    const second = await fetch(`${url}/api/page?path=docs/vision.md`);
    const body2 = (await second.json()) as { markdown: string };
    expect(body2.markdown).toBe('# Vision\n\nWhat it is for, now twice.\n');
  });

  test('a missing page, and a path outside the wiki, are refused with the path named', async () => {
    draft();
    builtApp();
    const url = startProduct();
    const missing = await fetch(`${url}/api/page?path=docs/other.md`);
    expect(missing.status).toBe(404);
    const body = (await missing.json()) as { message: string };
    expect(body.message).toContain('docs/other.md');
    const climbing = await fetch(`${url}/api/page?path=..%2FAGENTS.md`);
    expect(climbing.status).toBe(404);
    const climbed = (await climbing.json()) as { message: string };
    expect(climbed.message).toContain('AGENTS.md');
    const noPath = await fetch(`${url}/api/page`);
    expect(noPath.status).toBe(400);
    expect(((await noPath.json()) as { message: string }).message).toContain('"path"');
  });

  test('the app\'s files are served, and a path the app does not hold answers index.html', async () => {
    draft();
    builtApp();
    const url = startProduct();
    const root = await fetch(`${url}/`);
    expect(root.status).toBe(200);
    expect(await root.text()).toContain('demo wiki');
    const script = await fetch(`${url}/assets/app.js`);
    expect(script.status).toBe(200);
    expect(await script.text()).toBe('export const app = 1;\n');
    expect(script.headers.get('content-type')).toContain('javascript');
    const deep = await fetch(`${url}/p/docs/vision.md`);
    expect(deep.status).toBe(200);
    expect(await deep.text()).toContain('demo wiki');
    expect(deep.headers.get('content-type')).toContain('html');
  });

  test('static serving and the fallback answer GET and HEAD only; other methods are refused with 405', async () => {
    draft();
    builtApp();
    const url = startProduct();
    const postRoot = await fetch(`${url}/`, { method: 'POST' });
    expect(postRoot.status).toBe(405);
    const postRoute = await fetch(`${url}/p/docs/vision.md`, { method: 'POST' });
    expect(postRoute.status).toBe(405);
    const postAsset = await fetch(`${url}/assets/app.js`, { method: 'POST' });
    expect(postAsset.status).toBe(405);
    const put = await fetch(`${url}/`, { method: 'PUT' });
    expect(put.status).toBe(405);
    const still = await fetch(`${url}/`);
    expect(still.status).toBe(200);
    expect(await still.text()).toContain('demo wiki');
    const headed = await fetch(`${url}/`, { method: 'HEAD' });
    expect(headed.status).toBe(200);
    void headed;
  });

  test('the fallback answers only the app\'s own routes; an unknown path or a missing asset is a named 404 (finding 6)', async () => {
    draft();
    builtApp();
    const url = startProduct();
    // A page address the wiki's routes answer falls back to the app.
    const page = await fetch(`${url}/p/docs/vision.md`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('demo wiki');
    // A named asset that is missing is a 404 naming the path.
    const missingAsset = await fetch(`${url}/assets/missing.js`);
    expect(missingAsset.status).toBe(404);
    expect(((await missingAsset.json()) as { message: string }).message).toContain('/assets/missing.js');
    // Any other unsupported path is a named 404 too, never index.html.
    for (const asked of ['/models', '/typo']) {
      const answer = await fetch(`${url}${asked}`);
      expect(answer.status).toBe(404);
      const body = (await answer.json()) as { message: string };
      expect(body.message).toContain(asked);
    }
  });

  test('a path under /api that nothing answers is refused with JSON naming it', async () => {
    draft();
    builtApp();
    const url = startProduct();
    const answer = await fetch(`${url}/api/unknown`);
    expect(answer.status).toBe(404);
    const body = (await answer.json()) as { message: string };
    expect(body.message).toContain('/api/unknown');
    void body;
  });

  test('the log line carries method, path, status and no document content', async () => {
    draft();
    builtApp();
    const url = startProduct();
    await fetch(`${url}/api/page?path=docs/vision.md`);
    await fetch(`${url}/api/nothing`);
    const about = lines.filter((line) => line.startsWith('GET /api/page'));
    expect(about).toHaveLength(1);
    expect(about[0]).toMatch(/GET \/api\/page 200 .*ms$/);
    expect(about[0]).not.toContain('What it is for');
    expect(about[0]).not.toContain('# Vision');
    const refused = lines.filter((line) => line.startsWith('GET /api/nothing'));
    expect(refused).toHaveLength(1);
    expect(errors).toEqual([]);
  });

  test('serving changes nothing in the product: its files and git status are untouched', async () => {
    draft();
    initGit();
    const commit = commitAll();
    expect(commit.status).toBe(0); // the command succeeded: an empty git status is a real clean tree
    builtApp();
    const url = startProduct();
    await fetch(`${url}/api/product`);
    await fetch(`${url}/api/pages`);
    await fetch(`${url}/api/page?path=docs/vision.md`);
    await fetch(`${url}/p/docs/vision.md`);
    const manifest = readFileSync(join(folder!, 'workspace.yaml'), 'utf8');
    expect(manifest).toContain('id: demo');
    const status = gitStatus();
    expect(status).toBe('');
    const files = committedFiles();
    expect(files).toContain('docs/vision.md');
    expect(files).toContain('workspace.yaml');
  });

  test('a server with a product folder but no manifest refuses to start', () => {
    const nowhere = mkdtempSync(join(tmpdir(), 'madarch-wiki-server-'));
    try {
      expect(() => startServer({ productFolder: nowhere, port: 0 })).toThrow('workspace.yaml');
    } finally {
      rmSync(nowhere, { recursive: true, force: true });
    }
  });

  test('started with neither a product folder nor a data folder, it refuses to start', () => {
    expect(() => startServer({ port: 0 })).toThrow(/neither a data folder nor a product folder/);
  });

  test('without an app folder named, the checkout\'s built app is used and / answers; without a dist the start refuses saying what to build (finding 3)', async () => {
    // The requirement (server.md, serves-wiki; architecture.md): a server
    // given only a product folder serves the checkout's own built app when
    // it stands — and refuses naming what to build when it does not. The
    // real checkout dist is the seam: which half holds is decided by it,
    // and both halves are held by this test.
    draft();
    const dist = join(import.meta.dir, '..', 'wiki', 'app', 'dist', 'index.html');
    if (existsSync(dist)) {
      server = startServer({ productFolder: folder!, port: 0, log: () => {}, errorLog: () => {} });
      const root = await fetch(`${server.url}/`);
      expect(root.status).toBe(200);
      expect((await root.text()).length).toBeGreaterThan(0);
    } else {
      let message = '';
      try {
        startServer({ productFolder: folder!, port: 0 });
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toContain('wiki/app/dist');
      expect(message).toContain('build the app first');
    }
  });

  test('the model routes stay as they are: a sent model and the product stay apart', async () => {
    let dataFolder: string | undefined;
    draft();
    builtApp();
    server = startServer({
      dataFolder: (dataFolder = mkdtempSync(join(tmpdir(), 'madarch-wiki-data-'))),
      productFolder: folder!,
      appFolder,
      port: 0,
      log: (line) => lines.push(line),
      errorLog: (line) => errors.push(line),
    });
    const url = server.url;
    // A real model is sent, and both halves are answered: the view from what was sent, the pages from the product.
    const sent = await fetch(`${url}/models`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        protocol: 1,
        source: 'example.org/demo-model',
        commit: 'c1',
        committedAt: '2026-10-09T12:00:00Z',
        model: model([element('svc')]),
      }),
    });
    expect(sent.status).toBe(201);
    const view = await fetch(`${url}/views`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ protocol: 1, source: 'example.org/demo-model', format: 'mermaid', depth: 1 }),
    });
    expect(view.status).toBe(200);
    const viewText = await view.text();
    expect(viewText).toContain('svc');
    const pages = await fetch(`${url}/api/pages`);
    expect(pages.status).toBe(200);
    const body = (await pages.json()) as { pages: unknown[] };
    expect(body.pages.map((page) => (page as { path: string }).path)).toEqual(['docs/vision.md']);
    rmSync(dataFolder!, { recursive: true, force: true });
  });

  test('the API answers a few hundred small documents well inside a second', async () => {
    draft();
    builtApp();
    for (let i = 0; i < 300; i++) {
      writeFileSync(join(folder!, 'docs', `doc-${String(i).padStart(3, '0')}.md`), `# Page ${i}\n\nSome text.\n`);
    }
    const url = startProduct();
    const started = performance.now();
    const answer = await fetch(`${url}/api/pages`);
    await answer.json();
    const taken = performance.now() - started;
    expect(answer.status).toBe(200);
    expect(taken).toBeLessThan(1000);
  });
});

function gitStatus(): string {
  const run = spawnSync('git', ['status', '--porcelain'], { cwd: folder! });
  return run.stdout.toString();
}

/** The committed file list, so a real clean tree can be compared against a real fixture. */
function committedFiles(): string[] {
  const run = spawnSync('git', ['ls-files'], { cwd: folder! });
  return run.stdout.toString().split('\n').filter((line) => line !== '');
}

/** A real git repository in the scratch product, so its status means something. */
function initGit(): void {
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Wiki Test',
    GIT_AUTHOR_EMAIL: 'wiki-test@example.com',
    GIT_COMMITTER_NAME: 'Wiki Test',
    GIT_COMMITTER_EMAIL: 'wiki-test@example.com',
  };
  for (const args of [['init'], ['add', '.']]) {
    const run = spawnSync('git', args, { cwd: folder!, env });
    if (run.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${run.stderr.toString()}`);
  }
}

/** Commits everything; the test asserts the command succeeded before trusting an empty status. */
function commitAll(): { status: number | null } {
  return spawnSync('git', ['commit', '-m', 'fixture'], { cwd: folder!, env: {
    ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Wiki Test',
    GIT_AUTHOR_EMAIL: 'wiki-test@example.com',
    GIT_COMMITTER_NAME: 'Wiki Test',
    GIT_COMMITTER_EMAIL: 'wiki-test@example.com',
  } });
}
