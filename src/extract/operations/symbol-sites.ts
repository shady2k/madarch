/** Small positioned source joins for the synchronous operations extractor.
 * Only declarations present in the source become shared code.symbol nodes.
 */
import type { CodeBindingFact, CodeExpressionFact, CodeImportFact, CodeSymbolFact } from '../code/facts.js';
import { httpModels } from '../library-models/http-models.js';
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

/**
 * The node kinds whose characters are no code: a comment, a quoted or template
 * literal, a Go rune literal, and JSX text. The shared expression facts name
 * each one with its exact span, so no character of the text decides where a
 * string or a comment begins and ends: an escaped quote, a template's
 * substitution, a nested block comment and a line comment at the end of a file
 * are each one fact with one span.
 */
const NON_CODE_KINDS: ReadonlySet<string> = new Set(['comment', 'string', 'template_string', 'interpreted_string_literal',
  'raw_string_literal', 'rune_literal', 'jsx_text']);

/** One path's two masks, built once for the view that reads it. */
interface PathMasks {
  /** Comments and literals blanked: the code a delimiter or declaration scan may read. */
  readonly code: string;
  /** Comments blanked only, a literal's own characters kept: a field a comment spells is no code. */
  readonly uncommented: string;
}

/** The masks already built for one view, so a second question reads the first answer. */
const masks = new WeakMap<TreeText, Map<string, PathMasks>>();

/** The character offsets a byte span stands at, or undefined where its bytes are no text boundary. */
function charsOf(t: TreeText, path: string, span: SourceSpan): readonly [number, number] | undefined {
  if (span.path !== path) return undefined;
  const boundaries = t.charBoundaries(path);
  const start = boundaries[span.byteStart];
  const end = boundaries[span.byteEnd];
  return start === undefined || end === undefined || start < 0 || end < start ? undefined : [start, end];
}

/** The text with every span's characters made spaces, each newline kept, so offsets never move. */
function blanked(text: string, spans: readonly (readonly [number, number])[]): string {
  const parts: string[] = [];
  let at = 0;
  for (const [start, end] of [...spans].sort((left, right) => left[0] - right[0] || left[1] - right[1])) {
    if (start > at) parts.push(text.slice(at, start));
    for (let index = Math.max(start, at); index < end; index++) parts.push(text[index] === '\n' ? '\n' : ' ');
    at = Math.max(at, end);
  }
  if (at < text.length) parts.push(text.slice(at));
  return parts.join('');
}

/** One path's masks, decided by the facts' own node kinds and spans and never by a second scan of its text. */
function masksOf(t: TreeText, path: string): PathMasks {
  const held = masks.get(t) ?? new Map<string, PathMasks>();
  masks.set(t, held);
  const cached = held.get(path);
  if (cached !== undefined) return cached;
  const comments: (readonly [number, number])[] = [];
  const literals: (readonly [number, number])[] = [];
  for (const expression of t.expressionsByPath.all(path)) {
    if (!NON_CODE_KINDS.has(expression.syntaxKind)) continue;
    const chars = charsOf(t, path, expression.span);
    if (chars === undefined) continue;
    (expression.syntaxKind === 'comment' ? comments : literals).push(chars);
  }
  const text = t.text(path);
  const made: PathMasks = { code: blanked(text, [...comments, ...literals]), uncommented: blanked(text, comments) };
  held.set(path, made);
  return made;
}

/**
 * The file's code with its comments and literals blanked, offsets, delimiters
 * and newlines kept. A file the facts did not read keeps its text unchanged:
 * every caller of this function still asks the facts for its proof, so a file
 * with no facts answers no proof rather than a guess made of characters.
 */
export function sourceMask(t: TreeText, path: string): string { return masksOf(t, path).code; }

export function sourceSpan(t: TreeText, path: string, start: number, end: number): SourceSpan {
  const text = t.text(path);
  return t.spanOfChars(path, start, end, text.slice(0, start).split('\n').length, text.slice(0, Math.max(start, end - 1)).split('\n').length);
}

/**
 * Canonical callables copied by the shared code pass. No text recognition
 * fallback. One path's sites are proved once per view, so every later question
 * about that path reads the same proof and adds no second diagnostic.
 */
export function functionsOf(t: TreeText, path: string): FunctionSite[] {
  const proved = t.callableSites(path);
  if (proved !== undefined) return [...proved];
  if (t.facts === undefined) {
    t.factGap(path, 'line 1: callable sites require shared resolved code facts');
    return [...t.rememberCallableSites(path, [])];
  }
  const file = t.filesByPath.all(path)[0];
  if (file?.parsed !== true) {
    t.factGap(path, 'line 1: callable sites require a successfully parsed file');
    return [...t.rememberCallableSites(path, [])];
  }
  const boundaries = t.charBoundaries(path);
  const charAt = (byte: number): number | undefined => {
    if (!Number.isInteger(byte) || byte < 0 || byte >= boundaries.length) return undefined;
    const at = boundaries[byte];
    return at === undefined || at < 0 ? undefined : at;
  };
  const found: FunctionSite[] = [];
  const sameSpan = (left: SourceSpan, right: SourceSpan): boolean => left.path === path && right.path === path &&
    left.byteStart === right.byteStart && left.byteEnd === right.byteEnd && left.lineStart === right.lineStart && left.lineEnd === right.lineEnd;
  const expressions = t.expressionsByPath.all(path).filter((entry) => entry.span.path === path);
  const declarationOnlyInterfaceMethod = (symbol: CodeSymbolFact): boolean => {
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
    return t.symbolsByPath.all(path).filter((entry) => entry.symbolKind === 'interface' && sameSpan(entry.span, owner.span) &&
      symbol.qualifiedName === `${entry.qualifiedName}.${symbol.name}`).length === 1;
  };
  const declarationOnlyAbstractMethod = (symbol: CodeSymbolFact): boolean => {
    if (!['typescript', 'tsx'].includes(file.language) || symbol.symbolKind !== 'method' ||
      symbol.bodySpan !== undefined || symbol.bodySyntaxKind !== undefined) return false;
    const contains = (outer: SourceSpan, inner: SourceSpan): boolean => outer.path === path && inner.path === path &&
      outer.byteStart <= inner.byteStart && inner.byteStart < inner.byteEnd && inner.byteEnd <= outer.byteEnd;
    const unique = (id: string) => {
      const candidates = expressions.filter((entry) => entry.id === id);
      return candidates.length === 1 ? candidates[0] : undefined;
    };
    const methods = expressions.filter((entry) => entry.syntaxKind === 'abstract_method_signature' && sameSpan(entry.span, symbol.span));
    if (methods.length !== 1) return false;
    const method = methods[0]!;
    if (unique(method.id) !== method || (method.fields.body ?? []).length !== 0) return false;
    const names = method.fields.name ?? [];
    const name = names.length === 1 ? unique(names[0]!) : undefined;
    if (name?.name !== symbol.name || method.children.filter((id) => id === name.id).length !== 1 || !contains(method.span, name.span)) return false;
    const containers = expressions.filter((entry) => entry.syntaxKind === 'class_body' &&
      entry.children.filter((id) => id === method.id).length === 1 && contains(entry.span, method.span));
    if (containers.length !== 1) return false;
    const container = containers[0]!;
    if (unique(container.id) !== container) return false;
    const owners = expressions.filter((entry) => entry.syntaxKind === 'abstract_class_declaration' &&
      (entry.fields.body ?? []).length === 1 && entry.fields.body![0] === container.id &&
      entry.children.filter((id) => id === container.id).length === 1 && contains(entry.span, container.span));
    if (owners.length !== 1) return false;
    const owner = owners[0]!;
    if (unique(owner.id) !== owner) return false;
    const ownerNames = owner.fields.name ?? [];
    const ownerName = ownerNames.length === 1 ? unique(ownerNames[0]!) : undefined;
    if (ownerName?.name === undefined || owner.children.filter((id) => id === ownerName.id).length !== 1 || !contains(owner.span, ownerName.span)) return false;
    const classes = t.symbolsByPath.all(path).filter((entry) => entry.symbolKind === 'class' && sameSpan(entry.span, owner.span));
    const canonical = classes.length === 1 ? classes[0] : undefined;
    return canonical !== undefined && !canonical.callable && canonical.name === ownerName.name &&
      symbol.qualifiedName === `${canonical.qualifiedName}.${symbol.name}` &&
      t.symbolsByKey.all(canonical.key).length === 1;
  };
  const symbols = t.symbolsByPath.all(path).filter((entry) => entry.callable);
  const counts = new Map<string, number>();
  for (const symbol of symbols) counts.set(symbol.key, (counts.get(symbol.key) ?? 0) + 1);
  for (const symbol of symbols) {
    if (counts.get(symbol.key) !== 1) { t.factGap(path, `line ${symbol.span.lineStart}: duplicate callable identity ${symbol.key}`); continue; }
    const body = symbol.bodySpan;
    if (body === undefined || symbol.bodySyntaxKind === undefined) {
      // Exact copied interface or abstract-class signatures declare no executable
      // body. A missing body on an actual callable remains a diagnostic tombstone.
      if (declarationOnlyInterfaceMethod(symbol) || declarationOnlyAbstractMethod(symbol)) continue;
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
    const receiverBindings = receiver === undefined ? [] : t.bindingsById.all(receiver.bindingId);
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
  return [...t.rememberCallableSites(path, found)];
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
  const owners = t.symbolsByPath.all(path).filter((symbol) => symbol.callable && symbol.span.byteStart <= byte && byte < symbol.span.byteEnd)
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

/** One HTTP factory the shipped models declare: the package it is imported from and the export paths that reach it. */
interface HttpFactoryModel {
  readonly package: string;
  /** Each path starts at the imported module: `[]` its own value, `['default', 'Router']` a member of it. */
  readonly paths: readonly (readonly string[])[];
}

/** Every modelled HTTP factory call as data — `express.application`, `express.router`, `http.mux` — and no name written here. */
const HTTP_FACTORIES: readonly HttpFactoryModel[] = httpModels.flatMap((model) => {
  if (model.effect.kind !== 'factory' || model.target.kind !== 'export') return [];
  const factory: HttpFactoryModel = { package: model.package, paths: model.target.paths };
  return [factory];
});

/** The bindings of every path of one view, grouped once: a question about shadowing asks the facts, never the text. */
const pathBindings = new WeakMap<TreeText, ReadonlyMap<string, readonly CodeBindingFact[]>>();

function bindingsByPath(t: TreeText): ReadonlyMap<string, readonly CodeBindingFact[]> {
  const held = pathBindings.get(t);
  if (held !== undefined) return held;
  const grouped = new Map<string, CodeBindingFact[]>();
  for (const binding of t.facts?.bindings ?? []) {
    const group = grouped.get(binding.path);
    if (group === undefined) grouped.set(binding.path, [binding]);
    else group.push(binding);
  }
  const indexed = new Map<string, readonly CodeBindingFact[]>();
  for (const [path, group] of grouped) {
    const frozen: readonly CodeBindingFact[] = [...group];
    indexed.set(path, Object.freeze(frozen));
  }
  pathBindings.set(t, indexed);
  return indexed;
}

/** The one entry a list holds: an id or a name the facts hold twice proves nothing. */
function one<T>(items: readonly T[]): T | undefined {
  return items.length === 1 ? items[0] : undefined;
}

/** The one expression fact an id names. */
function expressionFact(t: TreeText, id: string | undefined): CodeExpressionFact | undefined {
  return id === undefined ? undefined : one(t.expressionsById.all(id));
}

/** The import fact one binding fact names, proved in this path. */
function importOf(t: TreeText, path: string, binding: CodeBindingFact): CodeImportFact | undefined {
  if (binding.kind !== 'import' || binding.importId === undefined) return undefined;
  return one(t.importsByPath.all(path).filter((entry) => entry.id === binding.importId && entry.span.path === path));
}

/**
 * The export paths one written reference stands for, from the form its import
 * binds. A named import names one symbol and takes no member. A default or
 * namespace import names the module itself — its own value, or one of its
 * exports read off it — and a Go package is recorded the same way, so
 * `http.NewServeMux` asks for the package's own export `NewServeMux`.
 */
function referencedPaths(imported: CodeImportFact, member: string | undefined): readonly (readonly string[])[] {
  const form = imported.imported;
  if (form.form === 'named') return member === undefined ? [[form.name]] : [];
  return member === undefined ? [[], ['default']] : [[member], ['default', member]];
}

/** Whether one written reference reaches a factory the shipped HTTP models declare. */
function httpFactoryReference(t: TreeText, path: string, callee: CodeExpressionFact): boolean {
  const read = callee.syntaxKind === 'member_expression' || callee.syntaxKind === 'selector_expression';
  const object = read ? expressionFact(t, callee.receiver) : callee;
  if (object === undefined || object.syntaxKind !== 'identifier') return false;
  const member = read ? callee.member : undefined;
  if (read && member === undefined) return false;
  const bindingId = object.bindingId;
  if (bindingId === undefined) return false;
  const binding = one(t.bindingsById.all(bindingId));
  const imported = binding === undefined ? undefined : importOf(t, path, binding);
  if (imported === undefined || imported.typeOnly === true) return false;
  const written = referencedPaths(imported, member);
  const key = (parts: readonly string[]): string => parts.join('\u0000');
  return HTTP_FACTORIES.some((factory) => factory.package === imported.specifier &&
    factory.paths.some((declared) => written.some((candidate) => key(candidate) === key(declared))));
}

/**
 * The binding fact a use of one name stands under: the innermost scope that
 * holds a declaration of the name, with that declaration before the use. Two
 * facts claiming the same scope withhold the answer instead of choosing one,
 * and a declaration after the use is not yet the name's meaning there. A
 * parameter, a local, a type and an import are answered alike — the binding
 * fact itself says which one the name is.
 */
function bindingAt(t: TreeText, path: string, name: string, byte: number): CodeBindingFact | undefined {
  const width = (binding: CodeBindingFact): number => binding.scope.byteEnd - binding.scope.byteStart;
  const all: readonly CodeBindingFact[] = bindingsByPath(t).get(path) ?? [];
  const enclosing = all.filter((binding) => binding.name === name && binding.scope.path === path &&
    binding.scope.byteStart <= byte && byte <= binding.scope.byteEnd);
  if (enclosing.length === 0) return undefined;
  const innermost = enclosing.reduce((left, right) => (width(right) < width(left) ? right : left));
  const claimed = enclosing.filter((binding) => width(binding) === width(innermost));
  const binding = one(claimed);
  return binding !== undefined && binding.span.byteEnd <= byte ? binding : undefined;
}

/**
 * Whether the name a registration uses as its receiver is an HTTP application,
 * router or mux where it stands. The binding facts say which declaration the
 * name means at that position — a parameter, a nearer local or a type-only
 * import is that declaration, not the package — and the shipped HTTP models say
 * whether that declaration's own origin is one of the library's factories.
 */
export function httpReceiver(t: TreeText, path: string, receiver: string, at: number): boolean {
  const text = t.text(path);
  if (!Number.isInteger(at) || at < 0 || at > text.length) return false;
  const byte = new TextEncoder().encode(text.slice(0, at)).length;
  const binding = bindingAt(t, path, receiver, byte);
  if (binding === undefined) return false;
  const imported = importOf(t, path, binding);
  if (imported !== undefined) {
    // A Go package call names its receiver as the package itself, as in
    // `http.ListenAndServe`: the package is the receiver where the models give
    // it a factory at its own export, and a type-only import never is.
    const file = one(t.filesByPath.all(path));
    return imported.typeOnly !== true && file?.language === 'go' &&
      HTTP_FACTORIES.some((factory) => factory.package === imported.specifier);
  }
  // A name the file declares is the library's only where its one initializer is
  // a call of a factory the models declare.
  if (binding.kind !== 'local' || binding.initializer === undefined) return false;
  const call = expressionFact(t, binding.initializer);
  if (call === undefined || call.syntaxKind !== 'call_expression') return false;
  const callee = expressionFact(t, call.callee);
  return callee !== undefined && httpFactoryReference(t, path, callee);
}

/** Ports proved for this registration's receiver, never the service-wide union.
 * Unsupported aliases/mounts return no ports; callers retain a located gap.
 */
export function receiverListenerPorts(t: TreeText, path: string, receiver: string, at: number, seen = new Set<string>()): string[] {
  const identity = `${path}:${receiver}:${at}`;
  if (seen.has(identity) || seen.size >= 20) return [];
  seen.add(identity);
  const mask = sourceMask(t, path);
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
  const tsPort = (sourcePath: string, value: string, position: number): string | undefined => {
    if (/^\d+$/.test(value)) return value === '0' ? undefined : value;
    const sourceMasked = sourceMask(t, sourcePath);
    const declarations = [...sourceMasked.matchAll(new RegExp(`\\bconst\\s+${escaped(value)}\\s*=\\s*(\\d+)\\s*(?=;|\\n|$)`, 'g'))]
      .filter((entry) => visibleDefinition(sourceMasked, entry.index, position) && !bindingShadowed(sourceMasked, value, position, entry.index));
    return declarations.length === 1 && declarations[0]![1] !== '0' ? declarations[0]![1] : undefined;
  };
  if (!path.endsWith('.go')) {
    for (const listener of mask.matchAll(new RegExp(`\\b${escaped(receiver)}\\.listen\\(\\s*(\\d+|[A-Za-z_$][\\w$]*)\\s*(?=[,)])`, 'g'))) {
      const port = tsPort(path, listener[1]!, listener.index);
      if (port !== undefined && sameBinding(listener.index) && httpReceiver(t, path, receiver, listener.index)) ports.add(port);
    }
  }
  const owner = functionAt(t, path, at);
  const returned = owner !== undefined && (new RegExp(`\\breturn\\s+${escaped(receiver)}\\b`).test(mask.slice(owner.bodyStart, owner.end)) || new RegExp(`\\breturn\\s+Chain\\s*\\([^;]*\\)\\s*\\(\\s*${escaped(receiver)}\\s*\\)`).test(mask.slice(owner.bodyStart, owner.end)));
  const factory = returned ? owner.name : undefined;
  // The unit that declares this file's folder, never a folder called services/: its files are the siblings.
  const unit = t.unitOf(path);
  const scope = unit === undefined ? undefined : unit.root === '' ? '' : `${unit.root}/`;
  for (const other of t.tree.paths.filter((file) => scope !== undefined && (scope === '' || file.startsWith(scope)) && file.endsWith(path.endsWith('.go') ? '.go' : '.ts'))) {
    const source = t.text(other); const otherMask = sourceMask(t, other);
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
        const folder = path.slice(0, path.lastIndexOf('/'));
        // The module path the unit declares, and this file's folder relative to the unit's root.
        const module = unit?.ecosystem === 'go' ? unit.declared : undefined;
        const relative = unit === undefined ? '' : folder.slice(unit.root.length);
        const alias = module === undefined ? undefined : importedModule(t, other, `${module}${relative}`)?.local;
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
            const port = tsPort(other, chained[1]!, end);
            if (port !== undefined) ports.add(port);
          }
          for (const local of otherMask.matchAll(new RegExp(`\\b(?:const|let)\\s+(\\w+)\\s*=\\s*${escaped(called)}\\s*\\(`, 'g'))) {
            if (local.index + local[0].lastIndexOf(called) !== call.index) continue;
            for (const listener of otherMask.matchAll(new RegExp(`\\b${escaped(local[1]!)}\\.listen\\(\\s*(\\d+|[A-Za-z_$][\\w$]*)\\s*(?=[,)])`, 'g'))) {
              if (listener.index <= end || !visibleDefinition(otherMask, local.index, listener.index) || bindingShadowed(otherMask, local[1]!, listener.index, local.index)) continue;
              const port = tsPort(other, listener[1]!, listener.index);
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
    const httpPackage = importedModule(t, other, 'net/http');
    if (httpPackage === undefined || !httpPackage.namespace) continue;
    const alias = httpPackage.local;
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
      const body = withoutComments(t, other).slice(open + 1, end - 1);
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

/** Comments masked without changing literal values or source offsets, from the facts' comment spans. */
export function withoutComments(t: TreeText, path: string): string {
  return masksOf(t, path).uncommented;
}

/**
 * What one module's import binds in one path, as the facts bind it: the local
 * name it gives the module, the specifier as written, and whether that name
 * stands for the whole module — a Go package or a `* as ns` — rather than for
 * one of the module's own names. The local name is the facts': the alias the
 * import writes, else the package name the resolution read, else the
 * specifier's last segment. A Go import written with a raw string names the
 * same module a quoted one does, because the grammar delimited both tokens.
 */
export interface ImportedModule {
  readonly local: string;
  readonly specifier: string;
  readonly namespace: boolean;
}

/**
 * The one import the facts hold for one module in one path, and the name it
 * binds. One module answers one import: two facts for the module, none, and a
 * type-only import that binds no value all answer nothing rather than a guess.
 * A place (`at`, a character offset) asks the same question where a name is
 * used, and there the facts' own binding must be this import — so a parameter,
 * a local or a receiver of the same name answers no module at its own use.
 */
export function importedModule(t: TreeText, path: string, module: string, at?: number): ImportedModule | undefined {
  const imported = one(t.importsByPath.all(path).filter((entry) => entry.span.path === path && entry.specifier === module &&
    entry.typeOnly !== true));
  if (imported === undefined) return undefined;
  if (at !== undefined) {
    const text = t.text(path);
    if (!Number.isInteger(at) || at < 0 || at > text.length) return undefined;
    const binding = bindingAt(t, path, imported.local, new TextEncoder().encode(text.slice(0, at)).length);
    if (binding === undefined || binding.kind !== 'import' || binding.importId !== imported.id) return undefined;
  }
  return { local: imported.local, specifier: imported.specifier, namespace: imported.imported.form === 'namespace' };
}
