/** Starter catalogue relations are published once and shared by GraphQL and the diagram worker. */
import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parse, stringify } from 'yaml';
import { createDraft } from '../src/product/draft.js';
import { validateProductManifests, publishValidatedManifests } from '../src/graph/manifest-publication.js';
import { withManifestContract } from '../src/graph/manifest-contract.js';
import { graphContractOf } from '../src/fill/stages/plugin-contract.js';
import { ReadContext } from '../src/graph/graphql-read.js';
import { executeGraphql, type MessageBody } from '../src/graph/graphql-execute.js';
import { publishedManifestOf } from '../src/graphql/manifest.js';
import { readPublishedTemplates } from '../src/graph/product-templates.js';
import { diagramGraphOf } from '../src/render/diagram.js';
import { renderDiagram } from '../src/render/diagram-render.js';
import type { KnowledgeProduct } from '../src/knowledge/product.js';
import { CLUSTER_PORT } from '../src/adapters/postgres-cluster.js';
import { createTestDatabaseOwner } from './test-database.js';
import { gitEnv } from './git-env.js';
import { SAMPLE_IDENTITY } from './knowledge-fixture.js';

test('the real File catalogue page shares dependency and declared-relation edges with its diagram', async () => {
  const root = mkdtempSync(join(tmpdir(), 'madarch-kind-relations-'));
  let owner: Awaited<ReturnType<typeof createTestDatabaseOwner>> | undefined;
  try {
    const draft = createDraft({ home: root, name: 'catalogue-fixture', template: 'everything', gitEnv: gitEnv(SAMPLE_IDENTITY) });
    if (draft.outcome !== 'created') throw new Error(JSON.stringify(draft));
    const folder = draft.folder;
    const validated = () => {
      const validation = validateProductManifests(folder);
      if (!validation.ok) throw new Error(validation.findings.map(one => `${one.file}:${String(one.line)}: ${one.message}`).join('\n'));
      if (validation.value === undefined) throw new Error(`${folder}:1: no manifest`);
      return validation.value;
    };
    const starter = validated();
    expect([...starter.manifest.kinds].filter(([, kind]) => kind.derivesFrom?.includes('code.file')).map(([name]) => name).sort())
      .toEqual(['code.ci-workflow', 'code.commit', 'code.compose-service', 'code.contract', 'code.cycle', 'code.database', 'code.debt', 'code.dockerfile', 'code.entry-point', 'code.env-definition', 'code.k8s-deployment', 'code.lockfile', 'code.logger', 'code.make-target', 'code.manifest', 'code.metric', 'code.migration', 'code.package', 'code.sql-build', 'code.sql-sink', 'code.symbol', 'code.test-case', 'code.test-quarantine', 'review-finding']);
    // Two product-owned kinds extend the bundled File dependents in the backlink list.
    const basePath = join(folder, 'madarch/kinds/testing/case/code.test-quarantine.yaml');
    const base = parse(readFileSync(basePath, 'utf8'));
    for (const field of base.fields) {
      delete field.binding;
      field.producers = ['fixture'];
    }
    const cataloguePath = join(folder, 'madarch/catalog.yaml');
    const catalogue = parse(readFileSync(cataloguePath, 'utf8'));
    for (const name of ['fixture.file-audit', 'fixture.file-review']) {
      const keyEdges = base['key-edges'].map((role: { role: string; edge: string; side: 'from' | 'to' }) => {
        const parent = catalogue.edges.find((edge: { name: string }) => edge.name === role.edge);
        if (parent === undefined) throw new Error(`${cataloguePath}:1: missing fixture parent edge ${role.edge}`);
        const edgeName = `${name}-${role.role}`;
        catalogue.edges.push({ ...parent, name: edgeName, [role.side]: [name] });
        return { ...role, role: edgeName, edge: edgeName };
      });
      writeFileSync(join(folder, 'madarch/kinds/testing/case', `${name}.yaml`),
        stringify({ ...base, id: name, 'key-edges': keyEdges, labels: { en: { one: name, many: name }, ru: { one: name === 'fixture.file-audit' ? 'Проверка файла' : 'Обзор файла', many: name } } }));
    }
    writeFileSync(cataloguePath, stringify(catalogue));
    const first = validated();
    const manifest = first.manifest;
    owner = await createTestDatabaseOwner({ graphContract: withManifestContract(graphContractOf(manifest)) });
    await publishValidatedManifests(owner, first);
    const graphql = async (query: string): Promise<Record<string, any>> => {
      const answer = await executeGraphql(owner!, { manifest, folder }, { query });
      const body = answer.body as MessageBody;
      if (body.errors !== undefined) throw new Error(`${folder}: GraphQL HTTP ${String(answer.status)}: ${JSON.stringify(body.errors)}`);
      return body.data as Record<string, any>;
    };
    const query = `{ catalogueEntity(name: "code.file", lang: "ru") {
      id label name derivesFrom { edges { node { name } } } derivedBy { edges { node { name } } }
      backlinks(first: 100) { totalCount edges { node { edge relation from { id kind label ... on CatalogueEntity { name } } } } }
    } }`;
    const page = (await graphql(query))['catalogueEntity'];
    expect(page.label).toBe('Файл');
    expect(page.derivesFrom.edges.map((edge: any) => edge.node.name).sort()).toEqual(['code.directory']);
    const dependents = page.derivedBy.edges.map((edge: any) => edge.node.name).sort();
    expect(dependents).toEqual(['asset', 'code.ci-workflow', 'code.commit', 'code.compose-service', 'code.contract', 'code.cycle', 'code.database', 'code.debt', 'code.dockerfile', 'code.entry-point', 'code.env-definition', 'code.k8s-deployment', 'code.lockfile', 'code.logger', 'code.make-target', 'code.manifest', 'code.metric', 'code.migration', 'code.package', 'code.sql-build', 'code.sql-sink', 'code.symbol', 'code.test-case', 'code.test-quarantine', 'finding', 'fixture.file-audit', 'fixture.file-review', 'review-finding', 'secret-reference', 'translation-file']);
    const id = String(page.id);
    const read = async () => await owner!.transaction('snapshot', async tx => {
      // The templates are the graph's entities, read in the page's own snapshot (the owner's decision of 2026-11-15).
      const held = await readPublishedTemplates(tx, manifest);
      const context = new ReadContext(tx, manifest, publishedManifestOf(manifest), folder, 'ru', 'fixture', held.templates, held.files, new Map(held.templates.templates.map((one) => [one.name, one.body])), held.findings);
      const hood = await context.diagramNeighbourhood(id, 1, 'ru');
      if (hood === undefined) throw new Error(`${folder}:1: missing File catalogue entity ${id}`);
      return hood;
    });
    const hood = await read();
    const graph = diagramGraphOf(hood, 1, 100);
    const idsByLabel = new Map(graph.nodes.map(node => [node.label, node.id]));
    const hasEdge = (from: string, to: string, label: string) => expect(graph.edges).toContainEqual({
      from: idsByLabel.get(from)!, to: idsByLabel.get(to)!, label, both: false,
    });
    hasEdge('Файл', 'Папка', 'зависит от');
    hasEdge('Папка', 'Файл', 'содержит');
    hasEdge('Коммит', 'Файл', 'затронул');
    hasEdge('Файл', 'Файл', 'импортирует');
    hasEdge('Файл', 'Пакет', 'импортирует пакет');
    expect(graph.edges.filter(edge => edge.from === id && edge.to === id && edge.label === 'импортирует')).toHaveLength(1);
    // Every endpoint of every declared schema relation touching File appears, not only the familiar examples.
    for (const edge of manifest.edges?.values() ?? []) {
      for (const from of edge.from) for (const to of edge.to) {
        if (from === 'any' || to === 'any' || (from !== 'code.file' && to !== 'code.file')) continue;
        const source = [...hood.nodes.values()].find(node => node.catalogue?.name === from);
        const target = [...hood.nodes.values()].find(node => node.catalogue?.name === to);
        expect(source, `source kind ${from} of ${edge.name}`).toBeDefined();
        expect(target, `target kind ${to} of ${edge.name}`).toBeDefined();
        expect(hood.groups.some(group => group.relation === edge.name && group.nodes.includes(from === 'code.file' ? target!.uid : source!.uid)), edge.name).toBe(true);
      }
    }
    for (const node of graph.nodes) {
      expect(node.kind).toBe('catalogue');
      expect(node.href).toBe(`/e/catalogue/${node.id}`);
    }
    const derivationBacklinks = page.backlinks.edges.filter((edge: any) => edge.node.edge === 'manifest.depends-on');
    expect(derivationBacklinks.map((edge: any) => edge.node.from.name).sort()).toEqual(dependents);
    for (const edge of derivationBacklinks) {
      expect(edge.node.from.kind).toBe('catalogue');
      expect(edge.node.from.label).not.toBe(edge.node.from.name);
    }
    // Republishing must neither duplicate edges nor leave removed dependencies visible.
    await publishValidatedManifests(owner, first);
    expect((await graphql(query))['catalogueEntity']).toEqual(page);
    const file = join(folder, 'madarch/kinds/code/structure/code.file.yaml');
    const pluginFile = join(folder, 'plugins/agent-fill/plugin.json');
    const plugin = JSON.parse(readFileSync(pluginFile, 'utf8'));
    for (const output of plugin.produces) output.reads = [];
    writeFileSync(pluginFile, JSON.stringify(plugin));
    const original = readFileSync(file, 'utf8');
    expect(original).toContain('derives-from:');
    writeFileSync(file, original.replace(/derives-from:\n(?:- [^\n]*\n)*/u, 'derives-from: [code.repository]\n'));
    await publishValidatedManifests(owner, validated());
    expect((await graphql(query))['catalogueEntity'].derivesFrom.edges.map((edge: any) => edge.node.name)).toEqual(['code.repository']);
    writeFileSync(file, original.replace(/derives-from:\n(?:- [^\n]*\n)*/u, ''));
    await publishValidatedManifests(owner, validated());
    expect((await graphql(query))['catalogueEntity'].derivesFrom.edges).toEqual([]);
    writeFileSync(file, original);
    await publishValidatedManifests(owner, validated());
    expect((await graphql(query))['catalogueEntity']).toEqual(page);
    const database = await owner.run(tx => tx.query<{ name: string }>('SELECT current_database() AS name'));
    const product = { readDescriptor: async () => ({ folder, connection: { host: process.env['MADARCH_TEST_PG_SOCKET'], port: CLUSTER_PORT, user: 'postgres', database: database.rows[0]!.name } }) } as unknown as KnowledgeProduct;
    for (const format of ['mermaid', 'likec4'] as const) {
      const request = { entity: id, format, lang: 'ru', aggregateAbove: 100 };
      const warm = await renderDiagram(product, request);
      if (!('body' in warm)) throw new Error(JSON.stringify(warm));
      const started = performance.now();
      const answer = await renderDiagram(product, request);
      const elapsed = performance.now() - started;
      if (!('body' in answer)) throw new Error(JSON.stringify(answer));
      expect(answer.status).toBe(200);
      expect(answer.body['entity']).toMatchObject({ label: 'Файл', kind: 'catalogue' });
      if (format === 'mermaid') {
        const source = String(answer.body['source']);
        for (const node of graph.nodes) expect(source).toContain(`/e/catalogue/${node.id}`);
      } else {
        const nodeLinks = answer.body['links'] as Record<string, string>;
        const links = Object.values(nodeLinks);
        for (const node of graph.nodes) expect(links).toContain(`/e/catalogue/${node.id}`);
        const occurrences = Object.keys(nodeLinks).filter(node => nodeLinks[node] === `/e/catalogue/${id}`);
        expect(occurrences).toHaveLength(2);
        const workspace = String(answer.body['workspace']);
        for (const occurrence of occurrences) expect(workspace).toContain(`${occurrence} = catalogue "Файл"`);
        expect(workspace).toContain(`${occurrences[0]} -> ${occurrences[1]} "импортирует"`);
        const view = answer.body['view'] as { views: { index: { nodes: { id: string }[]; edges: { source: string; target: string; label: string }[] } } };
        expect(view.views.index.edges).toContainEqual(expect.objectContaining({
          source: occurrences[0]!, target: occurrences[1]!, label: 'импортирует',
        }));
        for (const occurrence of occurrences) expect(view.views.index.nodes.some(node => node.id === occurrence)).toBe(true);
      }
      console.log(`File catalogue renderDiagram ${format}: ${elapsed.toFixed(1)} ms warm`);
      expect(elapsed).toBeLessThan(200);
    }

  } finally {
    await owner?.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 180_000);
