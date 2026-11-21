/**
 * The plugin protocol's read (madarch-u3vw.16, decision 0037): the host asks the plugin, in its own process, for the
 * lines of one blob, and the plugin answers text, line and byte counts and whether it is text at all. This is the one
 * read path a page's text and an agent's file reads take.
 */
import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PluginHost } from '../src/plugin/host.js';
import { PROTOCOL_VERSION } from '../src/plugin/protocol.js';

test('the host reads a blob through the plugin, line ranges included', async () => {
  const root = mkdtempSync(join(tmpdir(), 'madarch-plugin-read-'));
  const outputs = { vertices: [{ kind: 'item', key: ['id'] }], edges: [] };
  writeFileSync(join(root, 'plugin.json'), JSON.stringify({ name: 'reader', version: '1.0.0', tier: 'core', capabilities: ['git'], entry: 'entry.ts', runtime: { name: 'bun', version: Bun.version }, produces: [{ kind: 'item', fields: '*', partition: 'key' }] }));
  writeFileSync(join(root, 'contract.json'), JSON.stringify({ id: 'reader', version: '1.0.0', outputs, rights: { network: 'none' } }));
  writeFileSync(join(root, 'entry.ts'), `import { definePlugin } from 'madarch-plugin-sdk';
const lines = ['# Notes', '', 'The first line.', 'The second line.'];
await definePlugin({readOnly:true,name:'reader',version:'1.0.0',contract:${JSON.stringify(outputs)},
  read: (request) => {
    const from = request.from ?? 1;
    const to = request.to ?? lines.length;
    return { text: lines.slice(from - 1, to).join('\\n') + '\\n', lines: lines.length, bytes: 64, binary: false };
  },
  extract: () => ({ end: { state: 'complete' } })});`);
  let session: Awaited<ReturnType<PluginHost['open']>> | undefined;
  try {
    session = await new PluginHost({ pluginFolder: root, repository: root, workRoot: join(root, 'work'), trust: 'validation', env: { ...process.env, MADARCH_PLUGIN_SANDBOX: 'off' } }).open();
    expect(session.declared.read).toBe(true);
    const whole = await session.readBlob({ repository: root, blob: 'a'.repeat(40) });
    expect(whole).toEqual({ text: '# Notes\n\nThe first line.\nThe second line.\n', lines: 4, bytes: 64, binary: false });
    const range = await session.readBlob({ repository: root, blob: 'a'.repeat(40), from: 3, to: 3 });
    expect(range.text).toBe('The first line.\n');
    expect(PROTOCOL_VERSION).toBe('madarch.plugins/3');
  } finally {
    await session?.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

test('a plugin that declares no read answers the host by name', async () => {
  const root = mkdtempSync(join(tmpdir(), 'madarch-plugin-noread-'));
  const outputs = { vertices: [{ kind: 'item', key: ['id'] }], edges: [] };
  writeFileSync(join(root, 'plugin.json'), JSON.stringify({ name: 'plain', version: '1.0.0', entry: 'entry.ts', runtime: { name: 'bun', version: Bun.version }, produces: [{ kind: 'item', fields: '*', partition: 'key' }] }));
  writeFileSync(join(root, 'contract.json'), JSON.stringify({ id: 'plain', version: '1.0.0', outputs, rights: { network: 'none' } }));
  writeFileSync(join(root, 'entry.ts'), `import { definePlugin } from 'madarch-plugin-sdk';
await definePlugin({readOnly:true,name:'plain',version:'1.0.0',contract:${JSON.stringify(outputs)},extract:()=>({end:{state:'complete'}})});`);
  let session: Awaited<ReturnType<PluginHost['open']>> | undefined;
  try {
    session = await new PluginHost({ pluginFolder: root, repository: root, workRoot: join(root, 'work'), trust: 'validation', env: { ...process.env, MADARCH_PLUGIN_SANDBOX: 'off' } }).open();
    await expect(session.readBlob({ repository: root, blob: 'a'.repeat(40) })).rejects.toMatchObject({ code: 'read-unsupported' });
  } finally {
    await session?.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
