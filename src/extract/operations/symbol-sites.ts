/** Small positioned source joins for the synchronous operations extractor.
 * Only declarations present in the source become shared code.symbol nodes.
 */
import type { SourceSpan } from '../records.js';
import type { Records } from './accumulate.js';
import type { TreeText } from './source.js';

export interface FunctionSite {
  readonly key: string;
  readonly symbolKind: string;
  readonly language: string;
  readonly bodySyntaxKind: string;
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

export function sourceSpan(t: TreeText, path: string, start: number, end: number): SourceSpan {
  const text = t.text(path);
  return t.spanOfChars(path, start, end, text.slice(0, start).split('\n').length, text.slice(0, Math.max(start, end - 1)).split('\n').length);
}

/** Canonical callables copied by the shared code pass. No text recognition fallback. */
export function functionsOf(t: TreeText, path: string): FunctionSite[] {
  if (t.facts === undefined) { t.factGap(path, 'line 1: callable sites require shared resolved code facts'); return []; }
  const file = t.facts.files.find((entry) => entry.path === path);
  if (file?.parsed !== true) { t.factGap(path, 'line 1: callable sites require a successfully parsed file'); return []; }
  const bytes = t.tree.read(path);
  const decoder = new TextDecoder('utf-8', {fatal:true});
  const charAt = (byte: number): number | undefined => {
    if (!Number.isInteger(byte) || byte < 0 || byte > bytes.length) return undefined;
    try { return decoder.decode(bytes.subarray(0, byte)).length; } catch { return undefined; }
  };
  const found: FunctionSite[] = [];
  const facts = t.facts;
  const sameSpan = (left: SourceSpan, right: SourceSpan): boolean => left.path === path && right.path === path &&
    left.byteStart === right.byteStart && left.byteEnd === right.byteEnd && left.lineStart === right.lineStart && left.lineEnd === right.lineEnd;
  const expressions = facts.expressions.filter((entry) => entry.path === path && entry.span.path === path);
  const declarationOnlyInterfaceMethod = (symbol: (typeof facts.symbols)[number]): boolean => {
    if (symbol.symbolKind !== 'method' || symbol.bodySpan !== undefined || symbol.bodySyntaxKind !== undefined) return false;
    const kinds = file.language === 'go' ? ['method_spec'] : ['method_signature'];
    const methods = expressions.filter((entry) => kinds.includes(entry.syntaxKind) && sameSpan(entry.span, symbol.span));
    if (methods.length !== 1) return false;
    const method = methods[0]!;
    if ((method.fields.body ?? []).length !== 0) return false;
    const names = method.fields.name ?? [];
    const name = names.length === 1 ? expressions.find((entry) => entry.id === names[0]) : undefined;
    if (name?.name !== symbol.name || method.children.filter((id) => id === name.id).length !== 1) return false;
    const containers = expressions.filter((entry) => entry.syntaxKind === (file.language === 'go' ? 'interface_type' : 'interface_body') &&
      entry.children.filter((id) => id === method.id).length === 1 && entry.span.byteStart <= method.span.byteStart && method.span.byteEnd <= entry.span.byteEnd);
    if (containers.length !== 1) return false;
    const container = containers[0]!;
    const owners = expressions.filter((entry) => entry.syntaxKind === (file.language === 'go' ? 'type_spec' : 'interface_declaration') &&
      (entry.fields[file.language === 'go' ? 'type' : 'body'] ?? []).length === 1 &&
      entry.fields[file.language === 'go' ? 'type' : 'body']![0] === container.id && entry.children.filter((id) => id === container.id).length === 1);
    if (owners.length !== 1) return false;
    const owner = owners[0]!;
    return facts.symbols.filter((entry) => entry.path === path && entry.symbolKind === 'interface' && sameSpan(entry.span, owner.span) &&
      symbol.qualifiedName === `${entry.qualifiedName}.${symbol.name}`).length === 1;
  };
  const symbols = facts.symbols.filter((entry) => entry.path === path && entry.callable);
  const counts = new Map<string, number>();
  for (const symbol of symbols) counts.set(symbol.key, (counts.get(symbol.key) ?? 0) + 1);
  for (const symbol of symbols) {
    if (counts.get(symbol.key) !== 1) { t.factGap(path, `line ${symbol.span.lineStart}: duplicate callable identity ${symbol.key}`); continue; }
    const body = symbol.bodySpan;
    if (body === undefined || symbol.bodySyntaxKind === undefined) {
      // An exact copied interface signature declares no executable body. A
      // missing body on any actual callable remains a diagnostic tombstone.
      if (declarationOnlyInterfaceMethod(symbol)) continue;
      t.factGap(path, `line ${symbol.span.lineStart}: callable ${symbol.key} has no proved body at bytes ${symbol.span.byteStart}-${symbol.span.byteEnd}`);
      continue;
    }
    const valid = symbol.span.path === path && body.path === path && symbol.span.byteStart <= body.byteStart && body.byteStart <= body.byteEnd && body.byteEnd <= symbol.span.byteEnd;
    const start = charAt(symbol.span.byteStart); const end = charAt(symbol.span.byteEnd); const bodyStart = charAt(body.byteStart);
    if (!valid || start === undefined || end === undefined || bodyStart === undefined || charAt(body.byteEnd) === undefined) {
      t.factGap(path, `line ${symbol.span.lineStart}: callable ${symbol.key} has invalid UTF-8/span boundaries at bytes ${symbol.span.byteStart}-${symbol.span.byteEnd}`);
      continue;
    }
    const receiver = symbol.receiver;
    const receiverBindings = receiver === undefined ? [] : t.facts.bindings.filter((binding) => binding.id === receiver.bindingId);
    const receiverBinding = receiverBindings.length === 1 ? receiverBindings[0] : undefined;
    const receiverValid = receiverBinding !== undefined && receiverBinding.path === path && receiverBinding.name === receiver?.name &&
      receiverBinding.scope.path === path && receiverBinding.scope.byteStart <= symbol.span.byteStart && symbol.span.byteEnd <= receiverBinding.scope.byteEnd &&
      symbol.span.byteStart <= receiverBinding.span.byteStart && receiverBinding.span.byteEnd <= body.byteStart;
    if (receiver !== undefined && !receiverValid) {
      t.factGap(path, `line ${symbol.span.lineStart}: callable ${symbol.key} has no proved receiver binding`);
      continue;
    }
    found.push({ key: symbol.key, path, name: symbol.name, qualifiedName: symbol.qualifiedName, symbolKind: symbol.symbolKind, language: file.language,
      start, end, bodyStart, bodySyntaxKind: symbol.bodySyntaxKind, span: symbol.span,
      ...(receiver === undefined ? {} : {receiver: receiver.name, ...(receiver.typeName === undefined ? {} : {receiverType: receiver.typeName})}) });
  }
  return found;
}

export function functionAt(t: TreeText, path: string, at: number): FunctionSite | undefined {
  const sites = functionsOf(t, path);
  const text = t.text(path);
  if (!Number.isInteger(at) || at < 0 || at >= text.length || at > 0 && text.charCodeAt(at) >= 0xdc00 && text.charCodeAt(at) <= 0xdfff && text.charCodeAt(at - 1) >= 0xd800 && text.charCodeAt(at - 1) <= 0xdbff) {
    t.factGap(path, `line 1: callable holder needs an exact source character boundary at ${at}`); return undefined;
  }
  const byte = new TextEncoder().encode(text.slice(0, at)).length;
  // Raw canonical boundaries remain tombstones when a callable's metadata is
  // missing or ambiguous. Omitting an inner proof must never lend its body to
  // a valid outer callable.
  const owners = (t.facts?.symbols ?? []).filter((symbol) => symbol.path === path && symbol.callable && symbol.span.byteStart <= byte && byte < symbol.span.byteEnd)
    .sort((left, right) => left.span.byteEnd - left.span.byteStart - (right.span.byteEnd - right.span.byteStart));
  const owner = owners[0];
  if (owner === undefined) return undefined;
  if (owners.length > 1 && owner.span.byteStart === owners[1]!.span.byteStart && owner.span.byteEnd === owners[1]!.span.byteEnd) {
    t.factGap(path, `line ${owner.span.lineStart}: callable holder is ambiguous at character ${at}`); return undefined;
  }
  const candidates = sites.filter((site) => site.key === owner.key && site.span.byteStart === owner.span.byteStart && site.span.byteEnd === owner.span.byteEnd);
  const site = candidates.length === 1 ? candidates[0] : undefined;
  if (site === undefined || owner.bodySpan === undefined || byte < owner.bodySpan.byteStart || byte >= owner.bodySpan.byteEnd) {
    t.factGap(path, `line ${owner.span.lineStart}: innermost callable ${owner.key} has no valid body ownership at character ${at}`); return undefined;
  }
  return site;
}

export function functionNode(records: Records, site: FunctionSite): string {
  records.add({ key: site.key, kind: 'code.symbol', label: site.name,
    properties: {name: site.name, qualifiedName: site.qualifiedName, path: site.path, symbolKind: site.symbolKind, language: site.language}, span: site.span });
  records.edge('code.contains', records.file(site.path), site.key, {}, site.span);
  return site.key;
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

/** Binding side only. Unsupported nested/computed patterns withhold identity. */
function patternShadows(pattern: string, name: string): boolean {
  for (const part of pattern.split(',')) {
    const binding = part.trim().replace(/^\.\.\./, '');
    if (binding === '') continue;
    const pair = /^(?:[\w$]+\s*:\s*)?([\w$]+)(?:\s*=.*)?$/.exec(binding);
    if (pair === null || pair[1] === name) return true;
  }
  return false;
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
  // Local destructuring binds in the declaration's lexical scope, not the
  // object's braces. Parse only binding positions; renamed property keys do not bind.
  for (const declaration of mask.matchAll(/\b(?:const|let|var)\s+([\{\[])/g)) {
    if (!isEnclosing(declaration.index)) continue;
    const start = declaration.index + declaration[0].length - 1;
    const opening = mask[start]!;
    const end = closeDelimiter(mask, start, opening, opening === '{' ? '}' : ']');
    if (end === undefined || patternShadows(mask.slice(start + 1, end - 1), name)) return true;
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
      if (patternShadows(trimmed.slice(1, stop - 1), name)) return true;
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
  for (const imported of text.matchAll(/import\s+(?:(?:\*\s+as\s+)?(\w+)(?:\s*,\s*\{([^}]*)\})?|\{([^}]+)\})\s+from\s*['"]express['"]/g)) {
    if (mask.slice(imported.index, imported.index + 6) !== 'import') continue;
    if (imported[1] !== undefined) {factories.add(imported[1]); factories.add(`${imported[1]}.Router`);}
    for (const entry of (imported[2] ?? imported[3] ?? '').split(',')) {
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

/** Ports proved for this registration's receiver, never the service-wide union.
 * Unsupported aliases/mounts return no ports; callers retain a located gap.
 */
export function receiverListenerPorts(t: TreeText, path: string, receiver: string, at: number, seen = new Set<string>()): string[] {
  const identity = `${path}:${receiver}:${at}`;
  if (seen.has(identity) || seen.size >= 20) return [];
  seen.add(identity);
  const text = t.text(path); const mask = sourceMask(text);
  if (!httpReceiver(t, path, receiver, at)) return [];
  const definitions = [...mask.matchAll(new RegExp(path.endsWith('.go') ? `\\b${escaped(receiver)}\\s*:=` : `\\b(?:const|let|var)\\s+${escaped(receiver)}\\s*=`, 'g'))]
    .filter((declaration) => declaration.index < at && !bindingShadowed(mask, receiver, at, declaration.index));
  const definition = definitions.at(-1)?.index;
  const sameBinding = (position: number): boolean => !bindingShadowed(mask, receiver, position, definition);
  const ports = new Set<string>();
  const visibleDefinition = (sourceMasked: string, definition: number, position: number): boolean => {
    if (definition >= position) return false;
    const enclosing: number[] = [];
    for (let index = 0; index < definition; index++) {
      if (sourceMasked[index] === '{') enclosing.push(index);
      else if (sourceMasked[index] === '}') enclosing.pop();
    }
    const open = enclosing.at(-1);
    return open === undefined || position < (closeDelimiter(sourceMasked, open, '{', '}') ?? open);
  };
  // Only a literal or a visible numeric const proves a static listener port.
  const tsPort = (source: string, value: string, position: number): string | undefined => {
    if (/^\d+$/.test(value)) return value === '0' ? undefined : value;
    const sourceMasked = sourceMask(source);
    const declarations = [...sourceMasked.matchAll(new RegExp(`\\bconst\\s+${escaped(value)}\\s*=\\s*(\\d+)\\s*(?=;|\\n|$)`, 'g'))]
      .filter((entry) => visibleDefinition(sourceMasked, entry.index, position) && !bindingShadowed(sourceMasked, value, position, entry.index));
    return declarations.length === 1 && declarations[0]![1] !== '0' ? declarations[0]![1] : undefined;
  };
  if (!path.endsWith('.go')) {
    for (const listener of mask.matchAll(new RegExp(`\\b${escaped(receiver)}\\.listen\\(\\s*(\\d+|[A-Za-z_$][\\w$]*)\\s*(?=[,)])`, 'g'))) {
      const port = tsPort(text, listener[1]!, listener.index);
      if (port !== undefined && sameBinding(listener.index) && httpReceiver(t, path, receiver, listener.index)) ports.add(port);
    }
  }
  const owner = functionAt(t, path, at);
  const returned = owner !== undefined && (new RegExp(`\\breturn\\s+${escaped(receiver)}\\b`).test(mask.slice(owner.bodyStart, owner.end)) || new RegExp(`\\breturn\\s+Chain\\s*\\([^;]*\\)\\s*\\(\\s*${escaped(receiver)}\\s*\\)`).test(mask.slice(owner.bodyStart, owner.end)));
  const factory = returned ? owner.name : undefined;
  const service = /^services\/([^/]+)\//.exec(path)?.[1];
  for (const other of t.tree.paths.filter((file) => /^services\/([^/]+)\//.exec(file)?.[1] === service && file.endsWith(path.endsWith('.go') ? '.go' : '.ts'))) {
    const source = t.text(other); const otherMask = sourceMask(source);
    const factoryCalls = new Set<string>();
    const methodReceivers: {name: string; definition: number}[] = [];
    if (factory !== undefined) {
      if (other === path && owner?.receiverType === undefined) factoryCalls.add(factory);
      if (path.endsWith('.ts')) {
        for (const imported of source.matchAll(/import\s*\{([^}]+)\}\s*from\s*['"]([^'"]+)['"]/g)) {
          if (relativeSource(t, other, imported[2] ?? '') !== path || otherMask.slice(imported.index, imported.index + 6) !== 'import') continue;
          for (const entry of imported[1]!.split(',')) {
            const named = /^\s*(\w+)(?:\s+as\s+(\w+))?\s*$/.exec(entry);
            if (named?.[1] === factory) factoryCalls.add(named[2] ?? factory);
          }
        }
      } else {
        const modPath = `services/${service}/go.mod`;
        const module = t.has(modPath) ? /^module\s+(\S+)/m.exec(t.text(modPath))?.[1] : undefined;
        const folder = path.slice(0, path.lastIndexOf('/'));
        const relative = folder.slice(`services/${service}`.length);
        const alias = module === undefined ? undefined : goImportAlias(source, `${module}${relative}`);
        if (alias !== undefined && owner?.receiverType === undefined) factoryCalls.add(`${alias}.${factory}`);
        // A returned mux on a method belongs only to instances made by a
        // constructor whose declared result and returned literal prove its type.
        if (alias !== undefined && owner?.receiverType !== undefined) {
          for (const constructor of functionsOf(t, path).filter((site) => site.receiverType === undefined)) {
            const signature = mask.slice(constructor.start, constructor.bodyStart);
            const parameters = signature.indexOf('(');
            const end = closeDelimiter(signature, parameters);
            if (end === undefined || !new RegExp(`^\\s*\\*?${escaped(owner.receiverType)}\\s*$`).test(signature.slice(end))) continue;
            if (!new RegExp(`\\breturn\\s+&?${escaped(owner.receiverType)}\\s*\\{`).test(mask.slice(constructor.bodyStart, constructor.end))) continue;
            const called = `${alias}.${constructor.name}`;
            for (const local of otherMask.matchAll(new RegExp(`\\b(\\w+)\\s*:=\\s*${escaped(called)}\\s*\\(`, 'g'))) {
              if (bindingShadowed(otherMask, alias, local.index)) continue;
              methodReceivers.push({name: local[1]!, definition: local.index});
            }
          }
        }
      }
    }
    const handlesReceiver = (expression: string, position: number): boolean => {
      const value = expression.trim();
      if (other === path && value === receiver && sameBinding(position)) return true;
      for (const local of methodReceivers) {
        if (factory !== undefined && visibleDefinition(otherMask, local.definition, position) && new RegExp(`^${escaped(local.name)}\\.${escaped(factory)}\\s*\\(\\s*\\)$`).test(value)
          && !bindingShadowed(otherMask, local.name, position, local.definition)) return true;
      }
      for (const called of factoryCalls) {
        if (new RegExp(`^${escaped(called)}\\s*\\(`).test(value) && !bindingShadowed(otherMask, called.split('.')[0]!, position)) return true;
        for (const local of otherMask.matchAll(new RegExp(`\\b(\\w+)\\s*(?::=|=)\\s*${escaped(called)}\\s*\\(`, 'g'))) {
          if (value === local[1] && !bindingShadowed(otherMask, value, position, local.index) && !bindingShadowed(otherMask, called.split('.')[0]!, local.index)) return true;
        }
      }
      return false;
    };
    if (!path.endsWith('.go')) {
      if (factory === undefined) continue;
      for (const called of factoryCalls) {
        const visibleFactory = (position: number): boolean => !bindingShadowed(otherMask, called, position, other === path ? owner?.start : undefined);
        for (const call of otherMask.matchAll(new RegExp(`\\b${escaped(called)}\\s*\\(`, 'g'))) {
          if (!visibleFactory(call.index)) continue;
          const open = call.index + call[0].lastIndexOf('('); const end = closeDelimiter(otherMask, open);
          if (end === undefined) continue;
          const chained = /^\s*\.listen\(\s*(\d+|[A-Za-z_$][\w$]*)\s*(?=[,)])/.exec(otherMask.slice(end));
          if (chained !== null) {
            const port = tsPort(source, chained[1]!, end);
            if (port !== undefined) ports.add(port);
          }
          for (const local of otherMask.matchAll(new RegExp(`\\b(?:const|let)\\s+(\\w+)\\s*=\\s*${escaped(called)}\\s*\\(`, 'g'))) {
            if (local.index + local[0].lastIndexOf(called) !== call.index) continue;
            for (const listener of otherMask.matchAll(new RegExp(`\\b${escaped(local[1]!)}\\.listen\\(\\s*(\\d+|[A-Za-z_$][\\w$]*)\\s*(?=[,)])`, 'g'))) {
              if (listener.index <= end || !visibleDefinition(otherMask, local.index, listener.index) || bindingShadowed(otherMask, local[1]!, listener.index, local.index)) continue;
              const port = tsPort(source, listener[1]!, listener.index);
              if (port !== undefined) ports.add(port);
            }
          }
        }
      }
      for (const mount of source.matchAll(/\b(\w+)\.use\s*\(/g)) {
        if (!httpReceiver(t, other, mount[1]!, mount.index)) continue;
        const open = mount.index + mount[0].lastIndexOf('('); const end = closeDelimiter(otherMask, open);
        if (end === undefined) continue;
        const args = source.slice(open + 1, end - 1);
        if (![...factoryCalls].some((called) => new RegExp(`(?:^|,)\\s*${escaped(called)}\\s*\\(`).test(args) && !bindingShadowed(otherMask, called.split('.')[0]!, mount.index))) continue;
        for (const port of receiverListenerPorts(t, other, mount[1]!, mount.index, seen)) ports.add(port);
      }
      continue;
    }
    const alias = goImportAlias(source, 'net/http');
    if (alias === undefined) continue;
    const literalPort = (value: string): string | undefined => {
      const literal = value.startsWith('"') ? value : new RegExp(`\\b${escaped(value)}\\s*=\\s*("[^"\\n]+")`).exec(source)?.[1];
      return literal === undefined ? undefined : /:(\d+)"$/.exec(literal)?.[1];
    };
    for (const call of source.matchAll(new RegExp(`\\b${escaped(alias)}\\.ListenAndServe\\s*\\(\\s*("[^"\\n]+"|\\w+)\\s*,\\s*([^,]+?)\\)`, 'g'))) {
      if (otherMask.slice(call.index, call.index + alias.length) !== alias || bindingShadowed(otherMask, alias, call.index) || !handlesReceiver(call[2]!, call.index)) continue;
      const port = literalPort(call[1]!); if (port !== undefined) ports.add(port);
    }
    for (const declaration of otherMask.matchAll(new RegExp(`\\b(\\w+)\\s*:=\\s*&?${escaped(alias)}\\.Server\\s*\\{`, 'g'))) {
      const open = declaration.index + declaration[0].lastIndexOf('{'); const end = closeDelimiter(otherMask, open, '{', '}');
      if (end === undefined || bindingShadowed(otherMask, alias, declaration.index)) continue;
      const body = withoutComments(source.slice(open + 1, end - 1));
      const handler = /(?:^|,)\s*Handler\s*:\s*([^,]+)/.exec(body)?.[1];
      const addr = /(?:^|,)\s*Addr\s*:\s*("[^"\n]+"|\w+)/.exec(body)?.[1];
      if (handler === undefined || addr === undefined || !handlesReceiver(handler, declaration.index)) continue;
      const server = declaration[1]!;
      const listening = [...otherMask.matchAll(new RegExp(`\\b${escaped(server)}\\.ListenAndServe\\s*\\(`, 'g'))].some((call) => !bindingShadowed(otherMask, server, call.index, declaration.index));
      const port = literalPort(addr); if (listening && port !== undefined) ports.add(port);
    }
  }
  return [...ports].sort();
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
