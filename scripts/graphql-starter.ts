/**
 * The published manifest of the starter catalogue (catalog/), for the golden SDL the frontend works against: the
 * starter set `madarch init --template everything` writes is materialised in a temporary folder, its manifest is
 * read the way a product's is, and the plugin contracts it declares supply the fields of the kinds they fill.
 *
 * Every kind of the catalogue holds its place in the schema: a kind's types carry the `Kind` prefix that keeps them apart
 * from the engine's own names (src/graphql/names.ts), so no kind is left out for a name. A manifest whose kinds still
 * collide with one another is refused by the schema itself, and nothing is written.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { STARTER_FILES } from '../src/knowledge/seed.js';
import { readKinds } from '../src/product/manifest/kinds.js';
import { publishedManifestOf, type PublishedManifest } from '../src/graphql/manifest.js';
import { SchemaRefusal } from '../src/graphql/names.js';
import { graphqlSchemaOf } from '../src/graphql/schema.js';

/** The starter schema, with the kinds it holds. */
export interface StarterSchema {
  readonly sdl: string;
  readonly kinds: readonly string[];
}

/** The starter set's published manifest, materialised in a temporary product as `madarch init` writes it. */
function starterManifest(): PublishedManifest {
  const folder = mkdtempSync(join(tmpdir(), 'madarch-starter-graphql-'));
  try {
    for (const file of STARTER_FILES) {
      const target = join(folder, file.path);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, file.bytes ?? file.content);
    }
    const read = readKinds(folder);
    if (!read.present) throw new SchemaRefusal(`${join(folder, 'madarch/catalog.yaml')}:1: the starter set holds no manifest`);
    if (read.manifest.findings.length > 0) {
      const first = read.manifest.findings[0]!;
      throw new SchemaRefusal(`${first.file}:${String(first.line)}: ${first.message}`);
    }
    return publishedManifestOf(read.manifest);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

/**
 * The starter SDL, derived from the catalogue alone: every kind the schema can hold, every edge between them, and
 * the kinds a reserved name left out. The schema is derived once more over the kept kinds, so a collision the
 * kinds make together is refused rather than hidden by leaving a kind out.
 */
export function starterSchema(): StarterSchema {
  const manifest = starterManifest();
  const kinds = [...manifest.kinds];
  const held = new Set(kinds.map((kind) => kind.name));
  for (const edge of manifest.edges) {
    const lost = [...edge.from, ...edge.to].find((end) => end !== 'any' && !held.has(end));
    if (lost !== undefined) throw new SchemaRefusal(`the edge "${edge.name}" names the kind "${lost}", which the starter catalogue does not declare: the catalogue and the schema's kinds disagree about it`);
  }
  const sdl = graphqlSchemaOf({ kinds, edges: [...manifest.edges], relations: manifest.relations });
  return { sdl, kinds: kinds.map((kind) => kind.name) };
}
