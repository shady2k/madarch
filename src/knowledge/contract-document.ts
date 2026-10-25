import { posix, resolve } from 'node:path';
import { parseDocument, LineCounter } from 'yaml';
import { byCodePoint } from '../model/order.js';

export type ContractDiagnostic = { path: string; line: number; fullPath: string; code: string; detail: string };
export class ContractReadError extends Error {
  constructor(readonly diagnostic: ContractDiagnostic) { super(`${diagnostic.path}:${diagnostic.line} (${diagnostic.fullPath}): ${diagnostic.detail}`); }
}
export const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Read a complete document and bundle only repository-local references from the pinned source reader.
 * Cycles stay references. No remote resolver or browser fetch is needed by either renderer. */
export async function contractDocument(path: string, read: (path: string) => Promise<string | undefined>, fullPath: (path: string) => string): Promise<{ document: Record<string, unknown>; text: string }> {
  const docs = new Map<string, Record<string, unknown>>();
  const texts = new Map<string, string>();
  const ids = new Map<string, string>();
  let bytes = 0;
  const refuse = (file: string, code: string, detail: string, line = 1): never => { throw new ContractReadError({path: file, line, fullPath: fullPath(file), code, detail}); };
  async function load(file: string): Promise<Record<string, unknown>> {
    const held = docs.get(file);
    if (held !== undefined) return held;
    const text = await read(file);
    if (text === undefined) return refuse(file, 'missing', 'the complete definition is not readable at the pinned revision');
    bytes += Buffer.byteLength(text);
    if (docs.size >= 64 || bytes > 4 * 1024 * 1024) return refuse(file, 'limit', 'contract definitions exceed 64 files or the 4 MiB documentation budget');
    texts.set(file, text);
    const lines = new LineCounter();
    const parsed = parseDocument(text, { lineCounter: lines, uniqueKeys: true });
    if (parsed.errors.length > 0) {
      const error = parsed.errors[0]!;
      return refuse(file, 'parse', error.message, lines.linePos(error.pos[0]).line);
    }
    let value: unknown;
    try { value = parsed.toJS({maxAliasCount: 100}); } catch (error) { return refuse(file, 'parse', String(error)); }
    if (!object(value)) return refuse(file, 'shape', 'the definition must be an object');
    docs.set(file, value);
    // Register before following references, including circular references between files.
    if (file !== path && !ids.has(file)) ids.set(file, `file${ids.size}`);
    async function visit(node: unknown, at: string[]): Promise<void> {
      if (Array.isArray(node)) { for (let i = 0; i < node.length; i++) await visit(node[i], [...at, String(i)]); return; }
      if (!object(node)) return;
      for (const key of Object.keys(node).sort(byCodePoint)) {
        const child = node[key];
        if (key === '$ref' && typeof child === 'string') {
          const range = (parsed.getIn([...at, key], true) as {range?: readonly number[]} | undefined)?.range;
          const line = range === undefined ? 1 : lines.linePos(range[0]!).line;
          const hash = child.indexOf('#');
          const target = hash < 0 ? child : child.slice(0, hash);
          const fragment = hash < 0 ? '' : child.slice(hash + 1);
          if (fragment !== '' && !fragment.startsWith('/')) refuse(file, 'reference', `unsupported reference anchor ${child}`, line);
          let referred = file;
          if (target !== '') {
            if (/^[a-z][a-z0-9+.-]*:|^[/\\]|[?]/iu.test(target)) refuse(file, 'reference', `remote or absolute reference is not allowed: ${child}`, line);
            let decoded: string;
            try { decoded = decodeURIComponent(target); } catch { return refuse(file, 'reference', `invalid reference encoding: ${child}`, line); }
            referred = posix.normalize(posix.join(posix.dirname(file), decoded));
            if (referred === '..' || referred.startsWith('../') || referred.startsWith('/') || decoded.includes('\\')) refuse(file, 'reference', `reference leaves the repository: ${child}`, line);
          }
          const other = await load(referred);
          let pointed: unknown = other;
          if (fragment !== '') for (const part of fragment.slice(1).split('/')) {
            let token: string;
            try { token = decodeURIComponent(part).replace(/~1/g, '/').replace(/~0/g, '~'); } catch { return refuse(file, 'reference', `invalid pointer encoding: ${child}`, line); }
            pointed = object(pointed) || Array.isArray(pointed) ? (pointed as Record<string, unknown>)[token] : undefined;
          }
          if (pointed === undefined) refuse(file, 'reference', `unresolved reference: ${child}`, line);
          node[key] = referred === path ? `#${fragment}` : `#/x-madarch-references/${ids.get(referred)!}${fragment}`;
        } else {
          if (key === 'externalValue' && typeof child === 'string') refuse(file, 'reference', `external example would require a network fetch: ${child}`);
          if (key === 'url' && at.at(-1) === 'x-logo') refuse(file, 'reference', `external logo is not bundled: ${String(child)}`);
          if (typeof child === 'string' && (key === 'description' || key === 'summary') && /!\[[^\]]*\]\(|<img\b/iu.test(child)) refuse(file, 'reference', 'embedded description images are not bundled');
          await visit(child, [...at, key]);
        }
      }
    }
    await visit(value, []);
    return value;
  }
  const document = await load(path);
  if (ids.size > 0) {
    if ('x-madarch-references' in document) refuse(path, 'shape', 'reserved field x-madarch-references is already present');
    document['x-madarch-references'] = Object.fromEntries([...ids].map(([file, id]) => [id, docs.get(file)!]));
  }
  return {document, text: texts.get(path)!};
}

export function contractFullPath(product: string, repo: string | null, path: string): string {
  return repo === null ? resolve(product, path) : resolve(product, 'repos', repo, path);
}
