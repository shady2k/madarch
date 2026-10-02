import { afterAll, afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkLikeC4Workspaces } from '../scripts/likec4-check.js';
import { checkMermaidPages } from '../scripts/mermaid-check.js';
import { loadAndCompileModel } from '../src/index.js';
import { sourceNameFromRemote } from '../src/send/send-model.js';
import { gitEnv } from './git-env.js';

/**
 * The server-views acceptance end to end, against real processes: a server
 * started as `bun scripts/serve.ts` on a scratch data folder, the reference
 * system's compiled model sent straight through POST /models (the
 * coordinator's decision of 2026-09-30: the invented system carries no
 * evidence and no review report, so the send command's check gate — a
 * correct gate — refuses it), nocx's model sent with the real send command,
 * then every view both sources owe, the idempotent resend, the refusal for
 * a source never sent, and the table of what each answer cost.
 *
 * The file runs only under MADARCH_SERVER_E2E=1, as the wiki's real builds
 * run only under MADARCH_WIKI_E2E=1; the tests that need nocx's checkout
 * also need MADARCH_NOCX to name it. Every test name says which variables
 * it requires — bun's runner prints no skip reason of its own, so the name
 * is the reason. When MADARCH_SERVER_E2E_CAPTURE names a file, the twelve
 * answers are written there as JSON for the GitHub-render measurement
 * outside the repository; unset, nothing is left behind.
 */

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SERVE = join(ROOT, 'scripts', 'serve.ts');
const SEND = join(ROOT, 'scripts', 'send-model.ts');
const REFERENCE_SYSTEM = join(ROOT, 'examples', 'reference-system');
/** The source name the reference system is sent under (its git origin is madarch's own, so it cannot name the source). */
const REFERENCE_SOURCE = 'examples/reference-system';
/** The source nocx's accepted run is held to; its HEAD must start with this. */
const NOCX_SOURCE = 'github.com/shady2k/nocx';
const NOCX_COMMIT_PREFIX = '3f0e46e';

const GATE = 'MADARCH_SERVER_E2E=1';
const FULL = 'MADARCH_SERVER_E2E=1 and MADARCH_NOCX';
const gated = process.env.MADARCH_SERVER_E2E !== undefined;
const withNocx = gated && process.env.MADARCH_NOCX !== undefined;

/** One read-only git question in a repository, answered or thrown with the question and the refusal. */
function git(repo: string, args: string[]): string {
  const run = spawnSync('git', args, { cwd: repo, encoding: 'utf8', env: gitEnv() });
  if (run.error !== undefined || run.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed in ${repo}: ${run.stderr.trim() || run.error?.message}`);
  }
  return run.stdout.trim();
}

/** The source name nocx's `origin` remote gives, derived once by the send command's own `sourceNameFromRemote`. */
let nocxName: string | undefined;
function nocxSource(): string {
  if (nocxName === undefined) {
    const name = sourceNameFromRemote(git(process.env.MADARCH_NOCX!, ['remote', 'get-url', 'origin']));
    expect(name).toBeDefined();
    nocxName = name!;
  }
  return nocxName;
}

/**
 * The twelve view requests: the landscape, a domain or top element with
 * children, and the modules of a core — on the reference system (`ordering`,
 * `checkout-api`) and on nocx (`nocx`, `runtime`, the module whose children
 * wire-transport, session-runtime and terminals are its modules).
 */
function allViews(): Array<{ source: string; element: string | undefined; label: string }> {
  const nocx = nocxSource();
  return [
    { source: REFERENCE_SOURCE, element: undefined, label: 'landscape' },
    { source: REFERENCE_SOURCE, element: 'ordering', label: 'ordering' },
    { source: REFERENCE_SOURCE, element: 'checkout-api', label: 'checkout-api' },
    { source: nocx, element: undefined, label: 'landscape' },
    { source: nocx, element: 'nocx', label: 'nocx' },
    { source: nocx, element: 'runtime', label: 'runtime' },
  ];
}

/** Every temporary folder this file makes, removed after each test and on exit, pass or fail. */
const made: string[] = [];
function tempFolder(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
}
const removeMadeFolders = (): void => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
};
afterEach(removeMadeFolders);

let folder: string | undefined;
let serveProc: Bun.Subprocess | undefined;
let baseUrl: string | undefined;
/** What the server subprocess has said, held so a death can be named after the fact. */
let serveStdout = '';
let serveStderr = '';
/** True once the server's stdout closed on its own — the mark of a subprocess that ended before the teardown killed it. */
let serveStdoutClosed = false;

/**
 * Starts `bun scripts/serve.ts --data <scratch folder> --port 0` — port 0
 * is how a free port is asked for, and the listen line names the real one —
 * and answers with the base URL once the server announces it, awaited,
 * never guessed at. The stdout pump keeps reading for the whole life of the
 * child — a server whose pipe the test walked away from dies on its first
 * log line — and stderr is held so a failure can name what serve.ts said.
 */
async function serveUntilListening(): Promise<string> {
  folder = mkdtempSync(join(tmpdir(), 'madarch-server-views-e2e-'));
  serveStdout = '';
  serveStderr = '';
  serveStdoutClosed = false;
  const proc = Bun.spawn(['bun', SERVE, '--data', folder, '--port', '0'], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  serveProc = proc;
  const stdoutDecoder = new TextDecoder();
  const stderrDecoder = new TextDecoder();
  void (async () => {
    for await (const chunk of proc.stderr) serveStderr += stderrDecoder.decode(chunk, { stream: true });
  })();
  const announced = Promise.withResolvers<string>();
  const drained = (async () => {
    try {
      for await (const chunk of proc.stdout) {
        serveStdout += stdoutDecoder.decode(chunk, { stream: true });
        const line = serveStdout.split('\n').find((each) => each.startsWith('the server listens on '));
        if (line !== undefined) announced.resolve(line.slice('the server listens on '.length).split(' — ')[0]!.trim());
      }
    } finally {
      serveStdoutClosed = true;
    }
  })();
  const url = await Promise.race([announced.promise, drained.then(() => '')]);
  if (url === '') {
    throw new Error(`serve.ts printed no listen line (exit ${await proc.exited}); it printed: ${JSON.stringify(serveStdout)} on stdout, ${JSON.stringify(serveStderr)} on stderr`);
  }
  return url;
}

/** The server's base URL; a skipped file never starts one, and touching it then fails saying so. */
function server(): string {
  if (baseUrl === undefined) throw new Error('the server was never started: run under MADARCH_SERVER_E2E=1');
  return baseUrl;
}

/** The server subprocess killed and its data folder removed after the run, pass or fail. */
afterAll(() => {
  serveProc?.kill();
  serveProc = undefined;
  if (folder !== undefined) {
    rmSync(folder, { recursive: true, force: true });
    folder = undefined;
  }
});
process.on('exit', () => {
  serveProc?.kill();
  removeMadeFolders();
  if (folder !== undefined) rmSync(folder, { recursive: true, force: true });
});

/** One POST of a JSON body to the server, speaking protocol 1. */
function post(path: string, body: unknown): Promise<Response> {
  const withProtocol = typeof body === 'object' && body !== null ? { protocol: 1, ...(body as Record<string, unknown>) } : body;
  return fetch(`${server()}${path}`, { method: 'POST', body: JSON.stringify(withProtocol), headers: { 'content-type': 'application/json' } });
}

/** The reference system's compiled model with its commit and committer time, read once. */
let reference: { model: object; commit: string; committedAt: string } | undefined;
function referenceSend(): { model: object; commit: string; committedAt: string } {
  if (reference === undefined) {
    const { model, errors } = loadAndCompileModel(REFERENCE_SYSTEM);
    expect(errors).toEqual([]);
    const commit = git(ROOT, ['rev-parse', '--verify', 'HEAD^{commit}']);
    reference = { model: model as object, commit, committedAt: git(ROOT, ['log', '-1', '--format=%cI', commit]) };
  }
  return reference;
}

/** nocx's HEAD commit, read once and held to the accepted skill run the acceptance names. */
let nocxCommit: string | undefined;
function nocxHead(): string {
  if (nocxCommit === undefined) {
    const commit = git(process.env.MADARCH_NOCX!, ['rev-parse', '--verify', 'HEAD^{commit}']);
    expect(commit.startsWith(NOCX_COMMIT_PREFIX)).toBe(true);
    nocxCommit = commit;
  }
  return nocxCommit;
}

/** One answer of the run: what was asked, what came back, what it cost. The table the acceptance reports from. */
interface Answered {
  source: string;
  element: string;
  format: 'mermaid' | 'likec4';
  bytes: number;
  ms: number;
  text: string;
}
const answers: Answered[] = [];

/** Asks one view, times the whole request, and records the answer. */
async function ask(view: { source: string; element: string | undefined; label: string }, format: 'mermaid' | 'likec4'): Promise<Answered> {
  const body: Record<string, unknown> = { source: view.source, format };
  if (view.element !== undefined) body.element = view.element;
  const started = performance.now();
  const response = await post('/views', body);
  const ms = Math.max(0, Math.round(performance.now() - started));
  const text = await response.text();
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toStartWith(format === 'mermaid' ? 'text/markdown' : 'text/plain');
  const answered: Answered = { source: view.source, element: view.label, format, bytes: Buffer.byteLength(text), ms, text };
  answers.push(answered);
  return answered;
}

/** Runs the send command as a real subprocess against the server. */
async function runSend(repo: string): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(['bun', SEND, repo, '--server', server()], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { code: await proc.exited, stdout, stderr };
}

/** A test file name for one answer that cannot carry a slash or a space. */
function answerFile(source: string, label: string, extension: string): string {
  return `${source.replaceAll('/', '_')}-${label}.${extension}`;
}

describe('the server-views acceptance on the reference system and nocx', () => {
  test.skipIf(!gated)(`[${GATE}] the server stores the reference system's compiled model sent through POST /models`, async () => {
    baseUrl = await serveUntilListening();
    const sent = referenceSend();
    const response = await post('/models', { source: REFERENCE_SOURCE, commit: sent.commit, committedAt: sent.committedAt, model: sent.model });
    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual({ stored: true, source: REFERENCE_SOURCE, commit: sent.commit });
  });

  test.skipIf(!withNocx)(`[${FULL}] the send command sends nocx's checked model, named from its origin`, async () => {
    baseUrl ??= await serveUntilListening();
    const run = await runSend(process.env.MADARCH_NOCX!);
    expect(run.code).toBe(0);
    expect(run.stderr).toBe('');
    expect(run.stdout).toContain(`stored ${nocxSource()} at ${nocxHead()}`);
  });

  test.skipIf(!withNocx)(`[${FULL}] GET /sources lists both sources with their commits, in code point order`, async () => {
    expect(nocxSource()).toBe(NOCX_SOURCE);
    const list = (await fetch(`${server()}/sources`).then((each) => each.json())) as Array<{
      source: string;
      commit: string;
      committedAt: string;
      storedAt: string;
    }>;
    expect(list.map((each) => each.source)).toEqual([REFERENCE_SOURCE, NOCX_SOURCE]);
    expect(list.map((each) => each.commit)).toEqual([referenceSend().commit, nocxHead()]);
    for (const each of list) {
      expect(each.committedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(each.storedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    }
  });

  test.skipIf(!withNocx)(`[${FULL}] every Mermaid answer parses, the checkMermaidPages way`, async () => {
    const dir = join(tempFolder('madarch-server-views-e2e-md-'), 'mermaid');
    mkdirSync(dir, { recursive: true });
    for (const view of allViews()) {
      const answered = await ask(view, 'mermaid');
      writeFileSync(join(dir, answerFile(view.source, view.label, 'md')), answered.text);
    }
    await expect(checkMermaidPages([dir])).resolves.toEqual({ pages: 6, blocks: 6, errors: [] });
  }, { timeout: 120_000 });

  test.skipIf(!withNocx)(`[${FULL}] every LikeC4 answer passes likec4 validate on its own`, async () => {
    for (const view of allViews()) {
      const answered = await ask(view, 'likec4');
      const dir = join(tempFolder('madarch-server-views-e2e-c4-'), 'likec4');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, answerFile(view.source, view.label, 'c4')), answered.text);
      expect(checkLikeC4Workspaces([dir])).toEqual({ files: 1, errors: [] });
    }
  }, { timeout: 120_000 });

  test.skipIf(!withNocx)(`[${FULL}] sending each source again answers already stored`, async () => {
    const sent = referenceSend();
    const response = await post('/models', { source: REFERENCE_SOURCE, commit: sent.commit, committedAt: sent.committedAt, model: sent.model });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ stored: false, reason: 'already stored', source: REFERENCE_SOURCE, commit: sent.commit });
    const run = await runSend(process.env.MADARCH_NOCX!);
    expect(run.code).toBe(0);
    expect(run.stdout).toContain(`already stored ${nocxSource()} at ${nocxHead()}`);
  });

  test.skipIf(!withNocx)(`[${FULL}] every answer is byte-identical to the first`, async () => {
    expect(answers).toHaveLength(12);
    const firstTexts = new Map(answers.map((each) => [`${each.source}|${each.element}|${each.format}`, each.text]));
    for (const view of allViews()) {
      for (const format of ['mermaid', 'likec4'] as const) {
        const second = await ask(view, format);
        const first = firstTexts.get(`${view.source}|${view.label}|${format}`);
        if (first === undefined) throw new Error(`no first-pass answer was recorded for ${view.source} ${view.label} as ${format}`);
        expect(second.text).toBe(first);
      }
    }
  });

  test.skipIf(!withNocx)(`[${FULL}] a view of a source never sent is refused naming both held sources and the send command`, async () => {
    const response = await post('/views', { source: 'github.com/acme/shop', format: 'mermaid' });
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: { message: string; field?: string } };
    expect(body.error.field).toBe('source');
    expect(body.error.message).toContain('no model has been sent for the source "github.com/acme/shop"');
    expect(body.error.message).toContain(REFERENCE_SOURCE);
    expect(body.error.message).toContain(NOCX_SOURCE);
    expect(body.error.message).toContain('bun scripts/send-model.ts');
  });

  afterAll(async () => {
    if (serveProc !== undefined && serveStdoutClosed) {
      console.log(`the server subprocess ended on its own before the teardown (exit ${await serveProc.exited}); its last stderr: ${JSON.stringify(serveStderr.slice(-300))}, last stdout: ${JSON.stringify(serveStdout.slice(-300))}`);
    }
    const capture = process.env.MADARCH_SERVER_E2E_CAPTURE;
    if (answers.length === 0 && capture === undefined) return;
    const firstPass = answers.slice(0, 12);
    const table = firstPass
      .map(({ source, element, format, bytes, ms }) => `${source.padEnd(28)} ${element.padEnd(12)} ${format.padEnd(9)} ${String(bytes).padStart(7)} ${String(ms).padStart(6)}ms`)
      .join('\n');
    console.log(`source                         element      format       bytes     ms\n${table}`);
    if (capture !== undefined && firstPass.length > 0) {
      mkdirSync(dirname(capture), { recursive: true });
      writeFileSync(capture, JSON.stringify(firstPass, null, 2));
    }
  });
});
