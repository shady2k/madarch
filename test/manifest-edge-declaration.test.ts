import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateProductManifests } from '../src/graph/manifest-publication.js';
import { MANIFEST_RELATION_EDGE } from '../src/graph/manifest-contract.js';
import { writeFolderManifest } from './catalog-folder-fixture.js';

test('every explicit endpoint pair retains its serialized declaration and exact source evidence', () => {
  const folder = mkdtempSync(join(tmpdir(), 'madarch-edge-declaration-'));
  try {
    mkdirSync(join(folder, 'madarch'));
    writeFolderManifest(folder, `edges:
  - name: connects
    from: [alpha, beta]
    to: [gamma, delta, epsilon]
    repeats: false
    cardinality: { from: { min: 0, max: null }, to: { min: 0, max: null } }
    labels:
      en: { out: connects, in: connected by }
      ru: { out: связывает, in: связан с }
kinds:
${['alpha', 'beta', 'gamma', 'delta', 'epsilon'].map(name => `  ${name}:
    source: document
    terms: ["docs/${name}/*.md"]`).join('\n')}
`);
    const read = validateProductManifests(folder, undefined, 'a'.repeat(40));
    if (!read.ok) throw new Error(read.findings.map(one => `${one.file}:${one.line}: ${one.message}`).join('\n'));
    if (read.value === undefined) throw new Error(`${folder}: no manifest`);
    const edges = read.value.edges.filter(one => one.kind === MANIFEST_RELATION_EDGE);
    expect(edges.map(one => [one.from.key['name'], one.to.key['name'], one.discriminator])).toEqual([
      ['alpha', 'gamma', 'connects'], ['alpha', 'delta', 'connects'], ['alpha', 'epsilon', 'connects'],
      ['beta', 'gamma', 'connects'], ['beta', 'delta', 'connects'], ['beta', 'epsilon', 'connects'],
    ]);
    const relation = read.value.vertices.find(one => one.kind === 'manifest.relation' && one.key['name'] === JSON.stringify(['edge', 'connects']))!;
    const content = readFileSync(join(folder, 'madarch/catalog.yaml'), 'utf8');
    const digest = createHash('sha256').update(content, 'utf8').digest('hex');
    const line = read.value.manifest.edges!.get('connects')!.line;
    const expectedEvidence = [{ target: { kind: 'system.content-snapshot', key: { digest } }, locator: { digest, lineStart: line, lineEnd: line } }];
    for (const edge of edges) {
      expect(typeof edge.values!['declaration']).toBe('string');
      expect(edge.values!['declaration']).toBe(relation.values!['declaration']);
      expect(JSON.parse(String(edge.values!['declaration']))).toMatchObject({ name: 'connects', from: ['alpha', 'beta'], to: ['gamma', 'delta', 'epsilon'] });
      expect(edge.values!['relation']).toBe('connects');
      expect(edge.evidence).toEqual(expectedEvidence);
    }
    expect(read.value.snapshots.find(one => one.key['digest'] === digest)?.values!['content']).toBe(content);
  } finally { rmSync(folder, { recursive: true, force: true }); }
});
