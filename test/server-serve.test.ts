import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVE = fileURLToPath(new URL('../scripts/serve.ts', import.meta.url));

let folder: string | undefined;
const running: ReturnType<typeof Bun.spawn>[] = [];

afterEach(() => {
  for (const proc of running.splice(0)) proc.kill();
  if (folder !== undefined) {
    rmSync(folder, { recursive: true, force: true });
    folder = undefined;
  }
});

function scratchFolder(): string {
  folder = mkdtempSync(join(tmpdir(), 'madarch-server-serve-'));
  return folder;
}

/** Runs serve.ts as a real subprocess that ends by itself, and collects its output. */
async function runServe(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(['bun', SERVE, ...args], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  const exitCode = await proc.exited;
  return { exitCode, stdout, stderr };
}

/**
 * Runs serve.ts until it prints its listen line — awaited, never guessed
 * at — and hands the line back; the process keeps running. A serve.ts
 * that never announces leaves the awaited stream open for bun's own test
 * timeout, and `afterEach` kills every spawned process.
 */
async function serveUntilListening(args: string[]): Promise<{ proc: ReturnType<typeof Bun.spawn>; listenLine: string }> {
  const proc = Bun.spawn(['bun', SERVE, ...args], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  running.push(proc);
  const decoder = new TextDecoder();
  let text = '';
  for await (const chunk of proc.stdout) {
    text += decoder.decode(chunk);
    const line = text.split('\n').find((each) => each.includes('listens on'));
    if (line !== undefined) return { proc, listenLine: line };
  }
  throw new Error(`serve.ts printed no listen line; it printed: ${JSON.stringify(text)}`);
}

describe('the server command line', () => {
  test('without --data it exits 2 naming the flag and what it is for', async () => {
    const { exitCode, stderr } = await runServe([]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain('--data');
    expect(stderr).toContain('history');
  });

  test('an unknown option or a stray argument exits 2 naming it', async () => {
    const unknown = await runServe(['--data', scratchFolder(), '--nope']);
    expect(unknown.exitCode).toBe(2);
    expect(unknown.stderr).toContain('--nope');

    const stray = await runServe(['--data', scratchFolder(), 'somewhere']);
    expect(stray.exitCode).toBe(2);
    expect(stray.stderr).toContain('somewhere');
  });

  test('a data folder that does not exist exits 2 naming the path', async () => {
    const missing = join(scratchFolder(), 'not-there');
    const { exitCode, stderr } = await runServe(['--data', missing]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain('not-there');
  });

  test('a --port that is not a whole port number exits 2 naming it', async () => {
    const words = await runServe(['--data', scratchFolder(), '--port', 'listen']);
    expect(words.exitCode).toBe(2);
    expect(words.stderr).toContain('--port');

    const tooBig = await runServe(['--data', scratchFolder(), '--port', '70000']);
    expect(tooBig.exitCode).toBe(2);
    expect(tooBig.stderr).toContain('70000');
  });

  test('started normally it listens on 127.0.0.1 and answers its sources', async () => {
    const { proc, listenLine } = await serveUntilListening(['--data', scratchFolder(), '--port', '0']);
    try {
      const url = listenLine.match(/https?:\/\/\S+/)?.[0];
      expect(url).toBeDefined();
      expect(url).toStartWith('http://127.0.0.1:');

      const response = await fetch(`${url}/sources`);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual([]);
    } finally {
      proc.kill();
      await proc.exited;
    }
  });
});
