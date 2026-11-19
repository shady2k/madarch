/**
 * Core plugins and the environment a plugin declares (owner's decision, 2026-11-15; decision 0038): a core plugin is the
 * one gate to one outside source and the host grants exactly that; an ordinary plugin holds no environment at all, reads
 * the graph, and asks the host for outside data, which is routed to the gate that owns the source. An undeclared access
 * is refused with a sentence naming the plugin and the access.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { capabilityProblem, declarationOf, environmentOf } from '../src/plugin/capabilities.js';
import { ClosureRefusal, closureOf, parsePluginManifest } from '../src/plugin/closure.js';
import { PluginHost } from '../src/plugin/host.js';
import { bwrapArguments, type SandboxSpec } from '../src/plugin/sandbox.js';

const roots: string[] = [];
afterAll(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

/** One scratch folder. */
function scratch(): string {
  const folder = mkdtempSync(join(tmpdir(), 'madarch-capabilities-'));
  roots.push(folder);
  return folder;
}

/** A minimal plugin manifest, with the declaration fields a case adds. */
function manifest(extra: Record<string, unknown>, name = 'probe'): string {
  return JSON.stringify({
    name, version: '1.0.0', entry: 'entry.ts', runtime: { name: 'bun', version: Bun.version },
    produces: [{ kind: 'item', fields: '*', reads: [] }], ...extra,
  }, null, 2);
}

describe('a plugin declares its tier and its capabilities', () => {
  test('a manifest naming no tier is an ordinary plugin and the host grants it nothing', () => {
    const declaration = declarationOf({});
    expect(declaration).toEqual({ tier: 'ordinary', capabilities: [] });
    expect(environmentOf(declaration)).toEqual({ tier: 'ordinary', repository: false, filesystem: false, network: false, agents: false });
  });

  test('a core plugin is the one gate to one source; an ordinary plugin owns none', () => {
    expect(capabilityProblem({ tier: 'core', capabilities: ['git'] }, 'git')).toBeUndefined();
    expect(capabilityProblem({ tier: 'core', capabilities: ['filesystem'] }, 'disk')).toBeUndefined();
    expect(capabilityProblem({ tier: 'ordinary', capabilities: ['git'] }, 'imports')).toBeUndefined();
    expect(capabilityProblem({ tier: 'core', capabilities: [] }, 'gate')).toContain('the core plugin "gate" declares no capability: a core plugin is the one gate to one outside source, and it names that source');
    expect(capabilityProblem({ tier: 'core', capabilities: ['git', 'filesystem'] }, 'gate')).toContain('declares 2 capabilities');
    expect(capabilityProblem({ tier: 'ordinary', capabilities: [] }, 'plain')).toBeUndefined();
  });

  test('the environment is the source a core plugin owns, and the agent capability a plugin asks for', () => {
    expect(environmentOf({ tier: 'core', capabilities: ['git'] })).toMatchObject({ repository: true, filesystem: false, network: false, agents: false });
    expect(environmentOf({ tier: 'core', capabilities: ['filesystem'] })).toMatchObject({ repository: true, filesystem: true });
    expect(environmentOf({ tier: 'ordinary', capabilities: ['agents'] })).toMatchObject({ repository: false, agents: true });
    expect(environmentOf({ tier: 'core', capabilities: ['network'] })).toMatchObject({ network: true, repository: false });
  });

  test('an unknown capability is refused with the file, the line and the full path', () => {
    const folder = scratch();
    const text = manifest({ tier: 'ordinary', capabilities: ['disk'] });
    const file = join(folder, 'plugin.json');
    expect(() => parsePluginManifest(text, file)).toThrow(ClosureRefusal);
    try {
      parsePluginManifest(text, file);
    } catch (error) {
      const refusal = error as ClosureRefusal;
      expect(refusal.message).toStartWith(`${file}:${String(text.split('\n').findIndex((line) => line.includes('"capabilities"')) + 1)}: `);
      expect(refusal.message).toContain('declares the capability "disk": the capabilities are "git", "filesystem", "network", "agents"');
      expect(refusal.file).toBe(file);
    }
  });

  test('a core plugin that names two sources is refused at its capabilities, naming both', () => {
    const folder = scratch();
    const file = join(folder, 'plugin.json');
    let said = '';
    try { parsePluginManifest(manifest({ tier: 'core', capabilities: ['git', 'network'] }), file); } catch (error) { said = (error as Error).message; }
    const text = manifest({ tier: 'core', capabilities: ['git', 'network'] });
    expect(said).toContain(`${file}:${String(text.split('\n').findIndex((line) => line.includes('"capabilities"')) + 1)}: the core plugin "probe" declares 2 capabilities`);
  });
});

describe('the host grants exactly what is declared', () => {
  test('an ordinary plugin with tools is refused, naming the plugin and the tool', async () => {
    const folder = scratch();
    writeFileSync(join(folder, 'plugin.json'), manifest({ tier: 'ordinary', capabilities: [], tools: [{ name: 'git', source: 'system', minimumVersion: '2.31' }] }));
    writeFileSync(join(folder, 'contract.json'), JSON.stringify({ id: 'probe', version: '1.0.0', outputs: { vertices: [], edges: [] }, rights: { network: 'none' } }));
    writeFileSync(join(folder, 'entry.ts'), "import { definePlugin } from 'madarch-plugin-sdk';\nawait definePlugin({name:'probe',version:'1.0.0',contract:{vertices:[],edges:[]},extract:()=>({end:{state:'complete'}})});");
    const host = new PluginHost({ pluginFolder: folder, repository: folder, workRoot: join(folder, 'work'), trust: 'production', releaseHashes: [closureOf(folder).hash] });
    await expect(host.open()).rejects.toThrow(`the ordinary plugin "probe" names the tool "git": a tool runs in a core plugin's environment, and no other plugin has one`);
  });

  test('a plugin with an agent part and no "agents" capability is refused, naming the plugin and the access', async () => {
    const folder = scratch();
    writeFileSync(join(folder, 'plugin.json'), manifest({ tier: 'ordinary', capabilities: [], agent: { prompt: 'prompt.md', roots: ['.'] } }));
    writeFileSync(join(folder, 'prompt.md'), 'Fill the item kind.');
    writeFileSync(join(folder, 'contract.json'), JSON.stringify({ id: 'probe', version: '1.0.0', outputs: { vertices: [], edges: [] }, rights: { network: 'none' } }));
    writeFileSync(join(folder, 'entry.ts'), "import { definePlugin } from 'madarch-plugin-sdk';\nawait definePlugin({name:'probe',version:'1.0.0',contract:{vertices:[],edges:[]},extract:()=>({end:{state:'complete'}})});");
    const host = new PluginHost({ pluginFolder: folder, repository: folder, workRoot: join(folder, 'work'), trust: 'production', releaseHashes: [closureOf(folder).hash] });
    await expect(host.open()).rejects.toThrow('declares an agent part and declares no "agents" capability: an agent is outside access, and the host runs one only for a plugin that declares it');
  });

  test('a plugin that introduces itself with rights its contract does not declare is refused at once, not at the deadline', async () => {
    // A refusal at the introduction is the open's answer: the host must settle it the moment the introduction is refused,
    // never hold the caller until the handshake deadline turns the same refusal into a timeout.
    const folder = scratch();
    writeFileSync(join(folder, 'plugin.json'), manifest({ tier: 'ordinary', capabilities: [] }));
    writeFileSync(join(folder, 'contract.json'), JSON.stringify({ id: 'probe', version: '1.0.0', outputs: { vertices: [], edges: [] }, rights: { network: 'none' } }));
    writeFileSync(join(folder, 'entry.ts'), "import { definePlugin } from 'madarch-plugin-sdk';\nawait definePlugin({name:'probe',version:'1.0.0',graph:true,contract:{vertices:[],edges:[]},extract:()=>({end:{state:'complete'}})});");
    const host = new PluginHost({ pluginFolder: folder, repository: folder, workRoot: join(folder, 'work'), trust: 'production', releaseHashes: [closureOf(folder).hash], limits: { handshakeMs: 30_000 }, env: { ...process.env, MADARCH_PLUGIN_SANDBOX: 'off' } });
    const started = Date.now();
    await expect(host.open()).rejects.toMatchObject({ code: 'rights-mismatch' });
    expect(Date.now() - started).toBeLessThan(5_000);
  }, 15_000);

  test('a plugin with no source is refused a blob read, and the refusal names the plugin and the access', async () => {
    const folder = scratch();
    writeFileSync(join(folder, 'plugin.json'), manifest({ tier: 'ordinary', capabilities: [] }));
    // The contract declares exactly the rights the SDK's introduction repeats (decision 0039): a plugin that reconciles
    // reads its own facts, and its contract says so before the process starts.
    writeFileSync(join(folder, 'contract.json'), JSON.stringify({ id: 'probe', version: '1.0.0', outputs: { vertices: [], edges: [] }, rights: { network: 'none', graph: true, graphReads: ['files', 'value', 'ownFacts'] } }));
    writeFileSync(join(folder, 'entry.ts'), "import { definePlugin } from 'madarch-plugin-sdk';\nawait definePlugin({name:'probe',version:'1.0.0',contract:{vertices:[],edges:[]},read:(request)=>({text:'x',lines:1,bytes:1,binary:false}),extract:()=>({end:{state:'complete'}})});");
    // The host's own environment carries the choice, never the test process's: a leaked variable would run every later
    // plugin of the run unconfined.
    const session = await new PluginHost({ pluginFolder: folder, repository: folder, workRoot: join(folder, 'work'), trust: 'production', releaseHashes: [closureOf(folder).hash], env: { ...process.env, MADARCH_PLUGIN_SANDBOX: 'off' } }).open();
    try {
      await expect(session.readBlob({ repository: 'app', blob: 'a'.repeat(40) })).rejects.toMatchObject({
        code: 'read-unsupported',
        message: expect.stringContaining('the plugin "probe" declares the tier "ordinary" and no source, and a blob is read by a core plugin that owns the repository: declare "repository" as the one capability of a core plugin'),
      });
    } finally { await session.close(); }
  }, 60_000);
});

describe('the sandbox grants one environment', () => {
  const runtime = process.execPath;
  const spec = (emptyRoot: boolean, repository?: string): SandboxSpec => ({
    closureFolder: '/tmp/closure', workFolder: '/tmp/work', runtime, entry: 'entry.ts', emptyRoot,
    limits: { memoryBytes: 1, cpuQuotaMicros: 1, cpuPeriodMicros: 1, pids: 1 },
    ...(repository === undefined ? {} : { repository }),
  });
  const argsOf = (held: SandboxSpec): readonly string[] => bwrapArguments(held, { bwrap: 'bwrap', seccompFile: 'seccomp.bpf', syncFd: 3, seccompFd: 4, rootUid: undefined });

  test('a plugin with no environment gets an empty root: no host file system, no repository, no tool', () => {
    const args = argsOf(spec(true));
    expect(args.slice(0, 5)).toEqual(['--unshare-all', '--clearenv', '--die-with-parent', '--new-session', '--tmpfs']);
    expect(args).toContain('/');
    expect(args).not.toContain('/repo');
    expect(args.some((one) => one.startsWith('/tools/'))).toBe(false);
  });

  test('a core plugin sees its one source bound read-only', () => {
    const args = argsOf(spec(false, '/tmp/closure'));
    // No root tmpfs: the host's root stands read-only, and the one source is bound at /repo.
    expect(args[4]).toBe('--ro-bind');
    expect(args.join(' ')).toContain('--ro-bind /tmp/closure /repo');
  });
});
