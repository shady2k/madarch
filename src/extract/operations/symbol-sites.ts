/** Small positioned source joins for the synchronous operations extractor.
 * Only declarations present in the source become shared code.symbol nodes.
 */
import type { SourceSpan } from '../records.js';
import type { Records } from './accumulate.js';
import type { TreeText } from './source.js';

export interface FunctionSite {
  readonly path: string;
  readonly name: string;
  readonly qualifiedName: string;
  readonly receiver?: string;
  readonly receiverType?: string;
  readonly start: number;
  readonly end: number;
  readonly bodyStart: number;
  readonly span: SourceSpan;
}

/** Mask comments and string contents, retaining offsets, delimiters and newlines. */
export function sourceMask(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*|'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`/g,
    (value) => value.replace(/[^\n]/g, ' '));
}

function closeBrace(mask: string, start: number): number {
  let depth = 0;
  for (let at = start; at < mask.length; at += 1) {
    if (mask[at] === '{') depth += 1;
    if (mask[at] === '}' && --depth === 0) return at + 1;
    // Only closing braces reduce depth.
    if (mask[at] !== '}') continue;
  }
  return mask.length;
}

export function sourceSpan(t: TreeText, path: string, start: number, end: number): SourceSpan {
  const text = t.text(path);
  return t.spanOfChars(path, start, end, text.slice(0, start).split('\n').length, text.slice(0, Math.max(start, end - 1)).split('\n').length);
}

export function functionsOf(t: TreeText, path: string): FunctionSite[] {
  const text = t.text(path);
  const mask = sourceMask(text);
  const found: FunctionSite[] = [];
  const classes = [...mask.matchAll(/\bclass\s+(\w+)[^{]*\{/g)].map((match) => ({ name: match[1] ?? '', start: match.index, end: closeBrace(mask, match.index + match[0].lastIndexOf('{')) }));
  const pattern = path.endsWith('.go')
    ? /\bfunc\s+(?:\(\s*(\w+)\s+\*?([\w.]+)\s*\)\s*)?(\w+)\s*\(/g
    : /\b(?:async\s+)?function\s+(\w+)\s*\(|\b(?:const|let)\s+(\w+)\s*=\s*(?:async\s*)?\([^;]*?\)\s*(?::[^=\n]+)?=>\s*\{|(?:^|\n)\s*(?:(?:public|private|protected|static|async|override)\s+)*(\w+)\s*\([^;{}]*\)\s*(?::[^\n{]+)?\s*\{/g;
  for (const match of mask.matchAll(pattern)) {
    const start = match.index;
    const open = mask.indexOf('{', start + (match[0].endsWith('{') ? match[0].length - 1 : match[0].length));
    if (open < 0 || mask.slice(start + match[0].length, open).includes(';')) continue;
    const name = path.endsWith('.go') ? match[3] ?? '' : match[1] ?? match[2] ?? match[3] ?? '';
    if (['if', 'for', 'while', 'switch', 'catch', 'constructor'].includes(name)) continue;
    const owner = path.endsWith('.go') ? match[2] : classes.find((held) => held.start < start && start < held.end)?.name;
    // A bare method form must belong to a class, never an arbitrary call block.
    if (!path.endsWith('.go') && match[3] !== undefined && owner === undefined) continue;
    const end = closeBrace(mask, open);
    if (found.some((held) => held.start <= start && end <= held.end)) continue;
    found.push({ path, name, qualifiedName: owner === undefined ? name : `${owner}.${name}`,
      ...(path.endsWith('.go') && match[1] !== undefined ? { receiver: match[1], receiverType: owner } : {}),
      start, end, bodyStart: open, span: sourceSpan(t, path, start, end) });
  }
  return found;
}

export function functionAt(t: TreeText, path: string, at: number): FunctionSite | undefined {
  return functionsOf(t, path).filter((site) => site.start <= at && at < site.end).sort((a, b) => a.end - a.start - (b.end - b.start))[0];
}

export function functionNode(records: Records, site: FunctionSite): string {
  const key = `code.symbol:${site.path}#${site.qualifiedName}`;
  records.add({ key, kind: 'code.symbol', label: site.name, properties: { name: site.name, qualifiedName: site.qualifiedName, path: site.path, symbolKind: site.receiverType === undefined && !site.qualifiedName.includes('.') ? 'function' : 'method', language: site.path.endsWith('.go') ? 'go' : 'typescript' }, span: site.span });
  records.edge('code.contains', records.file(site.path), key, {}, site.span);
  return key;
}

export function escaped(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/** Resolve only actual relative source imports, without inventing a target. */
export function relativeSource(t: TreeText, from: string, specifier: string): string | undefined {
  if (!specifier.startsWith('.')) return undefined;
  const parts = from.split('/').slice(0, -1);
  for (const part of specifier.split('/')) {
    if (part === '..') parts.pop();
    else if (part !== '.') parts.push(part);
  }
  const candidate = parts.join('/');
  return [candidate, candidate.replace(/\.js$/, '.ts'), `${candidate}.ts`, `${candidate}/index.ts`].find((path) => t.has(path));
}
