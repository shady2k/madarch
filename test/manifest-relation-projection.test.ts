import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateProductManifests } from '../src/graph/manifest-publication.js';
import { MANIFEST_RELATION_EDGE } from '../src/graph/manifest-contract.js';
import { writeFolderManifest } from './catalog-folder-fixture.js';

test('relation projections retain field-qualified declarations without inventing wildcard endpoint pairs', () => {
  const folder = mkdtempSync(join(tmpdir(), 'madarch-relation-projection-'));
  try {
    mkdirSync(join(folder, 'madarch'));
    writeFolderManifest(folder, `edges:
  - name: mentions
    role: reference
    direction: out
    from: [any]
    to: [any]
    repeats: false
    cardinality: { from: { min: 0, max: null }, to: { min: 0, max: null } }
    labels:
      en: { out: mentions, in: mentioned by }
      ru: { out: упоминает, in: упомянут в }
kinds:
  page:
    source: document
    terms: ["docs/*.md"]
    relations:
      - { type: related, to: "page:{label}" }
      - { type: related, to: "page:{title}" }
`);
    const read = validateProductManifests(folder, undefined, 'a'.repeat(40));
    if (!read.ok) throw new Error(read.findings.map((one) => `${one.file}:${String(one.line)}: ${one.message}`).join('\n'));
    if (read.value === undefined) throw new Error(`${folder}: no manifest`);
    const edges = read.value.edges.filter((one) => one.kind === MANIFEST_RELATION_EDGE);
    expect(edges.map((one) => [one.from.key, one.to.key, one.discriminator])).toEqual([
      [{ name: 'page' }, { name: 'page' }, 'related'],
    ]);
    const declaration = edges[0]!.values!['declaration'] as { relations: { to: string }[] };
    expect(declaration.relations.map((one) => one.to)).toEqual(['page:{label}', 'page:{title}']);
    expect(edges[0]!.evidence).toHaveLength(2);
    const wildcard = read.value.vertices.find((one) => one.kind === 'manifest.relation' && one.key['name'] === JSON.stringify(['edge', 'mentions']));
    expect(wildcard?.values!['declaration']).toMatchObject({ name: 'mentions', from: ['any'], to: ['any'] });
  } finally { rmSync(folder, { recursive: true, force: true }); }
});
