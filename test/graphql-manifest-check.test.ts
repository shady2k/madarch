/**
 * The manifest check refuses a field that collides with a relation the Entity interface carries (decision 0036,
 * section 1): a kind that declares `mentions` while the `mentions` edge stands on every entity refuses the manifest,
 * naming both declarations.
 */
import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateProductManifests } from '../src/graph/manifest-publication.js';
import { publishedManifestOf } from '../src/graphql/manifest.js';
import { SchemaRefusal } from '../src/graphql/names.js';
import { graphqlSchemaOf } from '../src/graphql/schema.js';
import { readKinds } from '../src/product/manifest/kinds.js';
import { gitEnv } from './git-env.js';
import { SAMPLE_IDENTITY } from './knowledge-fixture.js';

/** A product whose kind declares a field the `mentions` relation carries on every entity. */
function collidingProduct(): string {
  const folder = mkdtempSync(join(tmpdir(), 'madarch-graphql-collision-'));
  mkdirSync(join(folder, 'madarch/kinds/demo/core'), { recursive: true });
  mkdirSync(join(folder, 'templates'), { recursive: true });
  writeFileSync(join(folder, 'templates/entity.yaml'), 'template: entity\n');
  const metadata = readFileSync(join(import.meta.dir, 'graphql/fixture-product-catalog.yaml'), 'utf8');
  const cut = metadata.indexOf('\nedges:');
  writeFileSync(join(folder, 'madarch/catalog.yaml'), `${cut < 0 ? metadata : metadata.slice(0, cut)}\nedges:\n  - { name: mentions, from: [any], to: [any], repeats: true, discriminator: place }\n`);
  writeFileSync(join(folder, 'madarch/kinds/demo/core/demo.page.yaml'), [
    'id: practice.page', 'purpose: structure', 'definition: A page of the demo.', 'sources: [https://example.test/standard]',
    'acquisition: [conversation]', 'status: implemented', 'relation-constraints: { out: [], in: [] }',
    'template-policy: page', ' ', 'source: graph', 'title: title',
    'labels:', '  en: { one: Page, many: Pages }', '  ru: { one: Страница, many: Страницы }',
    'description: { en: A page., ru: Страница. }',
    'fields:', '  - { name: title, type: text, producers: [person] }', '  - { name: mentions, type: text, nullable: true, producers: [person] }',
    'key: [title]', '',
  ].join('\n'));
  execFileSync('git', ['init', '-q'], { cwd: folder, env: gitEnv(SAMPLE_IDENTITY) });
  execFileSync('git', ['add', '-A'], { cwd: folder, env: gitEnv(SAMPLE_IDENTITY) });
  execFileSync('git', ['commit', '-qm', 'collision'], { cwd: folder, env: gitEnv(SAMPLE_IDENTITY) });
  return folder;
}

describe('a field that collides with an Entity relation', () => {
  test('the manifest check refuses it naming the field and the edge', () => {
    const folder = collidingProduct();
    const read = readKinds(folder);
    if (!read.present) throw new Error('the fixture product holds no manifest');
    expect(read.manifest.findings).toEqual([]);
    expect(() => graphqlSchemaOf(publishedManifestOf(read.manifest))).toThrow(SchemaRefusal);
    const validation = validateProductManifests(folder);
    expect(validation.ok).toBe(false);
    if (validation.ok) return;
    const message = validation.findings.map((finding) => finding.message).join('\n');
    expect(message).toContain('field "mentions" of the kind "demo.page"');
    expect(message).toContain('edge "mentions"');
  });
});
