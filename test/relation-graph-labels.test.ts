/** Product relation words survive publication and are read without the product files. */
import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { validateProductManifests, publishValidatedManifests, readPublishedManifest } from '../src/graph/manifest-publication.js';
import { withManifestContract } from '../src/graph/manifest-contract.js';
import { graphContractOf } from '../src/fill/stages/plugin-contract.js';
import { executeGraphql } from '../src/graph/graphql-execute.js';
import { ReadContext } from '../src/graph/graphql-read.js';
import { publishedManifestOf } from '../src/graphql/manifest.js';
import { readPublishedTemplates } from '../src/graph/product-templates.js';
import { diagramGraphOf } from '../src/render/diagram.js';
import { createTestDatabaseOwner } from './test-database.js';
import { gitEnv } from './git-env.js';
import { SAMPLE_IDENTITY } from './knowledge-fixture.js';

test('published custom relation labels answer both languages without a catalogue file', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'madarch-relation-words-'));
  let owner: Awaited<ReturnType<typeof createTestDatabaseOwner>> | undefined;
  try {
    const kindFolder = join(folder, 'madarch/kinds/demo/core');
    mkdirSync(kindFolder, { recursive: true });
    const catalog = readFileSync(join(import.meta.dir, 'graphql/fixture-product-catalog.yaml'), 'utf8')
      .replace('relations: { contains: null }', 'relations: { contains: null, sample.powers: { labels: { en: { out: powers, in: powered-by }, ru: { out: питает, in: питается-от } } } }');
    writeFileSync(join(folder, 'madarch/catalog.yaml'), catalog);
    for (const name of ['demo.repository', 'demo.file']) {
      const text = readFileSync(join(import.meta.dir, `graphql/fixture-product-${name}.yaml`), 'utf8');
      writeFileSync(join(kindFolder, `${name}.yaml`), name === 'demo.repository'
        ? text + '\nrelations: [{ type: sample.powers, to: "demo.file:example" }]\n' : text);
    }
    const env = gitEnv(SAMPLE_IDENTITY);
    execFileSync('git', ['init', '-q'], { cwd: folder, env });
    execFileSync('git', ['add', '-A'], { cwd: folder, env });
    execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: folder, env });
    const validated = validateProductManifests(folder);
    if (!validated.ok || validated.value === undefined) throw new Error(JSON.stringify(validated));
    owner = await createTestDatabaseOwner({ graphContract: withManifestContract(graphContractOf(validated.value.manifest)) });
    await publishValidatedManifests(owner, validated.value);
    rmSync(join(folder, 'madarch'), { recursive: true });
    for (const [lang, out, incoming] of [['en', 'powers', 'powered-by'], ['ru', 'питает', 'питается-от']]) {
      const answer = await executeGraphql(owner, { folder }, { query: `{ catalogueEntity(name: "demo.repository", lang: "${lang}") { outgoing { edges { node { edge label } } } } catalogueFile: catalogueEntity(name: "demo.file", lang: "${lang}") { backlinks { edges { node { edge label } } } } }` });
      expect(answer.body.errors).toBeUndefined();
      const data = answer.body.data as any;
      expect(data.catalogueEntity.outgoing.edges.map((row: any) => row.node)).toContainEqual({ edge: 'sample.powers', label: out });
      expect(data.catalogueFile.backlinks.edges.map((row: any) => row.node)).toContainEqual({ edge: 'sample.powers', label: incoming });
      await owner.transaction('snapshot', async tx => {
        const manifest = await readPublishedManifest(tx);
        if (manifest === undefined) throw new Error('missing published product');
        const held = await readPublishedTemplates(tx, manifest);
        const context = new ReadContext(tx, manifest, publishedManifestOf(manifest), folder, lang, 'fixture', held.templates, held.files, new Map(held.templates.templates.map((one) => [one.name, one.body])), held.findings);
        const rows = await tx.query<{ uid: string }>("SELECT n.uid::text AS uid FROM node n JOIN entity e ON e.id = n.entity_id WHERE e.name = 'manifest.kind' AND n.key->>'name' = 'demo.repository'");
        const hood = await context.diagramNeighbourhood(rows.rows[0]!.uid, 1, lang);
        expect(hood).toBeDefined();
        expect(diagramGraphOf(hood!, 1, 12).edges.some(edge => edge.label === out)).toBe(true);
      });
    }
  } finally {
    await owner?.close();
    rmSync(folder, { recursive: true, force: true });
  }
}, 30_000);
