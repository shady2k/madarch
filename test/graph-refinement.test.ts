import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseKinds } from '../src/product/manifest/kinds.js';
import { declaredKindReads, manifestContractOf } from '../src/fill/stages/plugin-contract.js';
import { publishGraphDrafts } from '../src/graph/write.js';
import { GraphReader } from '../src/knowledge/graph-read.js';
import { createTestDatabaseOwner } from './test-database.js';

test('fields resolve explicit refinement rather than reverse arrival while retaining every source fact', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'madarch-refinement-'));
  try {
    mkdirSync(join(folder, 'madarch'));
    writeFileSync(join(folder, 'note.md'), '{{ entity.label }}');
    const names = ['agent-first', 'middle', 'parser-last'];
    for (const [index, name] of names.entries()) {
      const path = join(folder, 'plugins', name);
      mkdirSync(path, { recursive: true });
      writeFileSync(join(path, 'contract.json'), JSON.stringify({ id: name, version: '1.0.0', outputs: { vertices: [{ kind: 'note', key: ['name'], fields: ['name', 'body', 'detail'].map((name) => ({ name, type: 'text', meaning: name, example: name, required: name !== 'detail' })) }], edges: [] } }));
      writeFileSync(join(path, 'plugin.json'), JSON.stringify({ name, version: '1.0.0', entry: 'index.ts', runtime: { name: 'bun', version: Bun.version }, produces: [{ kind: 'note', fields: index === 2 ? ['body'] : '*', reads: [], refines: index === 0 ? [] : [names[index - 1]] }] }));
    }
    const text = [
      'kinds:', '  note:', '    template: note.md', '    source: graph', '    fields:',
      '      - { name: name, type: text, binding: "agent-first@1.name" }',
      '      - { name: body, type: text, binding: "agent-first@1.body" }',
      '      - { name: detail, type: text, nullable: true, binding: "agent-first@1.detail" }',
      '    key: [name]', 'plugins:',
      ...names.map((id) => `  - { id: ${id}, version: 1, path: plugins/${id}, inputs: [], outputs: [note], closure: [plugins/${id}/contract.json, plugins/${id}/plugin.json] }`), '',
    ].join('\n');
    writeFileSync(join(folder, 'madarch', 'plugins.lock'), `plugins:\n${names.map((id) => `  - { id: ${id}, version: 1.0.0, closure: ${'a'.repeat(64)}, path: plugins/${id} }`).join('\n')}\n`);
    const manifest = parseKinds(text, join(folder, 'madarch', 'kinds.yaml'), folder);
    expect(manifest.findings).toEqual([]);
    const contract = manifestContractOf(manifest);
    const owner = await createTestDatabaseOwner({ graphContract: contract });
    try {
      // Final refinement arrives first; each producer's evidence and opinion must survive.
      for (const producer of [...names].reverse()) {
        await owner.transaction('write', async (tx) => await publishGraphDrafts(tx, contract, {
          vertices: [{ kind: 'note', key: { name: 'one' }, values: { body: producer, ...(producer === 'parser-last' ? {} : { detail: producer }) }, producer, producerVersion: '1.0.0', evidence: [{ type: 'file', repository: 'fixture', commit_or_digest: producer, path: `${producer}.md`, line_start: 1, line_end: 2 }] }], removals: [],
        }, 1));
      }
      for (const producer of names.slice(0, 2).reverse()) {
        await owner.transaction('write', async (tx) => await publishGraphDrafts(tx, contract, {
          vertices: [{ kind: 'note', key: { name: 'two' }, values: { body: producer }, producer, producerVersion: '1.0.0' }], removals: [],
        }, 1));
      }
      const reader = new GraphReader(owner, () => 'now', undefined, undefined, undefined, declaredKindReads(manifest));
      const result = await reader.byPrefix('note', 'note:', 10);
      const entity = result.rows.find((one) => one.key === 'note:one')!;
      expect(result.rows.find((one) => one.key === 'note:two')?.properties['body']).toBe('middle');
      expect(entity.properties['body']).toBe('parser-last');
      expect(entity.properties['detail']).toBe('middle');
      expect(entity.opinions?.filter((one) => one.field === 'body').map((one) => one.producer).sort()).toEqual(names.map((name) => `${name}@1.0.0`).sort());
      expect(new Set(entity.evidence?.map((one) => one.path))).toEqual(new Set(names.map((name) => `${name}.md`)));
    } finally { await owner.close(); }
  } finally { rmSync(folder, { recursive: true, force: true }); }
}, 30_000);
