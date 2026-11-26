import { expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes, randomUUID } from 'node:crypto';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { collectStartup } from './startup-trace-collector.js';

// S1 replaced the plain-text `startup <phase> ...` timings with versioned records: a line that pairs with nothing, that
// names a store folder and that a reader cannot tell from a message, tells a person nothing the records do not say
// better. A merge must never bring one back (madarch-64o5.74).
const root = join(import.meta.dir, '..');

function* typescript(folder: string): Generator<string> {
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    const path = join(folder, entry.name);
    if (entry.isDirectory()) yield* typescript(path);
    else if (entry.name.endsWith('.ts')) yield path;
  }
}

test('the startup switch reaches only the observation module, and no module writes a plain-text startup line', () => {
  const sources = [...typescript(join(root, 'src'))];
  expect(sources.length, 'the source tree was read').toBeGreaterThan(100);
  const naming = sources.filter(path => readFileSync(path, 'utf8').includes('MADARCH_STARTUP_TIMING')).map(path => relative(root, path));
  expect(naming, 'the switch is read where the records are made').toEqual(['src/obs/startup-context.ts']);
  const plain = sources.filter(path => /console\.\w+\(\s*[`'"]startup /.test(readFileSync(path, 'utf8'))).map(path => relative(root, path));
  expect(plain, 'a plain-text startup timing line is what the records replaced').toEqual([]);
});

test('store preparation with the switch on writes records and no plain-text line', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'startup-plain-text-'));
  chmodSync(folder, 0o700);
  try {
    const context = join(folder, 'context');
    writeFileSync(context, JSON.stringify({ version: 1, collection: randomUUID(), key: randomBytes(32).toString('hex') }), { mode: 0o600 });
    const store = join(folder, 'store');
    const child = Bun.spawn([process.execPath, join(import.meta.dir, 'fixtures', 'startup-trace-rpc.ts'), store, 'plain'], {
      env: { ...process.env, MADARCH_TRACE: 'on', MADARCH_STARTUP_TIMING: '1', MADARCH_STARTUP_CONTEXT: context }, stdout: 'pipe', stderr: 'pipe',
    });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(code, stdout + stderr).toBe(0);
    const collected = collectStartup(stderr);
    expect(collected.incomplete).toEqual([]);
    expect(collected.records.some(record => record.phase === 'schema.prepare' && record.edge === 'terminal'), 'the preparation was recorded').toBe(true);
    // The switch writes records only: a legacy timing line, or a store path on a line of its own, is not a record.
    const lines = stderr.split('\n').slice(0, -1).filter(line => line !== '');
    expect(lines.length).toBe(collected.records.length);
    expect(lines.filter(line => !line.startsWith('{')), 'every stderr line is a versioned record').toEqual([]);
    expect(stderr, 'no raw store path leaves the records').not.toContain(store);
  } finally { rmSync(folder, { recursive: true, force: true }); }
}, 60_000);
