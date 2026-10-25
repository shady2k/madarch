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
    // Nested named functions are real owners, not uses of their outer factory.
    found.push({ path, name, qualifiedName: owner === undefined ? name : `${owner}.${name}`,
      ...(path.endsWith('.go') && match[1] !== undefined ? { receiver: match[1], receiverType: owner } : {}),
      start, end, bodyStart: open, span: sourceSpan(t, path, start, end) });
  }
  if (t.code !== undefined) {
    const canonical = t.code.nodes.filter((node) => node.kind === 'code.symbol' && node.span?.path === path && ['function', 'method', 'constructor'].includes(String(node.properties.symbolKind)));
    return canonical.flatMap((node) => {
      const span = node.span!;
      const start = new TextDecoder().decode(t.tree.read(path).subarray(0, span.byteStart)).length;
      const end = new TextDecoder().decode(t.tree.read(path).subarray(0, span.byteEnd)).length;
      const held = found.find((site) => site.start <= start && site.end === end);
      const qualifiedName = String(node.properties.qualifiedName);
      const open = mask.indexOf('{', start);
      return [{...(held ?? {}), path, name: String(node.properties.name), qualifiedName, start, end, bodyStart: open < 0 || open >= end ? start : open, span}];
    });
  }
  return found;
}

export function functionAt(t: TreeText, path: string, at: number): FunctionSite | undefined {
  const site = functionsOf(t, path).filter((site) => site.start <= at && at < site.end).sort((a, b) => a.end - a.start - (b.end - b.start))[0];
  if (t.code === undefined && site !== undefined) {
    const before = sourceMask(t.text(path)).slice(site.bodyStart, at);
    // Without canonical syntax facts an anonymous boundary cannot be attributed to its parent.
    if (/=>|\bfunc\s*\(|\bfunction\s*\(/.test(before)) return undefined;
  }
  return site;
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

/** Conservative lexical proof for the supported source forms. Unrelated scopes cannot shadow this site. */
export function bindingShadowed(mask: string, name: string, at: number, definition?: number): boolean {
  const stack: number[] = [];
  const scopes: {start: number; end: number}[] = [{start: 0, end: mask.length}];
  for (let index = 0; index < mask.length; index++) {
    if (mask[index] === '{') stack.push(index);
    else if (mask[index] === '}') {const start = stack.pop(); if (start !== undefined) scopes.push({start, end: index + 1});}
  }
  const scopeOf = (position: number) => scopes.filter((scope) => scope.start <= position && position < scope.end).sort((a, b) => (a.end - a.start) - (b.end - b.start))[0]!;
  const isEnclosing = (position: number): boolean => {const scope = scopeOf(position); return scope.start <= at && at < scope.end;};
  const declarations = new RegExp(`\\b(?:const|let|var|class|function)\\s+${escaped(name)}\\b`, 'g');
  for (const match of mask.matchAll(declarations)) {
    const nameAt = match.index + match[0].lastIndexOf(name);
    if (definition !== undefined && match.index <= definition && definition < nameAt + name.length) continue;
    if (isEnclosing(match.index)) return true;
  }
  // Function-typed parameters can themselves contain parentheses.
  for (const match of mask.matchAll(/\(/g)) {
    const end = closeDelimiter(mask, match.index); if (end === undefined) continue;
    const tail = mask.slice(end); const next = /^\s*(?::[^;{]+)?(?:=>\s*)?\{/.exec(tail);
    if (next === null) continue;
    const body = end + next[0].lastIndexOf('{');
    const scope = scopes.find((candidate) => candidate.start === body);
    if (scope === undefined || at < body || at >= scope.end) continue;
    const parameters = mask.slice(match.index + 1, end - 1);
    const expression = new RegExp(`(?:^|,)\\s*(?:(?:public|private|protected|readonly)\\s+)*${escaped(name)}(?:\\s*[:=,)]|\\s+[*\\w\\[\\]]+|\\s*$)`);
    if (expression.test(parameters)) return true;
    // Only the binding side of an object/array parameter introduces names. A
    // property's key is not its renamed binding, and type members are not bindings.
    for (const parameter of parameters.split(/,(?![^{}\[\]]*[}\]])/)) {
      const trimmed = parameter.trim();
      if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) continue;
      const opening = trimmed[0]!;
      const stop = closeDelimiter(trimmed, 0, opening, opening === '{' ? '}' : ']');
      if (stop === undefined) return true;
      const pattern = trimmed.slice(1, stop - 1);
      for (const part of pattern.split(',')) {
        const binding = part.trim().replace(/^\.\.\./, '');
        if (binding === '') continue;
        const pair = /^(?:[\w$]+\s*:\s*)?([\w$]+)(?:\s*=.*)?$/.exec(binding);
        if (pair === null) return true; // Unsupported nested pattern proves no import identity.
        if (pair[1] === name) return true;
      }
    }
  }
  // Go short declarations are bindings too. Keep ordinary assignment distinct.
  for (const match of mask.matchAll(new RegExp(`\\b${escaped(name)}\\s*:=`, 'g'))) if (match.index !== definition && isEnclosing(match.index)) return true;
  return false;
}


/** A delimiter range measured in the same masked source, never a later statement. */
export function closeDelimiter(mask: string, start: number, open = '(', close = ')'): number | undefined {
  if (mask[start] !== open) return undefined;
  let depth = 0;
  for (let at = start; at < mask.length; at++) {
    if (mask[at] === open) depth++;
    else if (mask[at] === close && --depth === 0) return at + 1;
  }
  return undefined;
}

/** Resolve supported HTTP receiver bindings at their use, not by method spelling. */
export function httpReceiver(t: TreeText, path: string, receiver: string, at: number): boolean {
  const text = t.text(path); const mask = sourceMask(text);
  if (!/^[A-Za-z_$][\w$]*$/.test(receiver)) return false;
  if (path.endsWith('.go')) {
    const alias = goImportAlias(text, 'net/http');
    if (alias === undefined) return false;
    if (receiver === alias) return !bindingShadowed(mask, alias, at);
    for (const declaration of mask.matchAll(new RegExp(`\\b${escaped(receiver)}\\s*:=\\s*${escaped(alias)}\\.NewServeMux\\s*\\(`, 'g'))) {
      if (declaration.index < at && !bindingShadowed(mask, receiver, at, declaration.index) && !bindingShadowed(mask, alias, declaration.index)) return true;
    }
    return false;
  }
  const factories = new Set<string>();
  for (const imported of text.matchAll(/import\s+(?:(?:\*\s+as\s+)?(\w+)|\{([^}]+)\})\s+from\s*['"]express['"]/g)) {
    if (mask.slice(imported.index, imported.index + 6) !== 'import') continue;
    if (imported[1] !== undefined) {factories.add(imported[1]); factories.add(`${imported[1]}.Router`);}
    for (const entry of (imported[2] ?? '').split(',')) {
      const named = /^\s*Router(?:\s+as\s+(\w+))?\s*$/.exec(entry);
      if (named !== null) factories.add(named[1] ?? 'Router');
    }
  }
  for (const declaration of mask.matchAll(new RegExp(`\\b(?:const|let)\\s+${escaped(receiver)}\\s*=\\s*([\\w.]+)\\s*\\(`, 'g'))) {
    const factory = declaration[1] ?? '';
    if (declaration.index >= at || !factories.has(factory) || bindingShadowed(mask, receiver, at, declaration.index)) continue;
    if (!bindingShadowed(mask, factory.split('.')[0]!, declaration.index)) return true;
  }
  return false;
}

/** Comments masked without changing literal values or source offsets. */
export function withoutComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*|'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`/g,
    (token) => token.startsWith('//') || token.startsWith('/*') ? token.replace(/[^\n]/g, ' ') : token);
}

/** A Go import clause, not a comment/string mentioning an import path. */
export function goImportAlias(text: string, module: string): string | undefined {
  const mask = sourceMask(text);
  const clean = withoutComments(text);
  for (const declaration of clean.matchAll(/\bimport\s+(?:\([\s\S]*?\)|(?:\w+\s+)?"[^"\n]+")/g)) {
    if (mask.slice(declaration.index, declaration.index + 6) !== 'import') continue;
    for (const spec of declaration[0].slice(6).matchAll(/(?:(\w+)\s+)?"([^"\n]+)"/g)) {
      if (spec[2] !== module) continue;
      const before = declaration[0].slice(0, spec.index);
      if (/\/\/[^\n]*$/.test(before)) continue;
      return spec[1] ?? module.slice(module.lastIndexOf('/') + 1);
    }
  }
  return undefined;
}
