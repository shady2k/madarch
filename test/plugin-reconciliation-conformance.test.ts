import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { checkReconciliationConformance } from '../src/plugin/conformance.js';
import type { GraphAnswerer } from '../src/plugin/host.js';
import type { PluginContractDeclaration } from '../src/plugin/protocol.js';
import disk from '../plugins/disk/contract.json';
import git from '../plugins/git/contract.json';
import schema from '../plugins/db-schema/contract.json';

const run = (cwd: string, args: string[]): string => {
  const result = Bun.spawnSync(['git', '-C', cwd, ...args], { stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) throw new Error(`${cwd}:1: git ${args.join(' ')}: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
};

for (const plugin of ['disk', 'git', 'imports', 'db-schema', 'glossary', 'test-quarantine']) {
  test(`${plugin} reconciles its real source reader through the SDK: add/remove/update only`, async () => {
    const work = mkdtempSync(join(tmpdir(), 'madarch-reconcile-'));
    const previous = process.env['MADARCH_PLUGIN_SANDBOX'];
    process.env['MADARCH_PLUGIN_SANDBOX'] = 'off';
    try {
      run(work, ['init', '-q']);
      for (const name of ['added', 'changed', 'unchanged']) writeFileSync(join(work, `${name}.ts`), `export const ${name} = 1;\n`);
      run(work, ['add', '.']);
      run(work, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'source fixture']);
      const commit = run(work, ['rev-parse', 'HEAD']);
      const pin = { repository: 'repo', root: work, commit };
      const texts: Record<string, string> = {
        'imports.ts': `import 'added-package';\nimport 'changed-package';\nimport 'unchanged-package';\n`,
        'schema.ts': 'const sql = `CREATE TABLE added (id text); CREATE TABLE changed (id text); CREATE TABLE unchanged (id text);`;\n',
        'glossary.md': '- **Added** — First definition.\n- **Changed** — Second definition.\n- **Unchanged** — Third definition.\n',
        'example.test.ts': ['added', 'changed', 'unchanged'].map(name => `quarantined('madarch-1', test, 'slow', '${commit}')('${name}', () => {});`).join('\n'),
      };
      const paths = plugin === 'imports' ? ['imports.ts'] : plugin === 'db-schema' ? ['schema.ts'] : plugin === 'glossary' ? ['glossary.md'] : plugin === 'test-quarantine' ? ['example.test.ts'] : ['added.ts', 'changed.ts', 'unchanged.ts'];
      const graph: GraphAnswerer = {
        files: async pattern => pattern === '**/quarantine-results.json' ? [] : paths.map(path => ({ kind: 'code.file', key: { repository: 'repo', path } })),
        value: async (_kind, key, field) => field === 'url' ? null : field === 'blob' ? 'b'.repeat(40) : texts[String(key['path'])],
      };
      const contract = (plugin === 'disk' ? disk.outputs : plugin === 'db-schema' ? schema.outputs : git.outputs) as PluginContractDeclaration;
      const kind = plugin === 'disk' || plugin === 'git' ? 'code.file' : plugin === 'imports' ? 'code.package' : plugin === 'db-schema' ? 'code.table' : plugin === 'glossary' ? 'doc.term' : 'code.test-quarantine';
      const report = await checkReconciliationConformance({
        pluginFolder: resolve('plugins', plugin), repository: work, workRoot: work, graph, limits: { handshakeMs: 2_000, unitMs: 10_000, stopGraceMs: 100 },
        unit: { unitId: 'fixture', kind, key: {}, inputs: { repositories: [pin], contract, edgeOutputs: [], patterns: ['**/*.ts'] } },
      });
      expect(report.lines.filter(line => !line.ok).map(line => line.text)).toEqual([]);
      expect(report.ok).toBe(true);
    } finally {
      if (previous === undefined) delete process.env['MADARCH_PLUGIN_SANDBOX']; else process.env['MADARCH_PLUGIN_SANDBOX'] = previous;
      rmSync(work, { recursive: true, force: true });
    }
  }, 30_000);
}
