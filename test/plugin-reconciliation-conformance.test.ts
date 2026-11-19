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
import imports from '../plugins/imports/contract.json';
import glossary from '../plugins/glossary/contract.json';
import quarantine from '../plugins/test-quarantine/contract.json';

const run = (cwd: string, args: string[]): string => {
  const result = Bun.spawnSync(['git', '-C', cwd, ...args], { stdout: 'pipe', stderr: 'pipe' });
  if (result.exitCode !== 0) throw new Error(`${cwd}:1: git ${args.join(' ')}: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
};

for (const plugin of ['disk', 'git', 'imports', 'db-schema', 'glossary', 'test-quarantine']) {
  test(`${plugin} reconciles its real source reader through the SDK: add/remove/update only`, async () => {
    const work = mkdtempSync(join(tmpdir(), 'madarch-reconcile-'));
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
        files: async pattern => pattern === '**/quarantine-results.json' ? [] : paths.map(path => ({ kind: 'code.file', key: { path }, keyEdges: { 'code.file-repository': { kind: 'code.repository', key: { name: 'repo' } } } })),
        value: async (kind, key, field) => kind === 'code.repository' && field === 'name' ? 'repo' : field === 'url' ? null : field === 'blob' ? String(key['path']) : texts[String(key['path'])],
      };
      const contract = (plugin === 'disk' ? disk.outputs : plugin === 'db-schema' ? schema.outputs : plugin === 'imports' ? imports.outputs : plugin === 'glossary' ? glossary.outputs : plugin === 'test-quarantine' ? quarantine.outputs : git.outputs) as PluginContractDeclaration;
      const kind = plugin === 'disk' || plugin === 'git' ? 'code.file' : plugin === 'imports' ? 'code.package' : plugin === 'db-schema' ? 'code.table' : plugin === 'glossary' ? 'doc.term' : 'code.test-quarantine';
      const report = await checkReconciliationConformance({
        readBlob: async request => { const text = texts[request.blob] ?? ''; return { text, bytes: text.length, lines: text.split('\n').length, binary: false }; },
        pluginFolder: resolve('plugins', plugin), repository: work, workRoot: work, graph, limits: { handshakeMs: 2_000, unitMs: 10_000, stopGraceMs: 100 },
        // The kit's own environment carries the choice, never the test process's.
        env: { ...process.env, MADARCH_PLUGIN_SANDBOX: 'off' },
        unit: { unitId: 'fixture', kind, key: {}, inputs: { repositories: [pin], contract, edgeOutputs: [], patterns: ['**/*.ts'] } },
      });
      expect(report.lines.filter(line => !line.ok).map(line => line.text)).toEqual([]);
      expect(report.ok).toBe(true);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  }, 30_000);
}
