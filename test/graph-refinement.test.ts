import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseKinds } from '../src/product/manifest/kinds.js';
import { declaredKindReads, manifestContractOf } from '../src/fill/stages/plugin-contract.js';
import { publishGraphDrafts } from '../src/graph/write.js';
import { GraphReader } from '../src/knowledge/graph-read.js';
import { createTestDatabaseOwner } from './test-database.js';
import { bindTestWriteCapability } from './write-capability-fixture.js';
import { sha256Hex } from '../src/graph/digest.js';
import { readKindAssertions } from '../src/graph/records.js';

test('newest assertions replace producer refinement order while retaining every source fact', async () => {
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
      'kinds:', '  note:', '    ', '    source: graph', '    fields:',
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
    const sources = names.map((_, index) => `019a0000-0000-7000-8000-00000000001${index}`);
    const owner = await createTestDatabaseOwner({ graphContract: contract });
    try {
      // Decision 0039.16 removes producer seniority: later valid-time values win.
      for (const producer of [...names].reverse()) {
        const content = `${producer}\nsource\n`;
        const digest = sha256Hex(Buffer.from(content));
        await owner.transaction('write', async tx => {
          await bindTestWriteCapability(tx, contract, sources[names.indexOf(producer)]);
          await publishGraphDrafts(tx, contract, { vertices: [
            { kind: 'system.content-snapshot', key: { digest }, values: { content }, producer, producerVersion: '1.0.0' },
            { kind: 'note', key: { name: 'one' }, values: { body: producer, ...(producer === 'parser-last' ? {} : { detail: producer }) }, validFrom: `2020-01-0${names.indexOf(producer) + 1}T00:00:00Z`, producer, producerVersion: '1.0.0', evidence: [{ target: { kind: 'system.content-snapshot', key: { digest } }, locator: { path: `${producer}.md`, digest, lineStart: 1, lineEnd: 2 } }] },
          ], removals: [] });
        });
      }
      for (const producer of names.slice(0, 2).reverse()) {
        await owner.transaction('write', async tx => {
          await bindTestWriteCapability(tx, contract, sources[names.indexOf(producer)]);
          await publishGraphDrafts(tx, contract, { vertices: [{ kind: 'note', key: { name: 'two' }, values: { body: producer }, validFrom: `2020-01-0${names.indexOf(producer) + 1}T00:00:00Z`, producer, producerVersion: '1.0.0' }], removals: [] });
        });
      }
      const reader = new GraphReader(owner, () => new Date().toISOString(), undefined, undefined, undefined, declaredKindReads(manifest), undefined, owner.graphContract);
      const result = await reader.byPrefix('note', 'note:', 10);
      const entity = result.rows.find((one) => one.key === 'note:one')!;
      expect(result.rows.find((one) => one.key === 'note:two')?.properties['body']).toBe('middle');
      expect(entity.properties['body']).toBe('parser-last');
      expect(entity.properties['detail']).toBe('middle');
      // Prefix rows are value-only; the canonical detail read retains every source opinion and its evidence.
      const [detail] = await reader.find(entity.key);
      expect(detail).toBeDefined();
      expect(detail!.opinions?.filter((one) => one.field === 'body').map((one) => one.producer).sort()).toEqual(sources.toSorted());
      expect(new Set(detail!.evidence?.map((one) => one.path))).toEqual(new Set(names.map((name) => `${name}.md`)));
      const records = await owner.run(tx => readKindAssertions(tx, 'vertex', 'note', ['body', 'detail'], { contract: owner.graphContract }));
      expect(records.find(row => row.key['name'] === 'one')?.assertions.filter(a => a.property === 'body').every(a => a.evidence.length === 1)).toBe(true);
    } finally { await owner.close(); }
  } finally { rmSync(folder, { recursive: true, force: true }); }
}, 30_000);
