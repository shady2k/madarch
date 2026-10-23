import { basename, dirname } from 'node:path';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import { startServer, type ServerOptions, type StartedServer } from '../src/index.js';
import { agentSettingsPath, readChosenModel } from '../src/product/fill-wizard.js';
import { fillStatePaths } from '../src/product/fill-runtime.js';
import { createPGliteQueryDatabase } from '../src/adapters/pglite-query-database.js';
import { gitEnv } from './git-env.js';
const productGitEnv = gitEnv({ GIT_AUTHOR_NAME: 'Question Test', GIT_AUTHOR_EMAIL: 'question@example.test', GIT_COMMITTER_NAME: 'Question Test', GIT_COMMITTER_EMAIL: 'question@example.test' });

/**
 * The bound of the one case here that starts a server over a drafted product
 * with its own PGlite (`the model routes stay as they are`): it opens a
 * database, a product folder and a built app before it can ask anything, and it
 * takes 4.30 s on GitHub's runners (2026-10-20). The file's other cases take
 * 0.2-1.1 s.
 */
const MODEL_ROUTES_MS = 20_000;

/** One real git repository checked out under the product's repos/, committed with a sealed identity. */
function fixtureCheckout(product: string, name: string, subject: string): string {
  const target = join(product, 'repos', name);
  mkdirSync(target, { recursive: true });
  const env = {
    ...gitEnv(),
    GIT_AUTHOR_NAME: 'Repos Test', GIT_AUTHOR_EMAIL: 'repos-test@example.com',
    GIT_COMMITTER_NAME: 'Repos Test', GIT_COMMITTER_EMAIL: 'repos-test@example.com',
  };
  const run = (args: string[]): void => {
    const done = spawnSync('git', args, { cwd: target, encoding: 'utf8', env });
    if (done.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${done.stderr}${done.stdout}`);
  };
  run(['init', '--quiet', '--initial-branch=main']);
  writeFileSync(join(target, 'README.md'), `# ${name}\n`);
  run(['add', '-A']);
  run(['commit', '--quiet', '-m', subject]);
  return target;
}

/** Renames one folder, failing loudly when the move did not happen. */
function renameOrThrow(from: string, to: string): void {
  renameSync(from, to);
}

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

function draft(registry: boolean = false): string {
  folder = mkdtempSync(join(tmpdir(), 'madarch-wiki-server-'));
  mkdirSync(join(folder, 'docs'), { recursive: true });
  writeFileSync(join(folder, 'workspace.yaml'), 'schemaVersion: 1\nid: demo\nname: Demo\n');
  writeFileSync(join(folder, 'docs', 'vision.md'), '# Vision\n\nWhat it is for.\n');
  if (registry) {
    writeFileSync(join(folder, 'docs', 'kinds.yaml'), [
      'contract: 1',
      'stages:',
      '  - id: idea',
      '    name: Idea',
      '  - id: requirements',
      '    name: Requirements',
      'kinds:',
      '  - name: Product vision',
      "    prefix: V",
      '    folder: docs/vision.md',
      '    stage: idea',
      '    hint: write why the product is worth building',
      ''].join('\n'));
  }
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

afterEach(async () => {
  await server?.stop();
  server = undefined;
  if (appFolder !== undefined) rmSync(appFolder, { recursive: true, force: true });
  appFolder = undefined;
  if (folder !== undefined) rmSync(folder, { recursive: true, force: true });
  folder = undefined;
});

async function startProduct(options: { env?: ServerOptions['env'] } = {}): Promise<string> {
  lines = [];
  errors = [];
  server = await startServer({
    productFolder: folder!,
    appFolder,
    ...options,
    port: 0,
    log: (line) => lines.push(line),
    errorLog: (line) => errors.push(line),
  });
  return server.url;
}

describe('the server\'s product mode', () => {
  test('GET /api/events answers a text/event-stream whose `retry` comes first', async () => {
    draft();
    builtApp();
    const url = await startProduct();
    const asking = new AbortController();
    const response = await fetch(`${url}/api/events`, { signal: asking.signal });
    expect(response.ok).toBe(true);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    expect(response.headers.get('cache-control')).toContain('no-cache');
    const reader = response.body!.getReader();
    const read = async (ms: number): Promise<string> => {
      const chunks: string[] = [];
      const decoder = new TextDecoder();
      const tick = setTimeout(() => {}, ms);
      try {
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          chunks.push(decoder.decode(next.value, { stream: true }));
          if (chunks.join('').includes('\n\n')) break;
        }
      } catch (error) {
        if ((error as Error).name !== 'AbortError') throw error;
      } finally {
        clearTimeout(tick);
      }
      return chunks.join('');
    };
    const first = await read(2000);
    expect(first.startsWith('retry: 3000')).toBe(true);
    asking.abort();
  });

  test('GET /api/events carries one change event for a saved file, within two seconds, and a burst of saves is one event', async () => {
    draft();
    builtApp();
    const url = await startProduct();
    const asking = new AbortController();
    const response = await fetch(`${url}/api/events`, { signal: asking.signal });
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let held = '';
    const rest = async (): Promise<void> => {
      for (;;) {
        const next = await reader.read();
        if (next.done) return;
        held += decoder.decode(next.value, { stream: true });
        if (held.includes('event: change')) return;
      }
    };
    // A saved file: one event, its data naming the revision, inside two seconds.
    const writing = join(folder!, 'docs', 'vision.md');
    writeFileSync(writing, '# Vision\n\nSaved line.\n');
    let wideEnough = await Promise.race([rest().then(() => true), new Promise<boolean>((done) => setTimeout(() => done(false), 2000))]);
    expect(wideEnough).toBe(true);
    const afterOne = held.split('event: change').length - 1;
    expect(afterOne).toBe(1);
    expect(held).toContain('data: {');
    // A burst of saves inside the debounce window is one event: the stream
    // asks the revision once the tree has settled, not once per write.
    held = '';
    writeFileSync(writing, '# Vision\n\nAnother line.\n');
    writeFileSync(writing, '# Vision\n\nA third line.\n');
    await Promise.race([new Promise<void>((done) => setTimeout(done, 900))]);
    const afterBurst = held.split('event: change').length - 1;
    expect(afterBurst).toBeLessThanOrEqual(1);
    expect(held).not.toContain('# Vision'); // the event carries no document bytes
    asking.abort();
  });

  test('the app\'s files are served, and a path the app does not hold answers index.html', async () => {
    draft();
    builtApp();
    const url = await startProduct();
    const root = await fetch(`${url}/`);
    expect(root.status).toBe(200);
    expect(await root.text()).toContain('demo wiki');
    const script = await fetch(`${url}/assets/app.js`);
    expect(script.status).toBe(200);
    expect(await script.text()).toBe('export const app = 1;\n');
    expect(script.headers.get('content-type')).toContain('javascript');
    const deep = await fetch(`${url}/k/docs`);
    expect(deep.status).toBe(200);
    expect(await deep.text()).toContain('demo wiki');
    expect(deep.headers.get('content-type')).toContain('html');
  });

  test('static serving and the fallback answer GET and HEAD only; other methods are refused with 405', async () => {
    draft();
    builtApp();
    const url = await startProduct();
    const postRoot = await fetch(`${url}/`, { method: 'POST' });
    expect(postRoot.status).toBe(405);
    const postRoute = await fetch(`${url}/k/docs`, { method: 'POST' });
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
    const url = await startProduct();
    // A page address the wiki's routes answer falls back to the app.
    const page = await fetch(`${url}/k/docs`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('demo wiki');
    // The addresses of the old documents app are no routes: a named 404, never the app's page.
    for (const old of ['/p/docs/vision.md', '/questions', '/s/idea', '/r']) {
      const gone = await fetch(`${url}${old}`);
      expect(gone.status, old).toBe(404);
    }
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

  test('every app route answers the app\'s index.html directly: a reload or a shared link works (walk 1, fix 3)', async () => {
    draft();
    builtApp();
    const url = await startProduct();
    // The addresses the app itself routes: the home, the knowledge wiki's home, a kind, an entity, the documents,
    // one document and a source. Each GET must answer the app's index.html — never a 404 — so an address opened
    // directly (a reload, a link pasted in chat) reaches the app's own routing.
    const asked = ['/', '/k', '/k/kind/code.file', '/k/e/code.service%3Apayments', '/k/docs', '/k/doc?path=docs%2Fvision.md', '/k/src?path=a.ts'];
    for (const path of asked) {
      const answer = await fetch(`${url}${path}`);
      expect(answer.status).toBe(200);
      expect(await answer.text()).toContain('demo wiki');
    }
  });

  test('a path under /api that nothing answers is refused with JSON naming it', async () => {
    draft();
    builtApp();
    const url = await startProduct();
    const answer = await fetch(`${url}/api/unknown`);
    expect(answer.status).toBe(404);
    const body = (await answer.json()) as { message: string };
    expect(body.message).toContain('/api/unknown');
    void body;
  });

  test('the log line carries method, path, status and no document content', async () => {
    draft();
    builtApp();
    const url = await startProduct();
    await fetch(`${url}/api/k/documents?path=docs/vision.md`);
    await fetch(`${url}/api/nothing`);
    const about = lines.filter((line) => line.startsWith('GET /api/k/documents'));
    expect(about).toHaveLength(1);
    expect(about[0]).toMatch(/GET \/api\/k\/documents 200 .*ms$/);
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
    const url = await startProduct();
    await fetch(`${url}/api/k/documents`);
    await fetch(`${url}/k/docs`);
    const manifest = readFileSync(join(folder!, 'workspace.yaml'), 'utf8');
    expect(manifest).toContain('id: demo');
    // Listing the documents and serving the app's pages write nothing. (A product with no kinds manifest is given the
    // starter set when the knowledge wiki is asked for its status; see test/product-wiki-serve.test.ts.)
    const status = gitStatus();
    expect(status).toBe('');
    const files = committedFiles();
    expect(files).toContain('docs/vision.md');
    expect(files).toContain('workspace.yaml');
  });

  test('a server with a product folder but no manifest refuses to start', async () => {
    const nowhere = mkdtempSync(join(tmpdir(), 'madarch-wiki-server-'));
    try {
      await expect(startServer({ productFolder: nowhere, port: 0 })).rejects.toThrow('workspace.yaml');
    } finally {
      rmSync(nowhere, { recursive: true, force: true });
    }
  });

  test('started with neither a product folder nor a data folder, it refuses to start', async () => {
    await expect(startServer({ port: 0 })).rejects.toThrow(/neither a data folder nor a product folder/);
  });

  test('without an app folder named, the checkout\'s built app is used and / answers (finding 3, deterministic)', async () => {
    // The requirement (server.md, serves-wiki; architecture.md): a server
    // given only a product folder serves the checkout's own built app. A
    // fixture index.html is put in the dist for the length of this test and
    // removed after, so the built-app branch runs on fresh CI too, where no
    // build has happened yet.
    draft();
    const distFolder = join(import.meta.dir, '..', 'wiki', 'app', 'dist');
    const index = join(distFolder, 'index.html');
    // Track the directory, not the file: when `dist` already stood with
    // other assets and no index.html, only the fixture may be removed —
    // a pre-existing asset must survive the test (finding 2.11).
    const madeDir = !existsSync(distFolder);
    if (madeDir) mkdirSync(distFolder, { recursive: true });
    const wroteIndex = !existsSync(index);
    if (wroteIndex) writeFileSync(index, '<!doctype html><title>fixture app</title>');
    const keptAsset = join(distFolder, 'pre-existing.js');
    writeFileSync(keptAsset, 'export const kept = 1;\n');
    try {
      server = await startServer({ productFolder: folder!, port: 0, log: () => {}, errorLog: () => {} });
      const root = await fetch(`${server.url}/`);
      expect(root.status).toBe(200);
      expect((await root.text()).length).toBeGreaterThan(0);
      expect(existsSync(keptAsset)).toBe(true);
    } finally {
      rmSync(keptAsset);
      if (wroteIndex) rmSync(index);
      if (madeDir) rmSync(distFolder, { recursive: true, force: true });
    }
  });

  test('without a dist the start refuses saying what to build (finding 3)', async () => {
    // The absence case stands on its own: whatever the checkout holds, the
    // dist is moved aside for the length of this test and put back after.
    draft();
    const distFolder = join(import.meta.dir, '..', 'wiki', 'app', 'dist');
    const heldAside = distFolder + '.held-aside-by-test';
    const moved = existsSync(distFolder);
    if (moved) renameOrThrow(distFolder, heldAside);
    try {
      let message = '';
      try {
        await startServer({ productFolder: folder!, port: 0 });
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toContain('wiki/app/dist');
      expect(message).toContain('build the app first');
    } finally {
      if (moved) renameOrThrow(heldAside, distFolder);
    }
  });

  test('the model routes stay as they are: a sent model and the product stay apart', async () => {
    let dataFolder: string | undefined;
    draft();
    builtApp();
    server = await startServer({
      dataFolder: (dataFolder = mkdtempSync(join(tmpdir(), 'madarch-wiki-data-'))),
      queryDatabase: await createPGliteQueryDatabase(),
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
    const pages = await fetch(`${url}/api/k/documents`);
    expect(pages.status).toBe(200);
    const body = (await pages.json()) as { documents: { repo: string | null; path: string }[] };
    expect(body.documents).toEqual([{ repo: null, path: 'docs/vision.md' }]);
    rmSync(dataFolder!, { recursive: true, force: true });
  }, MODEL_ROUTES_MS);

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
