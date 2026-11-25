/**
 * The imports producer keeps its heartbeat while it reads a repository: the SDK's heartbeat is a timer, and a
 * synchronous pass over every file would silence the plugin for as long as it parses. This unit reads four hundred
 * files, which outlasted the host's own five-second silence bound before the reader yielded between files.
 *
 * This is an end-to-end check under that default bound, not a proof of the yield: on a machine that reads four hundred
 * files inside five seconds it would pass even without one. The yield itself is proved by the clockless case in
 * test/imports-read.test.ts.
 */
import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkCgroupDelegation, cgroupParent } from '../src/plugin/cgroup.js';
import { closureOf } from '../src/plugin/closure.js';
import { PluginHost } from '../src/plugin/host.js';
import { sandboxSetupProblem } from '../src/plugin/sandbox.js';

const PLUGINS = fileURLToPath(new URL('..', import.meta.url));

/** The reason this machine cannot run a plugin, when it cannot: the case is skipped with it, never passed. */
const sandboxProblem: string | undefined = await (async (): Promise<string | undefined> => {
  if (process.env['MADARCH_PLUGIN_SANDBOX'] === 'off') return undefined;
  const parent = cgroupParent();
  const delegation = checkCgroupDelegation(parent);
  if (delegation !== undefined) return delegation.message;
  const problem = await sandboxSetupProblem({ cgroupParent: parent });
  return problem?.message;
})();

test.skipIf(sandboxProblem !== undefined)('a unit over more files than the silence bound keeps its heartbeat and completes', async () => {
  const files = new Map<string, string>();
  for (let index = 0; index < 400; index += 1) {
    const body = Array.from({ length: 2_000 }, (_, at) => `export const v${String(at)} = ${String(at)} + Math.max(${String(at)}, 1);`).join('\n');
    files.set(`src/m${String(index)}.ts`, `${body}\n`);
  }
  const folder = join(PLUGINS, 'plugins', 'imports');
  const closure = closureOf(folder);
  const work = mkdtempSync(join(tmpdir(), 'madarch-imports-heartbeat-'));
  const host = new PluginHost({
    pluginFolder: folder,
    closure,
    repository: work,
    workRoot: join(work, 'host'),
    trust: 'production',
    releaseHashes: [closure.hash],
    ...(cgroupParent() === undefined ? {} : { cgroupParent: cgroupParent() }),
    graph: {
      files: async () => [...files.keys()].map((path) => ({ kind: 'code.file', key: { repository: 'app', path } })),
      value: async (_kind, key, field) => field === 'blob' ? `blob-${String(key['path'])}` : null,
    },
    // The one blob read (decision 0038): the graph names the blob, and the host answers its text.
    readBlob: async (ask) => {
      const text = files.get(String(ask.blob).replace(/^blob-/u, '')) ?? '';
      return { text, lines: text.split('\n').length, bytes: text.length, binary: false };
    },
  });
  const session = await host.open();
  try {
    const outcome = await session.runUnit({ unitId: 'imports-heartbeat', kind: 'code.package', key: {}, inputs: {} });
    if (outcome.state !== 'extracted') throw new Error(`the unit was not extracted: ${outcome.cause.code}: ${outcome.cause.message}`);
    expect(outcome.result.end.state).toBe('complete');
    expect(outcome.result.problems).toEqual([]);
  } finally {
    await session.close();
    rmSync(work, { recursive: true, force: true });
  }
}, 120_000);
