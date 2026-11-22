#!/usr/bin/env bun
/**
 * Writes test/graphql/fixture.golden.graphql from test/graphql/fixture-manifest.yaml: the fixture manifest is
 * materialised in a temporary product the way the schema test reads it, and its derived SDL is written byte for byte.
 * Run it after a change to the schema generator or the fixture manifest; the golden is never hand-edited.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseKinds } from '../src/product/manifest/kinds.js';
import { publishedManifestOf } from '../src/graphql/manifest.js';
import { graphqlSchemaOf } from '../src/graphql/schema.js';

const folder = mkdtempSync(join(tmpdir(), 'madarch-graphql-fixture-'));
const source = join(import.meta.dir, '..', 'test', 'graphql', 'fixture-manifest.yaml');
const target = join(import.meta.dir, '..', 'test', 'graphql', 'fixture.golden.graphql');
try {
  mkdirSync(join(folder, 'templates'), { recursive: true });
  mkdirSync(join(folder, 'madarch'), { recursive: true });
  writeFileSync(join(folder, 'templates/entity.yaml'), 'template: entity\n');
  const declared = readFileSync(source, 'utf8');
  const file = join(folder, 'madarch/catalog.yaml');
  writeFileSync(file, declared);
  const read = parseKinds(declared, file, folder);
  if (read.findings.length > 0) {
    const first = read.findings[0]!;
    throw new Error(`${first.file}:${String(first.line)}: ${first.message}`);
  }
  writeFileSync(target, graphqlSchemaOf(publishedManifestOf(read)));
  console.error(`wrote ${target}`);
} finally {
  rmSync(folder, { recursive: true, force: true });
}
