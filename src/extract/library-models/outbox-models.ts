/** Closed SQL receiver identities and outbox semantics. No method-name fallback. */
import {createHash} from 'node:crypto';
import source from './outbox-models.json';
export interface OutboxReceiverModel {
  readonly id: string; readonly ecosystem: 'go'; readonly package: string; readonly packageName: string;
  readonly exportedPath: readonly string[]; readonly pointer: boolean; readonly reference: string;
}
export interface OutboxOperationModel {
  readonly id: string; readonly receiverIds: readonly string[]; readonly member: string;
  readonly sql: number; readonly values: number; readonly reference: string;
}
export interface OutboxModels {
  readonly outbox: {readonly table: string; readonly topicColumn: string};
  readonly receivers: readonly OutboxReceiverModel[]; readonly operations: readonly OutboxOperationModel[];
  readonly scan: {readonly member: string; readonly receiver: 'query-result'; readonly arguments: 'destinations'};
  readonly append: {readonly ecosystem: 'go'; readonly builtin: string; readonly collection: number; readonly element: number};
  readonly factories: readonly {readonly member: string; readonly receiverIds: readonly string[]; readonly returns: string; readonly reference: string}[];
}
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('outbox model: expected object');
  for (const key of Object.keys(value)) if (!keys.includes(key)) throw new Error(`outbox model: unknown field ${key}`);
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  if (typeof value !== 'string' || value === '' || value.trim() !== value || [...value].some(character => character.codePointAt(0)! < 32)) throw new Error('outbox model: invalid exact string');
  return value;
}
function reference(value: unknown): string {
  const result = text(value); const url = new URL(result);
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') throw new Error('outbox model: invalid reference');
  return result;
}
function entries(value: unknown): unknown[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error('outbox model: expected nonempty array');
  return value;
}
function unique(values: readonly string[]): void {if (new Set(values).size !== values.length) throw new Error('outbox model: duplicate entry');}
function ordinal(value: unknown): number {if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error('outbox model: invalid argument index'); return value;}
export function validateOutboxModels(value: unknown): OutboxModels {
  const root = object(value, ['schemaVersion', 'outbox', 'receivers', 'operations', 'scan', 'append', 'factories']);
  if (root.schemaVersion !== 1) throw new Error('outbox model: invalid schema');
  const semantics = object(root.outbox, ['table', 'topicColumn']);
  const receivers = entries(root.receivers).map((entry): OutboxReceiverModel => {
    const model = object(entry, ['id', 'ecosystem', 'package', 'packageName', 'exportedPath', 'pointer', 'reference']);
    if (model.ecosystem !== 'go' || typeof model.pointer !== 'boolean') throw new Error('outbox model: invalid receiver');
    const path = entries(model.exportedPath).map(text); unique(path);
    return Object.freeze({id: text(model.id), ecosystem: model.ecosystem, package: text(model.package), packageName: text(model.packageName), exportedPath: Object.freeze(path), pointer: model.pointer, reference: reference(model.reference)});
  });
  unique(receivers.map(model => model.id)); unique(receivers.map(model => JSON.stringify([model.package, model.exportedPath, model.pointer])));
  const operations = entries(root.operations).map((entry): OutboxOperationModel => {
    const model = object(entry, ['id', 'receiverIds', 'member', 'sql', 'values', 'reference']);
    const receiverIds = entries(model.receiverIds).map(text); unique(receiverIds);
    if (receiverIds.some(id => !receivers.some(receiver => receiver.id === id))) throw new Error('outbox model: unknown receiver identity');
    const sql = ordinal(model.sql); const values = ordinal(model.values);
    if (values !== sql + 1) throw new Error('outbox model: values must follow the SQL argument');
    return Object.freeze({id: text(model.id), receiverIds: Object.freeze(receiverIds), member: text(model.member), sql, values, reference: reference(model.reference)});
  });
  unique(operations.map(model => model.id));
  unique(operations.flatMap(model => model.receiverIds.map(receiver => JSON.stringify([receiver, model.member]))));
  const scan = object(root.scan, ['member', 'receiver', 'arguments']);
  if (scan.receiver !== 'query-result' || scan.arguments !== 'destinations') throw new Error('outbox model: invalid scan');
  const append = object(root.append, ['ecosystem', 'builtin', 'collection', 'element']);
  if (append.ecosystem !== 'go') throw new Error('outbox model: invalid builtin ecosystem');
  const factories = entries(root.factories).map(entry => {
    const model = object(entry, ['member', 'receiverIds', 'returns', 'reference']);
    const receiverIds = entries(model.receiverIds).map(text); unique(receiverIds); const returns = text(model.returns);
    if ([...receiverIds, returns].some(id => !receivers.some(receiver => receiver.id === id))) throw new Error('outbox model: unknown factory receiver');
    return Object.freeze({member: text(model.member), receiverIds: Object.freeze(receiverIds), returns, reference: reference(model.reference)});
  });
  unique(factories.flatMap(model => model.receiverIds.map(receiver => JSON.stringify([receiver, model.member]))));
  return Object.freeze({scan: Object.freeze({member: text(scan.member), receiver: scan.receiver, arguments: scan.arguments}), append: Object.freeze({ecosystem: append.ecosystem, builtin: text(append.builtin), collection: ordinal(append.collection), element: ordinal(append.element)}), factories: Object.freeze(factories), outbox: Object.freeze({table: text(semantics.table), topicColumn: text(semantics.topicColumn)}), receivers: Object.freeze(receivers), operations: Object.freeze(operations)});
}
export const outboxModels = validateOutboxModels(source);
export const outboxModelDigest = createHash('sha256').update(JSON.stringify(outboxModels)).digest('hex');
