/**
 * The published manifest of the starter catalogue (catalog/), for the golden SDL the frontend works against: the
 * starter set `madarch init --template everything` writes is materialised in a temporary folder, its manifest is
 * read the way a product's is, and the plugin contracts it declares supply the fields of the kinds they fill.
 *
 * A kind the schema refuses — its name encodes to a reserved one, or a field's name does — is left out and named
 * in `refused` with the refusal's words, so the caller writes the schema of what can be derived and says what
 * could not. An edge whose end was left out is refused instead: a schema silently missing an edge is not written.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { STARTER_FILES } from '../src/knowledge/seed.js';
import { readKinds } from '../src/product/manifest/kinds.js';
import { publishedManifestOf, type PublishedEdge, type PublishedManifest } from '../src/graphql/manifest.js';
import { isReservedTypeName, SchemaRefusal, typeNameOf } from '../src/graphql/names.js';
import { graphqlSchemaOf } from '../src/graphql/schema.js';

/** The starter schema and the kinds it could not hold, each with the refusal that left it out. */
export interface StarterSchema {
  readonly sdl: string;
  readonly refused: readonly { readonly kind: string; readonly reason: string }[];
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
  const kinds = [];
  const refused: { kind: string; reason: string }[] = [];
  for (const kind of manifest.kinds) {
    const type = typeNameOf(kind.name);
    if (isReservedTypeName(type)) {
      refused.push({ kind: kind.name, reason: `the kind "${kind.name}" encodes to the type name "${type}", which is reserved by the schema: rename it` });
      continue;
    }
    kinds.push(kind);
  }
  const held = new Set(kinds.map((kind) => kind.name));
  const edges: PublishedEdge[] = [];
  for (const edge of manifest.edges) {
    const lost = [...edge.from, ...edge.to].find((end) => end !== 'any' && !held.has(end));
    if (lost !== undefined) throw new SchemaRefusal(`the edge "${edge.name}" names the kind "${lost}", which the schema left out: the starter catalogue and the schema's names disagree about it`);
    edges.push(edge);
  }
  const sdl = graphqlSchemaOf({ kinds, edges });
  return { sdl, refused };
}
