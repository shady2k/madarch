import { testHostBinding } from './host-binding-fixture.js';
/** A catalogue diagram reads real manifest vertices and relations before it folds and lays out. */
import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { withManifestContract } from '../src/graph/manifest-contract.js';
import { graphContractOf } from '../src/fill/stages/plugin-contract.js';
import { validateProductManifests, publishValidatedManifests } from '../src/graph/manifest-publication.js';
import { publishGraphDrafts } from '../src/graph/write.js';
import { ReadContext } from '../src/graph/graphql-read.js';
import { publishedManifestOf } from '../src/graphql/manifest.js';
import { readProductTemplates } from '../src/graph/product-templates.js';
import { diagramGraphOf } from '../src/render/diagram.js';
import { renderDiagram } from '../src/render/diagram-render.js';
import type { KnowledgeProduct } from '../src/knowledge/product.js';
import { CLUSTER_PORT } from '../src/adapters/postgres-cluster.js';
import { createTestDatabaseOwner } from './test-database.js';
import { gitEnv } from './git-env.js';
import { SAMPLE_IDENTITY } from './knowledge-fixture.js';

test('a catalogue with 80 related kinds reads translated labels and renders within 200 ms warm', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'madarch-catalogue-diagram-'));
  let owner: Awaited<ReturnType<typeof createTestDatabaseOwner>> | undefined;
  try {
    const kindsFolder = join(folder, 'madarch/kinds/demo/core');
    mkdirSync(kindsFolder, { recursive: true });
    writeFileSync(join(folder, 'madarch/catalog.yaml'), readFileSync(join(import.meta.dir, 'graphql/fixture-product-catalog.yaml'), 'utf8').replace('subgroup-kind-bound: 12', 'subgroup-kind-bound: 100'));
    for (const name of ['demo.repository', 'demo.file']) {
      writeFileSync(join(kindsFolder, `${name}.yaml`), readFileSync(join(import.meta.dir, `graphql/fixture-product-${name}.yaml`)));
    }
    const base = readFileSync(join(import.meta.dir, 'graphql/fixture-product-demo.repository.yaml'), 'utf8');
    const names = Array.from({ length: 80 }, (_, at) => `demo.entry${String(at)}`);
    for (const [at, name] of names.entries()) {
      writeFileSync(join(kindsFolder, `${name}.yaml`), base.replace('id: demo.repository', `id: ${name}`).replace('out: [contains]', 'out: []').replace('one: Repository', `one: Entry ${String(at)}`).replace('one: Репозиторий', `one: Запись ${String(at)}`));
    }
    const env = gitEnv(SAMPLE_IDENTITY);
    execFileSync('git', ['init', '-q'], { cwd: folder, env });
    execFileSync('git', ['add', '-A'], { cwd: folder, env });
    execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: folder, env });
    const validation = validateProductManifests(folder);
    if (!validation.ok) throw new Error(validation.findings.map((one) => `${one.file}:${String(one.line)}: ${one.message}`).join('\n'));
    if (validation.value === undefined) throw new Error(`${folder}: no manifest`);
    const manifest = validation.value.manifest;
    const contract = withManifestContract(graphContractOf(manifest));
    owner = await createTestDatabaseOwner({ graphContract: contract });
    await publishValidatedManifests(owner, validation.value);
    const from = { kind: 'manifest.kind', key: { name: names[0]! } };
    const binding = await testHostBinding(owner, contract, 'fixture');
    await owner.transaction('write', async (tx) => {
      await publishGraphDrafts(tx, contract, {
        vertices: [],
        edges: names.slice(1).map((name) => ({ kind: 'mentions', from, to: { kind: 'manifest.kind', key: { name } }, discriminator: name, producer: 'fixture', producerVersion: '1' })),
        removals: [],
      }, 1, { binding, author: 'fixture@1' });
    });
    const ids = await owner.run((tx) => tx.query<{ uid: string }>("SELECT n.uid::text AS uid FROM node n JOIN entity e ON e.id = n.entity_id WHERE e.name = 'manifest.kind' AND n.key->>'name' = $1", [names[0]]));
    const id = ids.rows[0]!.uid;
    const templates = readProductTemplates(folder);
    const read = async () => await owner!.transaction('snapshot', async (tx) => {
      const context = new ReadContext(tx, manifest, publishedManifestOf(manifest), folder, 'ru', 'fixture', templates);
      const hood = await context.diagramNeighbourhood(id, 1, 'ru');
      if (hood === undefined) throw new Error(`${folder}: missing catalogue root ${id}`);
      return hood;
    });
    const warm = await read();
    expect(warm.entity.kind).toBe('catalogue');
    expect(warm.labels.get(id)).toBe('Запись 0');
    expect(warm.groups).toMatchObject([{ relation: 'mentions', kind: 'manifest.kind', total: 79 }]);
    expect(warm.nodes.size).toBe(13);
    for (const node of warm.nodes.values()) expect(warm.labels.get(node.uid)).toMatch(/^Запись \d+$/u);
    const graph = diagramGraphOf(warm, 1, 12);
    expect(graph.nodes).toHaveLength(2);
    expect(graph.folded).toBe(79);
    const expanded = await owner.transaction('snapshot', (tx) => new ReadContext(tx, manifest, publishedManifestOf(manifest), folder, 'ru', 'fixture', templates).diagramNeighbourhood(id, 1, 'ru', 100));
    expect(expanded!.groups[0]!.nodes).toHaveLength(79);
    expect(diagramGraphOf(expanded!, 1, 100).nodes).toHaveLength(80);
    const database = await owner.run((tx) => tx.query<{ name: string }>('SELECT current_database() AS name'));
    const product = { readDescriptor: async () => ({ folder, connection: { host: process.env['MADARCH_TEST_PG_SOCKET'], port: CLUSTER_PORT, user: 'postgres', database: database.rows[0]!.name } }) } as unknown as KnowledgeProduct;
    const unfolded = await renderDiagram(product, { entity: id, format: 'mermaid', lang: 'ru', aggregateAbove: 100 });
    if (!('body' in unfolded)) throw new Error(JSON.stringify(unfolded));
    expect(unfolded.body['folded']).toBe(0);
    expect((unfolded.body['source'] as string).match(/^  n\d+\[/gm)).toHaveLength(80);
    for (const format of ['mermaid', 'likec4'] as const) {
      const request = { entity: id, format, lang: 'ru' };
      const warmAnswer = await renderDiagram(product, request);
      if (!('body' in warmAnswer)) throw new Error(JSON.stringify(warmAnswer));
      const started = performance.now();
      const answer = await renderDiagram(product, request);
      const elapsed = performance.now() - started;
      if (!('body' in answer)) throw new Error(JSON.stringify(answer));
      expect(answer.status).toBe(200);
      expect(answer.body['entity']).toMatchObject({ label: 'Запись 0', kind: 'catalogue' });
      expect(answer.body['folded']).toBe(79);
      console.log(`catalogue diagram: 80 related kinds, real renderDiagram ${format} ${elapsed.toFixed(1)} ms warm`);
      expect(elapsed).toBeLessThan(200);
    }
  } finally {
    await owner?.close();
    rmSync(folder, { recursive: true, force: true });
  }
}, 120_000);
