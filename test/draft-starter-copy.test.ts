/**
 * `madarch init` copies a template into the product repository: the copy is the engine's only source of the product's
 * kinds, so a draft that writes none — or a starter data module that comes up empty — must fail here, in the source and
 * in the binary the release build compiles. The test fills nothing: it reads the files the draft wrote.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDraft } from '../src/product/draft.js';
import { STARTER_FILES } from '../src/knowledge/seed.js';
import { readKinds } from '../src/product/manifest/kinds.js';
import { gitEnv } from './git-env.js';
import { SAMPLE_IDENTITY } from './knowledge-fixture.js';
import { closureOf } from '../src/plugin/closure.js';
import { BUNDLED_PLUGINS, bundledClosureHash } from '../src/plugin/bundled.js';
import { parsePluginLock } from '../src/plugin/lock.js';
import { probeUnit } from '../src/plugin/conformance.js';
import type { PluginContractDeclaration } from '../src/plugin/protocol.js';

const env = gitEnv(SAMPLE_IDENTITY);
let root = '';
let folder = '';

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'madarch-draft-starter-'));
  const draft = createDraft({ home: join(root, 'products'), name: 'starter-copy', gitEnv: env });
  if (draft.outcome !== 'created') throw new Error(`the draft was not made: ${JSON.stringify(draft)}`);
  folder = draft.folder;
});

afterAll(() => {
  if (root !== '') rmSync(root, { recursive: true, force: true });
});

/** Protocol probes hold no repository facts, but carry the ordinary caller's explicit input envelope. */
function probeArgs(installed: string): string[] {
  const contract = (JSON.parse(readFileSync(join(installed, 'contract.json'), 'utf8')) as { outputs: PluginContractDeclaration }).outputs;
  const unit = probeUnit(contract);
  // A catalogue's output contract is supplied by the conformance kit's deterministic agent peer.
  if (unit === undefined) return [];
  const selected = contract.vertices.find((vertex) => vertex.kind === unit.kind)!;
  const edgeOutputs = contract.edges.flatMap((edge) => {
    const from = typeof edge.from === 'string' ? [edge.from] : edge.from;
    const to = typeof edge.to === 'string' ? [edge.to] : edge.to;
    return from.flatMap((source) => to.map((target) => ({ kind: edge.kind, from: source, to: target })));
  });
  return ['--unit', JSON.stringify({ ...unit, inputs: {
    repositories: [], contract: { vertices: [{ ...selected, fields: selected.fields ?? [] }], edges: contract.edges },
    edgeOutputs, outputKinds: [unit.kind],
  } })];
}

describe('the starter set a draft copies', () => {
  test('every starter file stands in the product repository byte for byte', () => {
    expect(STARTER_FILES.length).toBeGreaterThan(0);
    for (const starter of STARTER_FILES) {
      const file = join(folder, starter.path);
      expect({ path: starter.path, present: existsSync(file) }, starter.path).toEqual({ path: starter.path, present: true });
      // A file that is not text (a plugin's WebAssembly module) is compared as bytes; the text stands empty for it.
      const same = starter.bytes === undefined
        ? readFileSync(file, 'utf8') === starter.content
        : Buffer.from(starter.bytes).equals(readFileSync(file));
      expect({ path: starter.path, same }, starter.path).toEqual({ path: starter.path, same: true });
    }
  });

  test('everything installs complete, release-approved closures and every plugin passes the CLI check', () => {
    const lock = parsePluginLock(readFileSync(join(folder, 'madarch/plugins.lock'), 'utf8'));
    expect(lock.ok).toBe(true);
    if (!lock.ok) throw new Error(lock.message);
    for (const plugin of BUNDLED_PLUGINS) {
      const installed = join(folder, plugin.folder);
      const closure = closureOf(installed);
      expect(closure.hash).toBe(bundledClosureHash(plugin));
      expect(closure.hash).toBe(closureOf(join(import.meta.dir, '..', plugin.folder)).hash);
      expect(lock.entries.find((entry) => entry.id === plugin.id)?.closure).toBe(closure.hash);
      const output = execFileSync(process.execPath, ['scripts/madarch.ts', 'plugin', 'check', installed, ...probeArgs(installed)], {
        cwd: join(import.meta.dir, '..'), env: { ...env, MADARCH_PLUGIN_SANDBOX: 'off' }, encoding: 'utf8', timeout: 120_000,
      });
      expect(output).toContain('check: conforms');
      if (closure.manifest.agent?.catalogue === true) {
        expect(output).toContain('unit conformance-1: extracted');
        expect(output).toContain('agent: unit conformance-1, session conformance, 1 turns');
        expect(output).toContain('pause: the session stayed paused past the heartbeat deadline and resumed');
        expect(output).toContain('stop: the plugin exited when asked');
      }
    }
    expect(existsSync(join(folder, 'plugins/db-schema/package.json'))).toBe(true);
    expect(existsSync(join(folder, 'plugins/db-schema/bun.lock'))).toBe(true);
  }, 300_000);

  test('the compiled CLI resolves installed starter package manifests at runtime', () => {
    const binary = join(root, 'madarch-test');
    execFileSync(process.execPath, ['build', '--compile', '--compile-autoload-package-json', 'scripts/madarch.ts', '--outfile', binary], {
      cwd: join(import.meta.dir, '..'), env, encoding: 'utf8', timeout: 120_000,
    });
    for (const plugin of BUNDLED_PLUGINS) {
      const output = execFileSync(binary, ['plugin', 'check', join(folder, plugin.folder), ...probeArgs(join(folder, plugin.folder))], {
        cwd: root, env: { ...env, MADARCH_PLUGIN_SANDBOX: 'off' }, encoding: 'utf8', timeout: 120_000,
      });
      expect(output).toContain('check: conforms');
    }
  }, 300_000);

  test("the manifest the copy holds is the product's kinds, with no finding", () => {
    const read = readKinds(folder);
    expect(read.present).toBe(true);
    if (!read.present) return;
    expect(read.manifest.findings).toEqual([]);
    expect(read.manifest.kinds.size).toBeGreaterThan(0);
    // The draft committed what it wrote: a fill pins a commit, and an uncommitted copy would be read by nothing.
    expect(execFileSync('git', ['-C', folder, 'rev-parse', 'HEAD'], { env, encoding: 'utf8' }).trim()).toMatch(/^[0-9a-f]{40}$/);
  });
});
