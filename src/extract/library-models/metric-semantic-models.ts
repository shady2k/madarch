/** Closed external type and receiver effects used by structural metric joins. */
import { createHash } from 'node:crypto';
import source from './metric-semantic-models.json' with { type: 'text' };
import { byCodePoint } from '../../model/order.js';

export interface MetricReceiverOperation { readonly member: string; readonly arguments: number }
export type MetricSemanticModel = {
  readonly id: string; readonly ecosystem: 'go'; readonly package: string;
  readonly exportedPath: readonly string[]; readonly reference: string;
} & ({ readonly role: 'http-response-writer' } | {
  readonly role: 'metric-cell'; readonly reads: readonly MetricReceiverOperation[]; readonly writes: readonly MetricReceiverOperation[];
});
function object(value: unknown, where: string, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${where}: expected object`);
  for (const key of Object.keys(value)) if (!keys.includes(key)) throw new Error(`${where}.${key}: unknown field`);
  return value as Record<string, unknown>;
}
function string(value: unknown, where: string): string {
  if (typeof value !== 'string' || value === '' || value.trim() !== value || [...value].some((character) => character.codePointAt(0)! < 32)) throw new Error(`${where}: expected exact nonempty string`);
  return value;
}
function list<T>(value: unknown, where: string, read: (entry: unknown, at: string) => T): readonly T[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${where}: expected nonempty array`);
  const result = value.map((entry, index) => read(entry, `${where}[${index}]`));
  if (new Set(result.map((entry) => JSON.stringify(entry))).size !== result.length) throw new Error(`${where}: duplicate selector`);
  return Object.freeze(result);
}
function operations(value: unknown, where: string): readonly MetricReceiverOperation[] {
  const result = list(value, where, (entry, at) => {
    const obj = object(entry, at, ['member', 'arguments']);
    if (typeof obj.arguments !== 'number' || !Number.isSafeInteger(obj.arguments) || obj.arguments < 0) throw new Error(`${at}.arguments: invalid argument count`);
    return Object.freeze({ member: string(obj.member, `${at}.member`), arguments: obj.arguments });
  });
  if (new Set(result.map((entry) => entry.member)).size !== result.length) throw new Error(`${where}: duplicate member`);
  return result;
}
export function validateMetricSemanticModels(value: unknown): readonly MetricSemanticModel[] {
  const registry = object(value, 'metric-semantic-models', ['schemaVersion', 'models']);
  if (registry.schemaVersion !== 1) throw new Error('metric-semantic-models.schemaVersion: unsupported version');
  const models = list(registry.models, 'metric-semantic-models.models', (entry, where): MetricSemanticModel => {
    const obj = object(entry, where, ['id', 'ecosystem', 'package', 'exportedPath', 'role', 'reads', 'writes', 'reference']);
    if (obj.ecosystem !== 'go') throw new Error(`${where}.ecosystem: unsupported ecosystem`);
    const common = { id: string(obj.id, `${where}.id`), ecosystem: 'go' as const, package: string(obj.package, `${where}.package`),
      exportedPath: list(obj.exportedPath, `${where}.exportedPath`, string), reference: string(obj.reference, `${where}.reference`) };
    if (obj.role === 'http-response-writer') {
      object(entry, where, ['id', 'ecosystem', 'package', 'exportedPath', 'role', 'reference']);
      return Object.freeze({ ...common, role: 'http-response-writer' });
    }
    if (obj.role !== 'metric-cell') throw new Error(`${where}.role: unknown role`);
    const reads = operations(obj.reads, `${where}.reads`); const writes = operations(obj.writes, `${where}.writes`);
    if (reads.some((read) => writes.some((write) => write.member === read.member))) throw new Error(`${where}: overlapping read/write member`);
    return Object.freeze({ ...common, role: 'metric-cell', reads, writes });
  });
  if (new Set(models.map((model) => model.id)).size !== models.length) throw new Error('metric-semantic-models.models: duplicate model id');
  if (new Set(models.map((model) => JSON.stringify([model.ecosystem, model.package, model.exportedPath]))).size !== models.length) throw new Error('metric-semantic-models.models: duplicate type origin');
  return Object.freeze([...models].sort((a, b) => byCodePoint(a.id, b.id)));
}
export const metricSemanticModels = validateMetricSemanticModels(JSON.parse(source as unknown as string));
export const metricSemanticModelDigest = createHash('sha256').update(JSON.stringify(metricSemanticModels)).digest('hex');
