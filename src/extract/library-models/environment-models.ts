/** Closed environment-to-storage semantics. Source readers never own a variable catalog. */
import {createHash} from 'node:crypto';
import source from './environment-models.json' with { type: 'text' };
import {byCodePoint} from '../../model/order.js';

export interface EnvironmentModel {
  readonly id: string;
  readonly variable: string;
  readonly effect: 'database-connection';
  readonly reference: string;
}

function object(value: unknown, where: string, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${where}: expected object`);
  for (const key of Object.keys(value)) if (!keys.includes(key)) throw new Error(`${where}.${key}: unknown field`);
  return value as Record<string, unknown>;
}
function string(value: unknown, where: string): string {
  if (typeof value !== 'string' || value === '' || value.trim() !== value || [...value].some(character => character.codePointAt(0)! < 32)) throw new Error(`${where}: expected exact nonempty string`);
  return value;
}

/** Rebuild and freeze every record before either interpretation or hashing. */
export function validateEnvironmentModels(value: unknown): readonly EnvironmentModel[] {
  const registry = object(value, 'environment-models', ['schemaVersion', 'models']);
  if (registry.schemaVersion !== 1) throw new Error('environment-models.schemaVersion: unsupported version');
  if (!Array.isArray(registry.models) || registry.models.length === 0) throw new Error('environment-models.models: expected nonempty array');
  const models = registry.models.map((entry: unknown, index: number): EnvironmentModel => {
    const where = `environment-models.models[${index}]`;
    const obj = object(entry, where, ['id', 'variable', 'effect', 'reference']);
    const variable = string(obj.variable, `${where}.variable`);
    const first = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ_'; const rest = `${first}0123456789`;
    if (!first.includes(variable[0]!) || [...variable].some(character => !rest.includes(character))) throw new Error(`${where}.variable: expected environment identifier`);
    if (obj.effect !== 'database-connection') throw new Error(`${where}.effect: unknown effect`);
    const reference = string(obj.reference, `${where}.reference`);
    let url: URL;
    try { url = new URL(reference); } catch { throw new Error(`${where}.reference: expected absolute HTTPS documentation URL`); }
    if (url.protocol !== 'https:' || url.hostname === '' || url.username !== '' || url.password !== '') throw new Error(`${where}.reference: expected absolute HTTPS documentation URL`);
    return Object.freeze({id: string(obj.id, `${where}.id`), variable, effect: 'database-connection', reference});
  });
  if (new Set(models.map(model => model.id)).size !== models.length) throw new Error('environment-models.models: duplicate model id');
  if (new Set(models.map(model => model.variable)).size !== models.length) throw new Error('environment-models.models: conflicting variable selector');
  return Object.freeze(models.sort((left, right) => byCodePoint(left.id, right.id)));
}

export const environmentModels = validateEnvironmentModels(JSON.parse(source as unknown as string));
// Validated records have a fixed field order; model order is code-point canonical.
export const environmentModelDigest = createHash('sha256').update(JSON.stringify({schemaVersion: 1, models: environmentModels})).digest('hex');
