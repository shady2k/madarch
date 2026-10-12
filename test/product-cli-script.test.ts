/**
 * The madarch command as a self-executed script (the `bun link` shim's way):
 * the interpreter directive and the exec bit, and the whole command flow as
 * it runs itself. These tests run the CLI as a process, not through bun test's
 * own importer, so the mutation runs (which instrument the entry's copy)
 * exclude this file.
 */
import { spawnSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { describe, expect, test, afterEach } from 'bun:test';
import { CLI, builtApp, serveNew, printedLiveFacts, scratchFolder } from './product-cli.test.js';

describe('the madarch command as an executable', () => {
  test('spawning the committed script itself answers --help: it carries an interpreter directive and the exec bit', () => {
    // Not through `bun <file>`: the way `bun link`'s shim runs it — the
    // file itself, executed, which needs its own directive and mode.
    const run = spawnSync(CLI, ['--help'], { encoding: 'utf8', timeout: 120_000 });
    expect(run.status).toBe(0);
    expect(run.stderr ?? '').toBe('');
    expect((run.stdout ?? '').length).toBeGreaterThan(0);
  });

  test('spawning the script itself creates a draft with MADARCH_HOME at a scratch folder, then serves it', async () => {
    const base = scratchFolder('madarch-cli-app-');
    const home = scratchFolder();
    const app = builtApp(base);
    // Not through `bun <file>`: the way `bun link`'s shim runs it — the
    // executed script itself.
    const serve = serveNew(['new', '--port', '0', '--no-open'], { MADARCH_HOME: home, MADARCH_APP: app }, [CLI]);
    const printed = await printedLiveFacts(serve);
    expect(statSync(printed.folder).isDirectory()).toBe(true);
    expect(printed.id).toMatch(/^[0-9a-f-]+$/);
    await serve.finish();
  });
});

