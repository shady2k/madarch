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
import { join, resolve } from 'node:path';
import { LineCounter, parseDocument, isAlias, isMap, isPair, isSeq } from 'yaml';
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
  const folder = resolve(productFolder);
  const manifestFile = join(folder, MANIFEST_FILE);

  let text: string;
  try {
    text = readFileSync(manifestFile, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { ok: false, file: manifestFile, line: 1, message: `the folder ${folder} holds no workspace.yaml: a product is recognised by its manifest` };
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

  // Some documents parse without an error but cannot be converted — an
  // alias whose anchor never appeared, as one. `toJS` throws; the refusal
  // names the line of the alias that failed: the one whose source the
  // reason names, or the first unresolved one — never an earlier alias
  // that reads fine.
  let value: unknown;
  try {
    value = doc.toJS();
  } catch (error) {
    const reason = (error as Error).message;
    // The ordered walk answers only when the caught failure is itself an
    // unresolved alias: yaml's own message names it — "Unresolved alias
    // (the anchor must be set before the alias): <name>" — and that text
    // decides it. Every other conversion failure — the alias limit
    // ("Excessive alias count indicates a resource exhaustion attack"),
    // anything else — ended conversion at a place no alias stands on; the
    // walk would blame an alias conversion never reached, so those report
    // line 1, honestly unknown.
    const line = reason.includes('Unresolved alias') ? aliasLine(doc, lineCounter) : undefined;
    return {
      ok: false,
      file: manifestFile,
      line: line ?? 1,
      message: `the manifest ${manifestFile} cannot be read as YAML: ${reason}`,
    };
  }

  // An alias standing in a mapping key's place is refused before the
  // duplicate walk: resolved, it can name a field a second time —
  // `extra: &key id` then `*key : replacement` overwrites `id` — and the
  // reader would open the product under the wrong identity.
  const aliasKey = firstAliasKey(doc, lineCounter);
  if (aliasKey !== undefined) {
    return {
      ok: false,
      file: manifestFile,
      line: aliasKey.line,
      message: `the manifest ${manifestFile} stands the alias "${aliasKey.alias}" in a mapping key's place on line ${aliasKey.line}: a field is named by its own word, never by an alias`,
    };
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value) || !isMap(doc.contents)) {
    return { ok: false, file: manifestFile, line: 1, message: `the manifest ${manifestFile} is not a mapping of manifest fields` };
  }
  // The parser's own duplicate check has no position, so the document's
  // own items are looked at directly: with `uniqueKeys: false` a field
  // named twice stands in the map twice, and the later pairing is set
  // aside.
  const duplicate = firstDuplicate(doc, lineCounter);
  if (duplicate !== undefined) {
    return {
      ok: false,
      file: manifestFile,
      line: duplicate.line,
      message: `the manifest ${manifestFile} names "${duplicate.key}" twice, again on line ${duplicate.line}: each field is given once`,
    };
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
    name = basename(folder);
  } else if (typeof named === 'string') {
    name = named;
  } else {
    const line = lineForPath(doc, lineCounter, ['name']);
    return { ok: false, file: manifestFile, line, message: `the manifest ${manifestFile} holds ${JSON.stringify(named)} at "name": not a name` };
  }

  return { ok: true, product: { folder, id, name, schemaVersion: PRODUCT_SCHEMA_VERSION } };
}

/**
 * The line of the alias the conversion fails on, resolved in document
 * order: walking the document as a reader reads it, an anchor counts
 * from where it was defined, and the first alias whose anchor was not
 * defined before it — a forward reference or a name that never appears —
 * is the one the reader hits and the one to name. The reader consults
 * it only when the caught conversion failure is itself an unresolved
 * alias (see the `toJS` catch); any other failure — an alias limit
 * reached, anything else — names no alias and blames no line.
 */
function aliasLine(doc: { contents: unknown }, lineCounter: LineCounter): number | undefined {
  if (!isMap(doc.contents)) return undefined;
  const defined = new Set<string>();
  let firstUnresolved: number | undefined;
  walkDocuments(doc.contents, (node) => {
    if (firstUnresolved !== undefined) return; // The blame is settled; later nodes change nothing.
    if (isAlias(node)) {
      const isUnresolved = !defined.has(String(node.source));
      if (isUnresolved && node.range) firstUnresolved = lineCounter.linePos(node.range[0]).line;
    } else if (node && typeof node === 'object' && (node as { anchor?: unknown }).anchor !== undefined) {
      defined.add(String((node as { anchor: unknown }).anchor));
    }
  });
  return firstUnresolved;
}

/** Walks a document's nodes — mappings, sequences, pairs and aliases alike — and calls the visitor on each one. */
function walkDocuments(node: unknown, visit: (node: unknown) => void): void {
  if (node === null || typeof node !== 'object') return;
  visit(node);
  if (isMap(node) || isSeq(node)) {
    for (const item of node.items) walkDocuments(item, visit);
  } else if (isPair(node)) {
    walkDocuments(node.key, visit);
    walkDocuments(node.value, visit);
  }
}

/**
 * The first mapping key that stands as an alias. With the alias resolved
 * its key is an ordinary field name, so the pairing can duplicate one the
 * document already named, and the duplicate walk — reading string keys
 * only — would never see it.
 */
function firstAliasKey(doc: { contents: unknown }, lineCounter: LineCounter): { alias: string; line: number } | undefined {
  if (!isMap(doc.contents)) return undefined;
  for (const pair of doc.contents.items) {
    const keyNode = pair.key;
    if (isAlias(keyNode)) {
      const line = keyNode.range ? lineCounter.linePos(keyNode.range[0]).line : lineForPath(doc, lineCounter, [String(keyNode.source)]);
      return { alias: keyNode.source, line };
    }
  }
  return undefined;
}

/**
 * The first field the document's mapping names a second time, with the
 * line the second one stands on — the parser's own duplicate check has
 * no position, so the position is read from the pair's key node itself.
 */
function firstDuplicate(doc: { contents: unknown }, lineCounter: LineCounter): { key: string; line: number } | undefined {
  if (!isMap(doc.contents)) return undefined;
  const seen = new Set<string>();
  for (const pair of doc.contents.items) {
    const keyNode = pair.key as { value?: unknown; range?: number[] } | null;
    if (typeof keyNode?.value !== 'string') continue;
    if (seen.has(keyNode.value)) {
      const line = keyNode.range !== undefined ? lineCounter.linePos(keyNode.range[0]!).line : lineForPath(doc, lineCounter, [keyNode.value]);
      return { key: keyNode.value, line };
    }
    seen.add(keyNode.value);
  }
  return undefined;
}

/** The last non-empty path segment of a folder: the folder's own name, wherever a trailing slash stands. */
function basename(folder: string): string {
  return folder.split('/').filter(Boolean).at(-1) ?? folder;
}
