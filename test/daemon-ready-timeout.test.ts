/**
 * A start's wait for its server is a hang guard, not a speed limit (madarch-lyh1): a live child of the record that has
 * not opened its port yet is still coming up and is waited for, and readiness is read only from the answer that child
 * alone gives (the HMAC proof, madarch-64o5.80). The child here spends 9.5 s before its entry point runs — past the
 * 8 s bound this change replaced — so this file is red before the change and green after it.
 *
 * The daemon is two Bun processes: the one a start spawns (`daemon-serve` on its command line) and the api role that
 * process spawns in turn (`--role api daemon-serve …`, src/product/cli.ts). Both inherit BUN_OPTIONS, so the pause
 * below is taken only in the process whose command line carries `daemon-serve` without `--role`: the wait under test
 * is the start's own, and a pause in both processes would put the port 19 s away instead of 9.5 s.
 */
import { afterEach, expect, test } from 'bun:test';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as netServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureDaemon, stopDaemon } from '../src/product/daemon.js';

/** The pause the start's own process takes before its entry point runs: past the 8 s bound this change replaced. */
const SLOW_START_MS = 9_500;
const KEPT = ['HOME', 'MADARCH_HOME', 'MADARCH_APP', 'MADARCH_APP_DIST', 'BUN_OPTIONS'];

let root: string | undefined;
let home: string | undefined;
let kept: Record<string, string | undefined> = {};

afterEach(() => {
  if (home !== undefined) stopDaemon({ home });
  home = undefined;
  for (const key of KEPT) {
    const was = kept[key];
    if (was === undefined) delete process.env[key]; else process.env[key] = was;
  }
  kept = {};
  if (root !== undefined) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

function freePort(): Promise<number> {
  return new Promise((answer) => {
    const listener = netServer();
    listener.listen(0, '127.0.0.1', () => {
      const address = listener.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      listener.close(() => answer(port));
    });
  });
}

test("a start outlasts 8 s of a live child's slow start and reads readiness from the child's own answer (madarch-lyh1)", async () => {
  root = mkdtempSync(join(tmpdir(), 'madarch-daemon-late-ready-'));
  home = join(root, 'products'); mkdirSync(home);
  // A built dist beside the app folder, so the start builds nothing and only the child's own start is timed.
  const app = join(root, 'app'); mkdirSync(join(app, 'assets'), { recursive: true });
  writeFileSync(join(app, 'index.html'), '<!doctype html><script src="/assets/app.js"></script><title>wiki</title>');
  writeFileSync(join(app, 'assets', 'app.js'), 'ok');
  const appFolder = join(root, 'app-folder'); mkdirSync(appFolder);
  cpSync(app, join(appFolder, 'dist'), { recursive: true });
  writeFileSync(join(appFolder, 'package.json'), JSON.stringify({ name: 'app', private: true, scripts: { build: 'true' } }, null, 2));
  // Bun runs this preload in the process a start spawns — its command line carries `daemon-serve` and no `--role` —
  // before its entry point; the api role that process spawns in turn carries `--role` and keeps its own start.
  const preload = join(root, 'slow-daemon-preload.ts');
  writeFileSync(preload, `if (process.argv.includes('daemon-serve') && !process.argv.includes('--role')) await Bun.sleep(${SLOW_START_MS});\n`);
  for (const key of KEPT) kept[key] = process.env[key];
  process.env.HOME = root;
  process.env.MADARCH_HOME = root;
  process.env.MADARCH_APP_DIST = app;
  process.env.MADARCH_APP = appFolder;
  process.env.BUN_OPTIONS = [kept['BUN_OPTIONS'], `--preload ${preload}`].filter((value) => value !== undefined && value !== '').join(' ');
  const port = await freePort();
  const started = await ensureDaemon({ home, port, print: () => undefined });
  expect(started.ok).toBe(true);
  if (!started.ok) return;
  expect(started.port).toBe(port);
  expect(started.reused).toBe(false);
  expect((await fetch(`${started.url}/api/products`)).status).toBe(200);
}, 60_000);
