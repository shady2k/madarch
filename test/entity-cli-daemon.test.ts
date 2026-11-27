/**
 * `madarch entity` beside a running wiki (madarch-64o5.193): a store's schema is prepared by the process that owns it,
 * so a command in another process must borrow the preparation service that daemon published in the products home. No
 * one sets `MADARCH_STORE_OWNER_URL`/`_TOKEN` by hand, and before this the command refused every store it met with
 * "the store needs its owning madarch process for schema preparation" and exited 2. A command run alone, with no daemon
 * beside it, prepares the store itself.
 */
import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { authoredFixture } from './authored-fixture.js';

const ROOT = resolve(import.meta.dir, '..');

test('the entity command borrows a running daemon\'s store preparation and owns it alone', async () => {
  const work = mkdtempSync(join(tmpdir(), 'madarch-entity-daemon-'));
  const home = join(work, 'products');
  // One authored kind, filled once so an authored write has a permitted graph behind it.
  const product = await authoredFixture(home, 'notes');
  const env = { ...process.env };
  // Nobody sets these: the command reads the daemon's published address from the products home.
  delete env.MADARCH_STORE_OWNER_URL; delete env.MADARCH_STORE_OWNER_TOKEN; delete env.MADARCH_ROLE;
  // Who wrote an authored change, as git names the person of the fixture product.
  env.GIT_AUTHOR_NAME = 'Fixture'; env.GIT_AUTHOR_EMAIL = 'fixture@example.test';
  const descriptor = join(home, '.madarch-store-owner.json');
  const module = new URL('../src/product/store-preparation.ts', import.meta.url).pathname;
  const ownScript = `import { publishStoreOwner, withStorePreparationOwner } from ${JSON.stringify(module)};
await withStorePreparationOwner(async () => {
  const unpublish = publishStoreOwner(${JSON.stringify(home)});
  console.log('ready');
  await new Response(Bun.stdin.stream()).text();
  unpublish();
});`;
  let stopDaemon: (() => Promise<void>) | undefined;
  let daemonOutput = '';
  const waitFor = async (description: string, check: () => boolean): Promise<void> => {
    const until = Date.now() + 30_000;
    while (Date.now() < until) { if (check()) return; await Bun.sleep(50); }
    throw new Error(`${import.meta.path}: ${description} did not happen within 30000 ms (${work})`);
  };
  const cli = (args: readonly string[]): { code: number; stdout: string; stderr: string } => {
    const child = Bun.spawnSync([process.execPath, join(ROOT, 'scripts', 'madarch.ts'), 'entity', ...args, '--product', product, '--home', home, '--json'], { env, cwd: work });
    return { code: child.exitCode ?? -1, stdout: child.stdout.toString(), stderr: child.stderr.toString() };
  };
  const parsed = (run: { code: number; stdout: string; stderr: string }): Record<string, any> => {
    try { return JSON.parse(run.stdout) as Record<string, any>; }
    catch { throw new Error(`${import.meta.path}: the command printed no JSON (exit ${run.code}): ${run.stdout}${run.stderr}`); }
  };
  try {
    // The daemon that owns the products home's stores: a process of its own, holding the store it prepares.
    const held = Bun.spawn([process.execPath, '-e', ownScript], { env, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
    stopDaemon = async () => { held.stdin.end(); held.kill('SIGKILL'); await held.exited; };
    const reader = held.stdout.getReader();
    void (async () => { for (;;) { const next = await reader.read(); if (next.done) return; daemonOutput += new TextDecoder().decode(next.value); } })();
    const daemonErrors = new Response(held.stderr).text();
    await waitFor('the daemon publishes its preparation service', () => daemonOutput.includes('ready') && existsSync(descriptor));
    expect(JSON.parse(readFileSync(descriptor, 'utf8'))).toMatchObject({ url: expect.any(String), token: expect.any(String) });

    const made = cli(['create', 'note', '--title', 'First', '--count', '3']);
    expect(made.code, `${made.stdout}\n${made.stderr}`).toBe(0);
    const created = parsed(made);
    const uid = created.entity.uid as string;
    expect(created.entity.values).toMatchObject({ title: 'First', count: 3 });

    const updated = cli(['update', 'note', uid, '--field', 'count=4']);
    expect(updated.code, updated.stderr).toBe(0);
    expect(parsed(updated).entity.values).toMatchObject({ title: 'First', count: 4 });

    const listed = cli(['list', 'note']);
    expect(listed.code, listed.stderr).toBe(0);
    expect(parsed(listed).entities.map((entity: { uid: string }) => entity.uid)).toEqual([uid]);

    // A field the kind declares, given a value of another type: the command names the field and the reason, and fails.
    const invalid = cli(['create', 'note', '--title', 'Second', '--count', 'lots']);
    expect(invalid.code).toBe(2);
    expect(parsed(invalid).error).toMatchObject({ field: 'count', message: expect.stringContaining('expected integer') });

    const removed = cli(['delete', 'note', uid]);
    expect(removed.code, removed.stderr).toBe(0);
    const emptied = cli(['list', 'note']);
    expect(emptied.code, emptied.stderr).toBe(0);
    expect(parsed(emptied).entities).toEqual([]);

    // The same commands alone: with the daemon gone, the command prepares the store itself.
    held.stdin.end();
    expect(await held.exited, await daemonErrors).toBe(0);
    stopDaemon = undefined;
    await waitFor('the daemon withdraws its published address', () => !existsSync(descriptor));
    const alone = cli(['create', 'note', '--title', 'Alone']);
    expect(alone.code, alone.stderr).toBe(0);
    expect(parsed(alone).entity.values).toMatchObject({ title: 'Alone' });
    const aloneRead = cli(['list', 'note']);
    expect(aloneRead.code, aloneRead.stderr).toBe(0);
    expect(parsed(aloneRead).entities.map((entity: { values: { title: string } }) => entity.values.title)).toEqual(['Alone']);
  } finally {
    await stopDaemon?.();
    rmSync(work, { recursive: true, force: true });
  }
}, 180_000);
