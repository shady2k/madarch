import { afterAll, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'plugin-cli-test-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** Each command has its own module mocks, so other plugin tests still use the real host. */
async function command(mode: 'pass' | 'fail' | 'throw' | 'trace-fail' | 'creation-fail' | 'real-fail', explicit = false, verb: 'check' | 'run' = 'check'): Promise<{ code: number; folder: string; stderr: string }> {
  const folder = join(root, `${verb}-${mode}-${String(explicit)}`);
  mkdirSync(folder);
  const script = `
    import { mock } from 'bun:test';
    import { mkdirSync } from 'node:fs';
    import { join } from 'node:path';
    const mode = ${JSON.stringify(mode)};
    if (mode !== 'real-fail') {
      mock.module('./src/plugin/conformance.ts', () => ({
        describeOutcome: () => ({ ok: true, text: '' }),
        checkConformance: async ({workRoot}) => {
          mkdirSync(join(workRoot, 'conformance', 'plugin'), { recursive: true });
          if (mode === 'throw') throw new Error('session failed');
          return { ok: mode === 'pass', lines: [] };
        },
      }));
    }
    if (${JSON.stringify(verb)} === 'run') {
      mock.module('./src/plugin/host.ts', () => ({
        runUnits: async ({workRoot}) => {
          mkdirSync(join(workRoot, 'plugin'), { recursive: true });
          if (mode === 'throw') throw new Error('session failed');
          return [{ pluginFolder: '', closureHash: '', units: mode === 'pass' ? [] : [{ state: 'not-extracted' }] }];
        },
      }));
    }
    if (mode === 'trace-fail') {
      const trace = await import('./src/obs/trace.ts');
      mock.module('./src/obs/trace.ts', () => ({
        ...trace,
        openTrace: ({store}) => { mkdirSync(join(store, 'partial'), { recursive: true }); throw new Error('trace creation failed'); },
        closeTrace: () => {}, runInTrace: async (_trace, work) => await work(),
      }));
    }
    const { pluginCommand } = await import('./src/plugin/cli.ts');
    // The preload and imports have already run; the command must use the new temporary folder.
    process.env.TMPDIR = ${JSON.stringify(folder)} + (mode === 'creation-fail' ? '/missing' : '');
    process.env.TMP = process.env.TMPDIR;
    process.env.TEMP = process.env.TMPDIR;
    process.exitCode = await pluginCommand([${JSON.stringify(verb)}, './missing-plugin', '--json',
      ...${verb == 'run' ? "['--repo', '.', '--unit', '{\"unitId\":\"u\",\"kind\":\"file\",\"key\":{}}']" : '[]'},
      ...${explicit ? "['--work', " + JSON.stringify(join(folder, 'kept')) + "]" : '[]'}]);
  `;
  const child = Bun.spawn([process.execPath, '-e', script], { cwd: process.cwd(), stdout: 'pipe', stderr: 'pipe' });
  const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (mode !== 'creation-fail' && mode !== 'trace-fail') expect(stdout).toContain(`work: ${explicit ? join(folder, 'kept') : join(folder, 'madarch-plugin-')}`);
  return { code, folder, stderr };
}

for (const mode of ['pass', 'fail', 'throw', 'trace-fail', 'creation-fail', 'real-fail'] as const) {
  test(`plugin check removes anonymous work after ${mode}`, async () => {
    const result = await command(mode);
    expect(result.code).toBe(mode === 'pass' ? 0 : 1);
    expect(readdirSync(result.folder)).toEqual([]);
    if (mode === 'trace-fail') expect(result.stderr).toContain('trace creation failed');
    if (mode === 'creation-fail') expect(result.stderr).toContain('ENOENT');
    if (mode === 'real-fail') expect(result.stderr).toBe('');
  });
}

for (const mode of ['pass', 'fail', 'throw', 'trace-fail'] as const) {
  test(`plugin check preserves explicit --work after ${mode}`, async () => {
    const result = await command(mode, true);
    expect(result.code).toBe(mode === 'pass' ? 0 : 1);
    expect(existsSync(join(result.folder, 'kept'))).toBe(true);
  });
}

for (const mode of ['pass', 'fail', 'throw'] as const) {
  test(`plugin run removes anonymous work after ${mode}`, async () => {
    const result = await command(mode, false, 'run');
    expect(result.code).toBe(mode === 'pass' ? 0 : 1);
    expect(readdirSync(result.folder)).toEqual([]);
  });
}
