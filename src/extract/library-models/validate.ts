/** Validate untrusted JSON before interpreting it or computing its identity. */
import { createHash } from 'node:crypto';
import data from './models.json';
import { byCodePoint } from '../../model/order.js';
import type { ArgumentSelector, ImportRole, LibraryEffectKind, LibraryModel, LibraryRegistry, LibraryRole, LibraryTypeModel, ModelTarget } from './model.js';

function object(value: unknown, where: string, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${where}: expected object`);
  for (const key of Object.keys(value)) if (!keys.includes(key)) throw new Error(`${where}.${key}: unknown field`);
  return Object.fromEntries(Object.entries(value));
}
function string(value: unknown, where: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value || [...value].some((character) => character.codePointAt(0)! < 32)) throw new Error(`${where}: expected nonempty exact string`);
  return value;
}
function list<T>(value: unknown, where: string, read: (entry: unknown, where: string) => T): readonly T[] {
  if (!Array.isArray(value)) throw new Error(`${where}: expected array`);
  return Object.freeze(value.map((entry: unknown, index: number) => read(entry, `${where}[${index}]`)));
}
function unique(values: readonly string[], where: string): void {
  if (new Set(values).size !== values.length) throw new Error(`${where}: duplicate entry`);
}
function role(value: unknown, where: string): LibraryRole {
  switch (value) {
    case 'metric-counter': case 'metric-gauge': case 'metric-histogram':
    case 'metric-counter-vector': case 'metric-gauge-vector': case 'metric-histogram-vector':
    case 'metric-registry': case 'logger': case 'logger-handler': case 'environment':
    case 'kafka-client': case 'message-producer': case 'message-consumer': return value;
    default: throw new Error(`${where}: unknown role`);
  }
}
function effect(value: unknown, where: string): LibraryEffectKind {
  switch (value) {
    case 'metric-declare': case 'metric-update': case 'metric-register': case 'metric-expose': case 'metric-text-write':
    case 'logger-declare': case 'logger-use': case 'env-read': case 'message-client':
    case 'message-publish': case 'message-consume': return value;
    default: throw new Error(`${where}: unknown effect`);
  }
}
function importRole(value: unknown, where: string): ImportRole {
  if (value === 'named' || value === 'default' || value === 'namespace') return value;
  throw new Error(`${where}: unknown import role`);
}
function target(value: unknown, where: string): ModelTarget {
  const obj = object(value, where, ['kind', 'importRoles', 'exportedPaths', 'receiverRole', 'member']);
  if (obj.kind === 'export') {
    if ('receiverRole' in obj || 'member' in obj) throw new Error(`${where}: export cannot select a receiver`);
    const importRoles = list(obj.importRoles, `${where}.importRoles`, importRole);
    const exportedPaths = list(obj.exportedPaths, `${where}.exportedPaths`, (path, at) => list(path, at, string));
    if (importRoles.length === 0 || exportedPaths.length === 0) throw new Error(`${where}: empty export selector`);
    unique(importRoles, where); unique(exportedPaths.map((path) => JSON.stringify(path)), where);
    return Object.freeze({ kind: 'export', importRoles, exportedPaths });
  }
  if (obj.kind === 'member') {
    if ('importRoles' in obj || 'exportedPaths' in obj) throw new Error(`${where}: member cannot select an import`);
    return Object.freeze({ kind: 'member', receiverRole: role(obj.receiverRole, `${where}.receiverRole`), member: string(obj.member, `${where}.member`) });
  }
  throw new Error(`${where}.kind: unknown selector`);
}
function argument(value: unknown, where: string): ArgumentSelector {
  const obj = object(value, where, ['name', 'index', 'path', 'required']);
  if (typeof obj.index !== 'number' || !Number.isSafeInteger(obj.index) || obj.index < 0) throw new Error(`${where}.index: expected nonnegative integer`);
  if (typeof obj.required !== 'boolean') throw new Error(`${where}.required: expected boolean`);
  return Object.freeze({ name: string(obj.name, `${where}.name`), index: obj.index, path: list(obj.path, `${where}.path`, string), required: obj.required });
}
function model(value: unknown, where: string): LibraryModel {
  const obj = object(value, where, ['id', 'ecosystem', 'package', 'target', 'invoke', 'returnRole', 'effect', 'arguments', 'reference', 'presentation', 'metricRegistry', 'textWrite', 'checks']);
  if (obj.ecosystem !== 'node' && obj.ecosystem !== 'go') throw new Error(`${where}.ecosystem: unknown ecosystem`);
  if (obj.invoke !== 'call' && obj.invoke !== 'construct' && obj.invoke !== 'read') throw new Error(`${where}.invoke: unknown invocation`);
  const checks = object(obj.checks, `${where}.checks`, ['positive', 'negative']);
  const args = list(obj.arguments, `${where}.arguments`, argument);
  unique(args.map((arg) => arg.name), `${where}.arguments`);
  if (obj.effect === undefined && obj.returnRole === undefined) throw new Error(`${where}: model has no effect or return role`);
  const presentation = obj.presentation === undefined ? undefined : object(obj.presentation, `${where}.presentation`, ['library', 'json', 'formatArgument']);
  if (presentation !== undefined) {
    string(presentation.library, `${where}.presentation.library`);
    if (presentation.json !== undefined && typeof presentation.json !== 'boolean') throw new Error(`${where}.presentation.json: expected boolean`);
    if (presentation.formatArgument !== undefined && (typeof presentation.formatArgument !== 'string' || !args.some((arg) => arg.name === presentation.formatArgument))) throw new Error(`${where}.presentation.formatArgument: expected declared argument`);
  }
  const metricRegistry = obj.metricRegistry === undefined ? undefined : object(obj.metricRegistry, `${where}.metricRegistry`, ['defaultNamespace', 'defaultMember', 'defaultRegistry', 'defaultTarget', 'metricsFrom']);
  if (metricRegistry !== undefined) {
    if (metricRegistry.defaultNamespace !== undefined) string(metricRegistry.defaultNamespace, `${where}.metricRegistry.defaultNamespace`);
    for (const name of ['defaultMember', 'defaultRegistry', 'defaultTarget']) {
      if (metricRegistry[name] !== undefined && typeof metricRegistry[name] !== 'boolean') throw new Error(`${where}.metricRegistry.${name}: expected boolean`);
    }
    if (metricRegistry.metricsFrom !== undefined && (typeof metricRegistry.metricsFrom !== 'number' || !Number.isSafeInteger(metricRegistry.metricsFrom) || metricRegistry.metricsFrom < 0)) throw new Error(`${where}.metricRegistry.metricsFrom: expected nonnegative integer`);
    if (Object.keys(metricRegistry).length === 0) throw new Error(`${where}.metricRegistry: empty metadata`);
    if (metricRegistry.defaultMember !== undefined && obj.effect !== 'metric-declare') throw new Error(`${where}.metricRegistry.defaultMember: requires metric declaration`);
    if (metricRegistry.defaultRegistry !== undefined && obj.returnRole !== 'metric-registry') throw new Error(`${where}.metricRegistry.defaultRegistry: requires registry role`);
    if ((metricRegistry.defaultTarget !== undefined || metricRegistry.metricsFrom !== undefined) && obj.effect !== 'metric-register' && obj.effect !== 'metric-expose') throw new Error(`${where}.metricRegistry: requires registry effect`);
    if (metricRegistry.metricsFrom !== undefined && obj.effect !== 'metric-register') throw new Error(`${where}.metricRegistry.metricsFrom: requires registration`);
  }
  const textWrite = obj.textWrite === undefined ? undefined : object(obj.textWrite, `${where}.textWrite`, ['format', 'argumentsFrom']);
  if (textWrite !== undefined) {
    if (obj.effect !== 'metric-text-write' || obj.invoke !== 'call') throw new Error(`${where}.textWrite: requires text-write call`);
    if (textWrite.format !== 'plain' && textWrite.format !== 'printf') throw new Error(`${where}.textWrite.format: unknown format`);
    if (typeof textWrite.argumentsFrom !== 'number' || !Number.isSafeInteger(textWrite.argumentsFrom) || textWrite.argumentsFrom < 0) throw new Error(`${where}.textWrite.argumentsFrom: expected nonnegative integer`);
    if (!args.some((arg) => arg.name === 'writer' && arg.required) || !args.some((arg) => arg.name === 'text' && arg.required)) throw new Error(`${where}.textWrite: requires writer and text selectors`);
  }
  if (obj.effect === 'metric-text-write' && textWrite === undefined) throw new Error(`${where}.textWrite: missing text-write metadata`);
  const selectedTarget = target(obj.target, `${where}.target`);
  if (selectedTarget.kind === 'member' && selectedTarget.member === '*' && obj.invoke !== 'read') throw new Error(`${where}: wildcard only selects static property reads`);
  if (obj.invoke === 'read' && args.length > 0) throw new Error(`${where}: read cannot select call arguments`);
  return Object.freeze({ id: string(obj.id, `${where}.id`), ecosystem: obj.ecosystem,
    package: string(obj.package, `${where}.package`), target: selectedTarget, invoke: obj.invoke,
    ...(obj.returnRole === undefined ? {} : { returnRole: role(obj.returnRole, `${where}.returnRole`) }),
    ...(obj.effect === undefined ? {} : { effect: effect(obj.effect, `${where}.effect`) }), arguments: args,
    reference: string(obj.reference, `${where}.reference`),
    ...(metricRegistry === undefined ? {} : { metricRegistry: Object.freeze({
      ...(typeof metricRegistry.defaultNamespace === 'string' ? { defaultNamespace: metricRegistry.defaultNamespace } : {}),
      ...(typeof metricRegistry.defaultMember === 'boolean' ? { defaultMember: metricRegistry.defaultMember } : {}),
      ...(typeof metricRegistry.defaultRegistry === 'boolean' ? { defaultRegistry: metricRegistry.defaultRegistry } : {}),
      ...(typeof metricRegistry.defaultTarget === 'boolean' ? { defaultTarget: metricRegistry.defaultTarget } : {}),
      ...(typeof metricRegistry.metricsFrom === 'number' ? { metricsFrom: metricRegistry.metricsFrom } : {}) }) }),
    ...(textWrite === undefined ? {} : { textWrite: Object.freeze({ format: textWrite.format as 'plain' | 'printf', argumentsFrom: textWrite.argumentsFrom as number }) }),
    ...(presentation === undefined ? {} : { presentation: Object.freeze({ library: string(presentation.library, `${where}.presentation.library`),
      ...(typeof presentation.json === 'boolean' ? { json: presentation.json } : {}),
      ...(typeof presentation.formatArgument === 'string' ? { formatArgument: presentation.formatArgument } : {}) }) }),
    checks: Object.freeze({ positive: string(checks.positive, `${where}.checks.positive`), negative: string(checks.negative, `${where}.checks.negative`) }) });
}

function typeModel(value: unknown, where: string): LibraryTypeModel {
  const obj = object(value, where, ['id', 'ecosystem', 'package', 'exportedPath', 'shape', 'reference', 'checks']);
  if (obj.ecosystem !== 'go') throw new Error(`${where}.ecosystem: unsupported type ecosystem`);
  if (obj.shape !== 'struct') throw new Error(`${where}.shape: unsupported type shape`);
  const exportedPath = list(obj.exportedPath, `${where}.exportedPath`, string);
  if (exportedPath.length === 0) throw new Error(`${where}.exportedPath: empty type selector`);
  const checks = object(obj.checks, `${where}.checks`, ['positive', 'negative']);
  const reference = string(obj.reference, `${where}.reference`);
  let address: URL;
  try { address = new URL(reference); } catch { throw new Error(`${where}.reference: expected absolute HTTPS documentation URL`); }
  if (address.protocol !== 'https:' || address.hostname === '' || address.username !== '' || address.password !== '') throw new Error(`${where}.reference: expected absolute HTTPS documentation URL`);
  return Object.freeze({ id: string(obj.id, `${where}.id`), ecosystem: 'go', package: string(obj.package, `${where}.package`),
    exportedPath, shape: 'struct', reference,
    checks: Object.freeze({ positive: string(checks.positive, `${where}.checks.positive`), negative: string(checks.negative, `${where}.checks.negative`) }) });
}

export function validateLibraryRegistry(value: unknown): LibraryRegistry {
  const obj = object(value, 'registry', ['schemaVersion', 'models', 'types']);
  if (obj.schemaVersion !== 1) throw new Error('registry.schemaVersion: unsupported version');
  const models = list(obj.models, 'registry.models', model);
  unique(models.map((entry) => entry.id), 'registry.models.id');
  const types = obj.types === undefined ? [] : list(obj.types, 'registry.types', typeModel);
  unique([...models, ...types].map((entry) => entry.id), 'registry.ids');
  unique([...models, ...types].flatMap((entry) => [entry.checks.positive, entry.checks.negative]), 'registry.checks');
  unique(types.map((entry) => JSON.stringify([entry.ecosystem, entry.package, entry.exportedPath])), 'registry.types.selectors');
  const selectors = new Set<string>();
  const wildcardReads = new Set(models.flatMap((entry) => entry.invoke === 'read' && entry.target.kind === 'member' && entry.target.member === '*'
    ? [JSON.stringify([entry.ecosystem, entry.package, entry.target.receiverRole])] : []));
  const providers = new Set(models.flatMap((entry) => entry.returnRole === undefined ? [] : [`${entry.ecosystem}:${entry.package}:${entry.returnRole}`]));
  for (const entry of models) {
    const prefix = [entry.ecosystem, entry.package, entry.invoke];
    const signatures = entry.target.kind === 'member'
      ? [JSON.stringify([...prefix, 'member', entry.target.receiverRole, entry.target.member])]
      : entry.target.importRoles.flatMap((form) => entry.target.kind === 'export' ? entry.target.exportedPaths.map((path) => JSON.stringify([...prefix, 'export', form, path])) : []);
    for (const signature of signatures) {
      if (selectors.has(signature)) throw new Error(`registry.models.${entry.id}: conflicting selector`);
      selectors.add(signature);
    }
    if (entry.invoke === 'read' && entry.target.kind === 'member' && entry.target.member !== '*' && wildcardReads.has(JSON.stringify([entry.ecosystem, entry.package, entry.target.receiverRole]))) throw new Error(`registry.models.${entry.id}: wildcard conflicts with exact read selector`);
    if (entry.target.kind === 'member' && !providers.has(`${entry.ecosystem}:${entry.package}:${entry.target.receiverRole}`)) throw new Error(`registry.models.${entry.id}: receiver role has no provider`);
  }
  return Object.freeze({ schemaVersion: 1, models: Object.freeze([...models].sort((a, b) => byCodePoint(a.id, b.id))), types: Object.freeze([...types].sort((a, b) => byCodePoint(a.id, b.id))) });
}

/** JSON keys use code-point order; arrays retain declared semantic order. */
export function canonicalLibraryModels(value: unknown): string {
  const registry = validateLibraryRegistry(value);
  const encode = (entry: unknown): string => {
    if (entry === null || typeof entry !== 'object') {
      const encoded = JSON.stringify(entry);
      if (encoded === undefined) throw new Error('registry: non-JSON value');
      return encoded;
    }
    if (Array.isArray(entry)) return `[${entry.map(encode).join(',')}]`;
    return `{${Object.entries(entry).sort(([a], [b]) => byCodePoint(a, b)).map(([key, item]) => `${JSON.stringify(key)}:${encode(item)}`).join(',')}}`;
  };
  return encode(registry);
}
export function libraryRegistryDigest(value: unknown): string {
  return createHash('sha256').update(canonicalLibraryModels(value)).digest('hex');
}
export const libraryRegistry = validateLibraryRegistry(data);
export const libraryModelDigest = libraryRegistryDigest(libraryRegistry);
