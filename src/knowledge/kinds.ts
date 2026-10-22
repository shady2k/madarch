/**
 * The product's entity kinds (decision 0029, "Manifests and templates live in
 * the product repository"): `madarch/kinds.yaml` in the product repository
 * declares which kinds the wiki shows, where each kind's entities come from
 * (the graph, or Markdown files in the product repository) and the template
 * that shows them. The engine holds no kind of its own: nothing here names a
 * kind, a folder or a template, and a product without the file has no pages.
 *
 * ```yaml
 * kinds:
 *   domain:  { template: templates/domain.md, source: markdown, folder: docs/domains }
 *   product: { template: templates/product.md, source: markdown, file: docs/product.md }
 *   code.service:
 *     template: templates/service.md
 *     source: graph
 *     title: label                 # the attribute that names a page; `label` by default
 *     attributes: [language]       # optional: the attributes a template may name
 *     relations:                   # optional: edges the product declares between kinds
 *       - { type: code.contains, to: "code.package:services/{label}" }
 * ```
 *
 * Every problem is a finding with the file and the line; a kind with a
 * problem is left out and the others still stand, so one bad line never blanks
 * the wiki and never passes unseen.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { LineCounter, parseDocument } from 'yaml';
import { lineForPath } from '../model/yaml-position.js';

/** The manifest's place in the product repository. */
export const KINDS_FILE = 'madarch/kinds.yaml';

/** One problem in a product file the wiki reads: where it is and what it is. */
export interface Finding {
  file: string;
  line: number;
  message: string;
}

/** An edge the product declares between an entity of a kind and the entity at a key (decision 0029: the manifests hold the relations). */
export interface DeclaredRelation {
  /** The relation type the edge is shown as. */
  type: string;
  /** The key of the other end, with `{attribute}` standing for the entity's own attribute. */
  to: string;
  line: number;
}

export interface KindDecl {
  name: string;
  /** The template's path in the product repository, `/`-separated. */
  template: string;
  source: 'graph' | 'markdown';
  /** Markdown kinds: the folder (many entities) or the file (one entity) the Markdown lives in. */
  folder?: string;
  file?: string;
  /** The attribute that names a page. */
  title: string;
  attributes?: readonly string[];
  relations: readonly DeclaredRelation[];
  line: number;
}

export interface KindsManifest {
  file: string;
  kinds: ReadonlyMap<string, KindDecl>;
  findings: readonly Finding[];
}

export type KindsRead =
  | { present: false; file: string }
  | { present: true; manifest: KindsManifest };

const KIND_KEYS = new Set(['template', 'source', 'folder', 'file', 'title', 'attributes', 'relations']);

/** Whether a repository-relative path stays inside the folder: no climbing, not absolute. */
export function insideFolder(folder: string, path: string): boolean {
  if (path === '' || isAbsolute(path) || path.includes('\0')) return false;
  const from = relative(resolve(folder), resolve(folder, path));
  return from !== '' && !from.startsWith('..') && !isAbsolute(from);
}

/** Reads `madarch/kinds.yaml` of a product folder; absent when the product holds none. */
export function readKinds(productFolder: string): KindsRead {
  const file = join(productFolder, KINDS_FILE);
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return { present: false, file };
    return { present: true, manifest: { file, kinds: new Map(), findings: [{ file, line: 1, message: `the file cannot be read: ${(error as Error).message}` }] } };
  }
  return { present: true, manifest: parseKinds(text, file, productFolder) };
}

/** Parses the manifest's text; `productFolder` lets a template's existence be judged. */
export function parseKinds(text: string, file: string, productFolder: string): KindsManifest {
  const findings: Finding[] = [];
  const lines = new LineCounter();
  const doc = parseDocument(text, { lineCounter: lines, uniqueKeys: true });
  const at = (path: (string | number)[]): number => lineForPath(doc, lines, path);
  for (const problem of doc.errors) findings.push({ file, line: problem.linePos?.[0].line ?? 1, message: problem.message.split('\n')[0] ?? problem.message });
  if (doc.errors.length > 0) return { file, kinds: new Map(), findings };
  const root: unknown = doc.toJS();
  if (root === null || typeof root !== 'object' || Array.isArray(root)) {
    return { file, kinds: new Map(), findings: [{ file, line: 1, message: 'the manifest is a mapping with a "kinds" mapping in it' }] };
  }
  const top = root as Record<string, unknown>;
  for (const key of Object.keys(top)) {
    if (key !== 'kinds') findings.push({ file, line: at([key]), message: `"${key}" is not a field of the manifest: the manifest holds "kinds"` });
  }
  const declared = top['kinds'];
  if (declared === null || typeof declared !== 'object' || Array.isArray(declared)) {
    findings.push({ file, line: at(['kinds']), message: '"kinds" is a mapping of kind names to their declarations' });
    return { file, kinds: new Map(), findings };
  }
  const kinds = new Map<string, KindDecl>();
  for (const [name, value] of Object.entries(declared as Record<string, unknown>)) {
    const line = at(['kinds', name]);
    const problem = (path: (string | number)[], message: string): void => {
      // A field that is absent has no line of its own: the problem stands at the kind.
      const written = path.length === 0 || (value !== null && typeof value === 'object' && String(path[0]) in (value as object));
      findings.push({ file, line: written ? at(['kinds', name, ...path]) : line, message: `kind "${name}": ${message}` });
    };
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      findings.push({ file, line, message: `kind "${name}": the declaration is a mapping with a template and a source` });
      continue;
    }
    const decl = value as Record<string, unknown>;
    const before = findings.length;
    for (const key of Object.keys(decl)) if (!KIND_KEYS.has(key)) problem([key], `"${key}" is not a field of a kind: the fields are ${[...KIND_KEYS].join(', ')}`);
    const source = decl['source'];
    if (source !== 'graph' && source !== 'markdown') problem(['source'], `"source" is "graph" or "markdown", got ${JSON.stringify(source)}`);
    const template = decl['template'];
    if (typeof template !== 'string' || template.trim() === '') problem(['template'], '"template" names the template file in the product repository');
    else if (!insideFolder(productFolder, template)) problem(['template'], `the template "${template}" is not a path inside the product repository`);
    else if (!existsSync(join(productFolder, template)) || !statSync(join(productFolder, template)).isFile()) problem(['template'], `the template "${template}" does not exist in the product repository`);
    const folder = decl['folder'];
    const single = decl['file'];
    if (source === 'markdown') {
      if ((folder === undefined) === (single === undefined)) problem([], 'a markdown kind names exactly one of "folder" (many entities) and "file" (one entity)');
      for (const [field, path] of [['folder', folder], ['file', single]] as const) {
        if (path !== undefined && (typeof path !== 'string' || !insideFolder(productFolder, path))) problem([field], `"${field}" is a path inside the product repository`);
      }
    } else if (source === 'graph' && (folder !== undefined || single !== undefined)) {
      problem([folder !== undefined ? 'folder' : 'file'], 'a graph kind has no "folder" or "file": its entities come from the graph');
    }
    const title = decl['title'];
    if (title !== undefined && (typeof title !== 'string' || !/^[A-Za-z_][\w.-]*$/.test(title))) problem(['title'], '"title" names an attribute');
    const attributes = decl['attributes'];
    if (attributes !== undefined && (!Array.isArray(attributes) || attributes.some((entry) => typeof entry !== 'string' || !/^[A-Za-z_][\w.-]*$/.test(entry)))) problem(['attributes'], '"attributes" is a list of attribute names');
    const relations: DeclaredRelation[] = [];
    const rawRelations = decl['relations'];
    if (rawRelations !== undefined) {
      if (!Array.isArray(rawRelations)) problem(['relations'], '"relations" is a list of { type, to }');
      else {
        rawRelations.forEach((entry: unknown, index) => {
          const body = entry as Record<string, unknown> | null;
          if (body === null || typeof body !== 'object' || Array.isArray(body) || typeof body['type'] !== 'string' || typeof body['to'] !== 'string' || body['type'] === '' || body['to'] === '') {
            problem(['relations', index], 'a relation is { type: <relation type>, to: <key of the other end> }');
            return;
          }
          const extra = Object.keys(body).filter((key) => key !== 'type' && key !== 'to');
          if (extra.length > 0) problem(['relations', index, extra[0]!], `"${extra[0]}" is not a field of a relation: the fields are type and to`);
          else relations.push({ type: body['type'], to: body['to'], line: at(['kinds', name, 'relations', index])});
        });
      }
    }
    if (findings.length > before) continue;
    kinds.set(name, {
      name,
      template: template as string,
      source: source as 'graph' | 'markdown',
      ...(typeof folder === 'string' ? { folder } : {}),
      ...(typeof single === 'string' ? { file: single } : {}),
      title: typeof title === 'string' ? title : 'label',
      ...(Array.isArray(attributes) ? { attributes: attributes as string[] } : {}),
      relations,
      line,
    });
  }
  return { file, kinds, findings };
}

/** The kind whose single file is the product's home: the first kind with a `file`, in the manifest's order. */
export function homeKind(manifest: KindsManifest): KindDecl | undefined {
  for (const decl of manifest.kinds.values()) if (decl.source === 'markdown' && decl.file !== undefined) return decl;
  return undefined;
}
