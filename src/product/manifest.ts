/**
 * Reading a product's identity back from its manifest
 * (docs/changes/draft-product/capabilities/product-repository.md,
 * requirement manifest). `workspace.yaml` is how madarch and an agent
 * recognise a product repository: its `schemaVersion`, `id` and `name` are
 * never renamed, and a field this madarch does not know is ignored, so a
 * manifest written by a later madarch still opens.
 *
 * Errors are values, named the way this project names them everywhere:
 * the file's full path, the 1-based line where the reader knows it, and a
 * sentence with the field or the reason.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LineCounter, parseDocument, isMap } from 'yaml';
import { lineForPath } from '../model/yaml-position.js';
import { PRODUCT_SCHEMA_VERSION } from './draft.js';

/** The manifest's file, at a product folder's root. */
export const MANIFEST_FILE = 'workspace.yaml';

export type ProductSchemaVersion = typeof PRODUCT_SCHEMA_VERSION;

/** A product folder, read: where it is, and the fields that never change. */
export interface ProductIdentity {
  /** The full path of the product folder the manifest was read in. */
  folder: string;
  /** The identifier given at creation; kept for the product's life, whatever the folder is called. */
  id: string;
  /**
   * The product's name: the folder's name for a draft. A manifest that
   * names none falls back to the folder's name, which is the field's
   * value for every draft madarch writes.
   */
  name: string;
  /** The schema version the manifest was written in; the one this madarch knows, or it is refused. */
  schemaVersion: ProductSchemaVersion;
}

/** How reading a product folder ended; a refusal names the file and its line. */
export type ProductRead =
  | { ok: true; product: ProductIdentity }
  | { ok: false; /** The full path of the manifest the problem was found in — the file that was looked for. */ file: string; line: number; message: string };

/**
 * Reads one product folder's manifest. Refused — never defaulted, never
 * logged — when the folder holds no manifest, the manifest cannot be read,
 * names no `id`, names no `name` at all understandable as one, or was
 * written in a schema version this madarch does not know. Every other
 * field is ignored: the manifest grows by fields added beside the three.
 */
export function readProduct(productFolder: string): ProductRead {
  const manifestFile = join(productFolder, MANIFEST_FILE);

  let text: string;
  try {
    text = readFileSync(manifestFile, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { ok: false, file: manifestFile, line: 1, message: `the folder ${productFolder} holds no workspace.yaml: a product is recognised by its manifest` };
    }
    return { ok: false, file: manifestFile, line: 1, message: `the manifest ${manifestFile} could not be read: ${(error as Error).message}` };
  }

  // Parse as the model files are parsed (same parse options, same line
  // counting) so a manifest's lines are reported the way a model's are.
  const lineCounter = new LineCounter();
  // `uniqueKeys: false` turns off the parser's own duplicate-key error,
  // which has no position; the three fields are read tolerant of the rest.
  const doc = parseDocument(text, { lineCounter, keepSourceTokens: true, merge: false, uniqueKeys: false });
  const [parseError] = doc.errors;
  if (parseError !== undefined) {
    const line = lineCounter.linePos(parseError.pos[0]).line;
    return { ok: false, file: manifestFile, line, message: `the manifest ${manifestFile} cannot be read as YAML: ${parseError.message}` };
  }

  const value: unknown = doc.toJS();
  if (value === null || typeof value !== 'object' || Array.isArray(value) || !isMap(doc.contents)) {
    return { ok: false, file: manifestFile, line: 1, message: `the manifest ${manifestFile} is not a mapping of manifest fields` };
  }
  const record = value as Record<string, unknown>;

  const schemaVersion = record.schemaVersion;
  if (schemaVersion === undefined) {
    return { ok: false, file: manifestFile, line: 1, message: `the manifest ${manifestFile} names no "schemaVersion": madarch knows version ${PRODUCT_SCHEMA_VERSION}` };
  }
  if (schemaVersion !== PRODUCT_SCHEMA_VERSION) {
    const line = lineForPath(doc, lineCounter, ['schemaVersion']);
    return { ok: false, file: manifestFile, line, message: `the manifest ${manifestFile} holds ${JSON.stringify(schemaVersion)} at "schemaVersion": not a schema version this madarch knows; madarch writes ${PRODUCT_SCHEMA_VERSION}` };
  }

  const id = record.id;
  if (typeof id !== 'string' || id.trim() === '') {
    const line = id === undefined ? 1 : lineForPath(doc, lineCounter, ['id']);
    const named = id === undefined ? 'names no "id"' : `holds ${JSON.stringify(id)} at "id"`;
    return { ok: false, file: manifestFile, line, message: `the manifest ${manifestFile} ${named}: a product is identified by the id it was given at creation` };
  }

  let name: string;
  const named = record.name;
  if (named === undefined || named === '') {
    name = basename(productFolder);
  } else if (typeof named === 'string') {
    name = named;
  } else {
    const line = lineForPath(doc, lineCounter, ['name']);
    return { ok: false, file: manifestFile, line, message: `the manifest ${manifestFile} holds ${JSON.stringify(named)} at "name": not a name` };
  }

  return { ok: true, product: { folder: productFolder, id, name, schemaVersion: PRODUCT_SCHEMA_VERSION } };
}

/** The last non-empty path segment of a folder: the folder's own name, wherever a trailing slash stands. */
function basename(folder: string): string {
  return folder.split('/').filter(Boolean).at(-1) ?? folder;
}
