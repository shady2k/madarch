import { posix, resolve } from 'node:path';
import { parseDocument, LineCounter } from 'yaml';
import { byCodePoint } from '../model/order.js';

export type ContractReason =
  | {code: 'definitionMissing'}
  | {code: 'contractReadBudget'; params: {maxFiles: number; maxBytes: number}}
  | {code: 'yamlParse'}
  | {code: 'yamlConversion'}
  | {code: 'definitionObjectRequired'}
  | {code: 'yamlAliasCycle'}
  | {code: 'definitionNesting'; params: {maxLevels: number}}
  | {code: 'definitionRepresentationBudget'; params: {maxBytes: number}}
  | {code: 'referenceAnchorUnsupported'; params: {ref: string}}
  | {code: 'referenceRemoteOrAbsolute'; params: {ref: string}}
  | {code: 'referenceEncodingInvalid'; params: {ref: string}}
  | {code: 'referenceEscapesRepository'; params: {ref: string}}
  | {code: 'pointerEncodingInvalid'; params: {ref: string}}
  | {code: 'referenceUnresolved'; params: {ref: string}}
  | {code: 'externalExample'; params: {ref: string}}
  | {code: 'externalLogo'; params: {ref: string}}
  | {code: 'descriptionImage'}
  | {code: 'descriptionMarkupBudget'; params: {maxNodes: number}}
  | {code: 'reservedBundleField'; params: {field: string}}
  | {code: 'operationReferenceBudgetOrCycle'; params: {maxReferences: number}}
  | {code: 'operationReferenceUnresolved'; params: {ref: string}}
  | {code: 'protoImportBudget'; params: {maxFiles: number; maxDepth: number}}
  | {code: 'protoImportMissing'}
  | {code: 'protoByteBudget'; params: {maxBytes: number}}
  | {code: 'protoParse'}
  | {code: 'protoImportInvalid'; params: {ref: string}}
  | {code: 'protoImportEscapesRepository'; params: {ref: string}}
  | {code: 'protoResolve'}
  | {code: 'definitionSubjectUnsupported'}
  | {code: 'declaringContractCount'; params: {count: number}}
  | {code: 'contractFormatUnsupported'; params: {format: string}}
  | {code: 'contractVersionMissing'; params: {format: string}}
  | {code: 'operationSelectionMissing'; params: {method: string; path: string}}
  | {code: 'operationIdAmbiguous'; params: {operationId: string; count: number}}
  | {code: 'unknownDefinitionFailure'}
  | {code: 'rendererFailure'}
  | {code: 'rendererValidationFailure'}
  | {code: 'selectionNotRendered'};
export type ContractDiagnostic = { path: string; line: number; fullPath: string; code: string; detail: string; reason?: ContractReason; technicalDetail?: string };
export class ContractReadError extends Error {
  constructor(readonly diagnostic: ContractDiagnostic) { super(`${diagnostic.path}:${diagnostic.line} (${diagnostic.fullPath}): ${diagnostic.detail}`); }
}
export function withContractReason<T extends Error>(error: T, reason: ContractReason): T & {contractReason: ContractReason} {
  return Object.assign(error, {contractReason: reason});
}
export function contractReasonOf(error: unknown): ContractReason | undefined {
  return error instanceof Error && 'contractReason' in error ? (error as Error & {contractReason: ContractReason}).contractReason : undefined;
}
export const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Read a complete document and bundle only repository-local references from the pinned source reader.
 * Cycles stay references. No remote resolver or browser fetch is needed by either renderer. */
export async function contractDocument(path: string, read: (path: string) => Promise<string | undefined>, fullPath: (path: string) => string): Promise<{ document: Record<string, unknown>; text: string; descriptions: {text: string; path: string; line: number; fullPath: string}[] }> {
  const docs = new Map<string, Record<string, unknown>>();
  const texts = new Map<string, string>();
  const ids = new Map<string, string>();
  const positions = new Map<string, (at: string[]) => number>();
  let bytes = 0;
  let expandedBytes = 0;
  const descriptions: {text: string; path: string; line: number; fullPath: string}[] = [];
  const refuse = (file: string, code: string, detail: string, reason: ContractReason, line = 1): never => { throw new ContractReadError({path: file, line, fullPath: fullPath(file), code, detail, reason, technicalDetail: detail}); };
  type Context = 'document' | 'components' | 'objectMap' | 'schema' | 'schemaArray' | 'schemaMap' | 'media' | 'mediaMap' | 'example' | 'exampleMap' | 'response' | 'responseMap' | 'header' | 'headerMap' | 'message' | 'messageMap' | 'pathMap' | 'pathItem' | 'operation' | 'parameter' | 'parameterMap' | 'channelMap' | 'channel' | 'opaque';
  async function load(file: string): Promise<Record<string, unknown>> {
    const held = docs.get(file);
    if (held !== undefined) return held;
    const text = await read(file);
    if (text === undefined) return refuse(file, 'missing', 'the complete definition is not readable at the pinned revision', {code: 'definitionMissing'});
    bytes += Buffer.byteLength(text);
    if (docs.size >= 64 || bytes > 4 * 1024 * 1024) return refuse(file, 'limit', 'contract definitions exceed 64 files or the 4 MiB documentation budget', {code: 'contractReadBudget', params: {maxFiles: 64, maxBytes: 4 * 1024 * 1024}});
    texts.set(file, text);
    const lines = new LineCounter();
    const parsed = parseDocument(text, { lineCounter: lines, uniqueKeys: true });
    if (parsed.errors.length > 0) {
      const error = parsed.errors[0]!;
      return refuse(file, 'parse', error.message, {code: 'yamlParse'}, lines.linePos(error.pos[0]).line);
    }
    let value: unknown;
    try { value = parsed.toJS({maxAliasCount: 100}); } catch (error) { return refuse(file, 'parse', String(error), {code: 'yamlConversion'}); }
    if (!object(value)) return refuse(file, 'shape', 'the definition must be an object', {code: 'definitionObjectRequired'});
    docs.set(file, value);
    // Register before following references, including circular references between files.
    if (file !== path && !ids.has(file)) ids.set(file, `file${ids.size}`);
    const active = new Set<object>();
    const checked = new Set<object>();
    function checkAliases(node: unknown, at: string[], depth: number): void {
      if (node === null || typeof node !== 'object') return;
      const range = (parsed.getIn(at, true) as {range?: readonly number[]} | undefined)?.range;
      const line = range === undefined ? 1 : lines.linePos(range[0]!).line;
      if (active.has(node)) refuse(file, 'parse', 'cyclic YAML alias cannot be represented as a JSON definition', {code: 'yamlAliasCycle'}, line);
      if (depth > 128) refuse(file, 'limit', 'definition nesting exceeds 128 levels', {code: 'definitionNesting', params: {maxLevels: 128}}, line);
      if (checked.has(node)) return;
      active.add(node);
      for (const [key, child] of Object.entries(node)) checkAliases(child, [...at, key], depth + 1);
      active.delete(node); checked.add(node);
    }
    checkAliases(value, [], 0);
    // Count the expanded representation before allocating it. Repeated YAML aliases count
    // each time in the output, but their subtree size is measured only once.
    const sizes = new WeakMap<object, number>();
    const maximum = 4 * 1024 * 1024;
    const add = (size: number, more: number): number => {
      if (size > maximum - more) refuse(file, 'limit', 'expanded contract definition exceeds the 4 MiB documentation budget', {code: 'definitionRepresentationBudget', params: {maxBytes: maximum}});
      return size + more;
    };
    function sizeOf(node: unknown): number {
      if (node === null || typeof node !== 'object') return Buffer.byteLength(JSON.stringify(node) ?? 'null');
      const cached = sizes.get(node); if (cached !== undefined) return cached;
      let size = 2;
      if (Array.isArray(node)) for (const child of node) size = add(add(size, 1), sizeOf(child));
      else for (const [key, child] of Object.entries(node)) size = add(add(add(size, Buffer.byteLength(JSON.stringify(key))), 2), sizeOf(child));
      sizes.set(node, size); return size;
    }
    expandedBytes = add(expandedBytes, sizeOf(value));
    // Clone only after the bounded expanded size is known. Opaque instances cannot share
    // mutable objects with schema positions that happen to use the same YAML anchor.
    function clone(node: unknown): unknown {
      if (Array.isArray(node)) return node.map(clone);
      if (object(node)) return Object.fromEntries(Object.entries(node).map(([key, child]) => [key, clone(child)]));
      return node;
    }
    const independent = clone(value) as Record<string, unknown>;
    docs.set(file, independent);
    positions.set(file, (at) => {
      const range = (parsed.getIn(at, true) as {range?: readonly number[]} | undefined)?.range;
      return range === undefined ? 1 : lines.linePos(range[0]!).line;
    });
    return independent;
  }
  type Protocol = 'openapi' | 'asyncapi' | 'unknown';
  type Role = Context | {kind: 'container'; children: ReadonlyMap<string, Role>; fallback: Role};
  const members: Partial<Record<Context, Context>> = {objectMap: 'document', schemaMap: 'schema', mediaMap: 'media', exampleMap: 'example', responseMap: 'response', headerMap: 'header', messageMap: 'message', pathMap: 'pathItem', parameterMap: 'parameter', channelMap: 'channel'};
  const mapFor = (role: Context): Context => role === 'schema' ? 'schemaMap' : role === 'example' ? 'exampleMap' : role === 'media' ? 'mediaMap' : role === 'response' ? 'responseMap' : role === 'header' ? 'headerMap' : role === 'message' ? 'messageMap' : role === 'parameter' ? 'parameterMap' : 'objectMap';
  /** The same owning-role transition is used for ordinary children AND JSON pointer steps. */
  function roleTransition(parent: Role, key: string, child: unknown, protocol: Protocol): Role {
    if (typeof parent !== 'string') return parent.children.get(key) ?? parent.fallback;
    if (parent === 'opaque') return 'opaque';
    const member = members[parent]; if (member !== undefined) return member;
    if (parent === 'schemaArray') return 'schema';
    if (parent === 'components') return key === 'schemas' ? 'schemaMap' : key === 'examples' ? 'exampleMap' : key === 'headers' ? 'headerMap' : key === 'responses' ? 'responseMap' : key === 'messages' ? 'messageMap' : key === 'parameters' ? 'parameterMap' : 'objectMap';
    if (parent === 'example' && key === 'value') return 'opaque';
    if (parent === 'schema') {
      if (['example', 'examples', 'default', 'enum', 'const'].includes(key)) return 'opaque';
      if (['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas'].includes(key)) return 'schemaMap';
      if (['allOf', 'anyOf', 'oneOf', 'prefixItems'].includes(key) || (key === 'items' && Array.isArray(child))) return 'schemaArray';
      if (['items', 'additionalProperties', 'contains', 'not', 'if', 'then', 'else', 'propertyNames'].includes(key)) return 'schema';
    }
    if (parent === 'response') {
      if (key === 'headers') return 'headerMap';
      if (key === 'examples') return 'opaque';
    }
    if (parent === 'message') {
      if (key === 'headers' || key === 'payload') return 'schema';
      if (key === 'examples') return 'opaque';
    }
    if (parent === 'media' || parent === 'header' || parent === 'parameter') {
      if (['example', 'default', 'enum', 'const'].includes(key)) return 'opaque';
      if (key === 'examples') return 'exampleMap';
    }
    if (parent === 'pathItem' && ['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace'].includes(key)) return 'operation';
    if (parent === 'channel' && (key === 'publish' || key === 'subscribe')) return 'operation';
    if (key === 'components') return 'components';
    if (key === 'definitions' || key === '$defs') return 'schemaMap';
    if (key === 'schema') return 'schema';
    if (key === 'content') return 'mediaMap';
    if (key === 'responses') return 'responseMap';
    if (key === 'messages') return 'messageMap';
    if (key === 'message') return 'message';
    if (key === 'paths' || key === 'callbacks') return 'pathMap';
    if (key === 'channels') return 'channelMap';
    if (key === 'parameters') return Array.isArray(child) ? 'parameter' : 'parameterMap';
    if (protocol === 'asyncapi' && key === 'payload') return 'schema';
    if (object(child)) {
      if (typeof child['type'] === 'string' || (Array.isArray(child['type']) && child['type'].every((value) => typeof value === 'string'))) return 'schema';
      if ('value' in child || typeof child['externalValue'] === 'string') return 'example';
    }
    return 'document';
  }
  function protocolOf(document: Record<string, unknown>, fallback: Protocol): Protocol {
    return typeof document['asyncapi'] === 'string' ? 'asyncapi' : typeof document['openapi'] === 'string' || document['swagger'] === '2.0' ? 'openapi' : fallback;
  }
  function rootRole(document: Record<string, unknown>, expected: Context, parts: readonly string[], protocol: Protocol): Role {
    if (typeof document['openapi'] === 'string' || typeof document['asyncapi'] === 'string' || document['swagger'] === '2.0') return 'document';
    const type = document['type'];
    const schemaType = typeof type === 'string' || (Array.isArray(type) && type.every((value) => typeof value === 'string'));
    const candidates: Context[] = [];
    if (schemaType || object(document['properties']) || object(document['definitions']) || object(document['$defs']) || object(document['items']) || Array.isArray(document['items']) || ['allOf', 'anyOf', 'oneOf'].some((key) => Array.isArray(document[key]))) candidates.push('schema');
    if ('value' in document || typeof document['externalValue'] === 'string') candidates.push('example');
    if (object(document['schema'])) candidates.push('media');
    const atTarget = (root: Role): Role => {
      let role = root; let held: unknown = document;
      for (const key of parts) {
        const child: unknown = object(held) || Array.isArray(held) ? (held as Record<string, unknown>)[key] : undefined;
        role = roleTransition(role, key, child, protocol); held = child;
      }
      return role;
    };
    // Known owning positions win, including Schema arrays and opaque Example.value.
    for (const candidate of candidates) if (atTarget(candidate) === expected || atTarget(candidate) === 'opaque') return candidate;
    const memberFits = (held: unknown): boolean => {
      if (!object(held)) return false;
      if (typeof held['$ref'] === 'string') return true;
      if (expected === 'example') return 'value' in held || typeof held['externalValue'] === 'string';
      if (expected === 'schema') return typeof held['type'] === 'string' || Array.isArray(held['type']) || object(held['properties']) || object(held['items']) || Array.isArray(held['allOf']);
      return true;
    };
    const values = Object.entries(document).filter(([key, value]) => !((key === 'description' || key === 'summary') && typeof value === 'string'));
    if (values.length > 0 && values.every(([, value]) => memberFits(value))) return mapFor(expected);
    if (parts.length > 0 && candidates.length === 0) {
      const [key, ...rest] = parts;
      const child = document[key!];
      if (object(child)) return {kind: 'container', children: new Map([[key!, rootRole(child, expected, rest, protocol)]]), fallback: 'document'};
    }
    return candidates[0] ?? expected;
  }
  const visited = new WeakMap<object, Set<Role>>();
  const rawReferences = new WeakMap<object, string>();
  const rootRoles = new Map<string, Role>();
  const descriptionKeys = new Set<string>();
  async function visit(file: string, node: unknown, at: string[], context: Role, protocol: Protocol): Promise<void> {
    if (context === 'opaque') return;
    if (node !== null && typeof node === 'object') {
      const contexts = visited.get(node) ?? new Set<Role>();
      if (contexts.has(context)) return;
      contexts.add(context); visited.set(node, contexts);
    }
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) await visit(file, node[i], [...at, String(i)], roleTransition(context, String(i), node[i], protocol), protocol);
      return;
    }
    if (!object(node)) return;
    const member = typeof context === 'string' ? members[context] : undefined;
    for (const key of Object.keys(node).sort(byCodePoint)) {
      let child = node[key];
      if (member !== undefined) {
        if (typeof child === 'string' && (key === 'description' || key === 'summary')) recordDescription(file, at, key, child);
        await visit(file, child, [...at, key], roleTransition(context, key, child, protocol), protocol);
        continue;
      }
      const childRole = roleTransition(context, key, child, protocol);
      if (childRole === 'opaque') continue;
      if (key === '$ref' && typeof child === 'string') {
        if (!rawReferences.has(node)) rawReferences.set(node, child);
        const reference = rawReferences.get(node)!;
        const line = positions.get(file)?.([...at, key]) ?? 1;
        const hash = reference.indexOf('#');
        const target = hash < 0 ? reference : reference.slice(0, hash);
        const fragment = hash < 0 ? '' : reference.slice(hash + 1);
        if (fragment !== '' && !fragment.startsWith('/')) refuse(file, 'reference', `unsupported reference anchor ${reference}`, {code: 'referenceAnchorUnsupported', params: {ref: reference}}, line);
        let referred = file;
        if (target !== '') {
          if (/^[a-z][a-z0-9+.-]*:|^[/\\]|[?]/iu.test(target)) refuse(file, 'reference', `remote or absolute reference is not allowed: ${reference}`, {code: 'referenceRemoteOrAbsolute', params: {ref: reference}}, line);
          let decoded: string;
          try { decoded = decodeURIComponent(target); } catch { return refuse(file, 'reference', `invalid reference encoding: ${reference}`, {code: 'referenceEncodingInvalid', params: {ref: reference}}, line); }
          referred = posix.normalize(posix.join(posix.dirname(file), decoded));
          if (referred === '..' || referred.startsWith('../') || referred.startsWith('/') || decoded.includes('\\')) refuse(file, 'reference', `reference leaves the repository: ${reference}`, {code: 'referenceEscapesRepository', params: {ref: reference}}, line);
        }
        const other = await load(referred);
        const otherProtocol = protocolOf(other, protocol);
        const parts: string[] = [];
        if (fragment !== '') for (const part of fragment.slice(1).split('/')) {
          try { parts.push(decodeURIComponent(part).replace(/~1/g, '/').replace(/~0/g, '~')); } catch { return refuse(file, 'reference', `invalid pointer encoding: ${reference}`, {code: 'pointerEncodingInvalid', params: {ref: reference}}, line); }
        }
        const roleKey = JSON.stringify([referred, typeof context === 'string' ? context : 'document', parts]);
        let otherRole = rootRoles.get(roleKey);
        if (otherRole === undefined) { otherRole = rootRole(other, typeof context === 'string' ? context : 'document', parts, otherProtocol); rootRoles.set(roleKey, otherRole); }
        let pointed: unknown = other;
        let pointedRole = otherRole;
        for (const token of parts) {
          const next: unknown = object(pointed) || Array.isArray(pointed) ? (pointed as Record<string, unknown>)[token] : undefined;
          pointedRole = roleTransition(pointedRole, token, next, otherProtocol); pointed = next;
        }
        if (pointed === undefined) refuse(file, 'reference', `unresolved reference: ${reference}`, {code: 'referenceUnresolved', params: {ref: reference}}, line);
        await visit(referred, pointed, parts, pointedRole, otherProtocol);
        if (referred !== file) await visit(referred, other, [], otherRole, otherProtocol);
        node[key] = referred === path ? `#${fragment}` : `#/x-madarch-references/${ids.get(referred)!}${fragment}`;
      } else {
        if (key === 'externalValue' && typeof child === 'string') refuse(file, 'reference', `external example would require a network fetch: ${child}`, {code: 'externalExample', params: {ref: child}});
        if (key === 'url' && at.at(-1) === 'x-logo') refuse(file, 'reference', `external logo is not bundled: ${String(child)}`, {code: 'externalLogo', params: {ref: String(child)}});
        if (typeof child === 'string' && (key === 'description' || key === 'summary')) recordDescription(file, at, key, child);
        await visit(file, child, [...at, key], childRole, protocol);
      }
    }
  }
  function recordDescription(file: string, at: string[], key: string, text: string): void {
    const id = JSON.stringify([file, at, key]); if (descriptionKeys.has(id)) return;
    descriptionKeys.add(id);
    descriptions.push({text, path: file, line: positions.get(file)?.([...at, key]) ?? 1, fullPath: fullPath(file)});
  }
  const document = await load(path);
  await visit(path, document, [], 'document', protocolOf(document, 'unknown'));
  if (ids.size > 0) {
    if ('x-madarch-references' in document) refuse(path, 'shape', 'reserved field x-madarch-references is already present', {code: 'reservedBundleField', params: {field: 'x-madarch-references'}});
    document['x-madarch-references'] = Object.fromEntries([...ids].map(([file, id]) => [id, docs.get(file)!]));
  }
  return {document, text: texts.get(path)!, descriptions};
}

export function contractFullPath(product: string, repo: string | null, path: string): string {
  return repo === null ? resolve(product, path) : resolve(product, 'repos', repo, path);
}

/** Resolve a bundled JSON pointer for operation identity only. Cycles are refused, never selected arbitrarily. */
export function contractObjectAt(document: Record<string, unknown>, value: unknown): Record<string, unknown> | undefined {
  const seen = new Set<object>();
  let held = value;
  while (object(held) && typeof held['$ref'] === 'string') {
    if (seen.has(held) || seen.size >= 64) throw withContractReason(new Error('cyclic or over-deep operation reference'), {code: 'operationReferenceBudgetOrCycle', params: {maxReferences: 64}});
    seen.add(held);
    const ref = held['$ref'];
    if (!ref.startsWith('#/')) throw withContractReason(new Error(`unresolved operation reference: ${ref}`), {code: 'operationReferenceUnresolved', params: {ref}});
    let target: unknown = document;
    for (const piece of ref.slice(2).split('/')) {
      let token: string;
      try { token = decodeURIComponent(piece).replace(/~1/g, '/').replace(/~0/g, '~'); }
      catch (error) { if (error instanceof Error) throw withContractReason(error, {code: 'pointerEncodingInvalid', params: {ref}}); throw error; }
      target = object(target) || Array.isArray(target) ? (target as Record<string, unknown>)[token] : undefined;
    }
    held = target;
  }
  return object(held) ? held : undefined;
}
