/** Catalogue value validation shared by doors and the writer (0039 items 3, 7 and 30). */
import type { FieldContract } from './contract.js';

export interface GraphRefusalBody {
  readonly code: 'SCHEMA_INVALID';
  readonly path: string;
  readonly expected: string;
  readonly actual: unknown;
  readonly retryable: false;
}

export class GraphRefusal extends Error implements GraphRefusalBody {
  readonly code = 'SCHEMA_INVALID';
  readonly retryable = false;
  constructor(readonly path: string, readonly expected: string, readonly actual: unknown) {
    super(`${import.meta.path}:1: ${path}: expected ${expected}, got ${JSON.stringify(actual)}`);
  }
  toJSON(): GraphRefusalBody {
    return { code: this.code, path: this.path, expected: this.expected, actual: this.actual, retryable: this.retryable };
  }
}

/** RFC 6901 field path, not a dotted field name. */
export function fieldPath(parent: string, field: string): string {
  return `${parent}/${field.replaceAll('~', '~0').replaceAll('/', '~1')}`;
}

function decimal(value: unknown): boolean {
  if (typeof value === 'number') return Number.isSafeInteger(value);
  if (typeof value !== 'string' || value === '') return false;
  const digits = value.startsWith('-') ? value.slice(1) : value;
  return digits.length > 0 && [...digits].every(char => char >= '0' && char <= '9');
}

/** The storage type's range is part of its input contract; SQL must not coerce a bad answer. */
export function fits(field: FieldContract, value: unknown): boolean {
  if (value === null) return field.nullable === true;
  if (field.reference !== undefined) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
    const ref = value as Record<string, unknown>;
    return ref['kind'] === field.reference && ref['key'] !== null && typeof ref['key'] === 'object' && !Array.isArray(ref['key']);
  }
  switch (field.type) {
    case 'text': return typeof value === 'string';
    case 'integer': return typeof value === 'number' && Number.isInteger(value) && value >= -2147483648 && value <= 2147483647;
    case 'bigint': return decimal(value) && BigInt(value as string | number) >= -9223372036854775808n && BigInt(value as string | number) <= 9223372036854775807n;
    case 'boolean': return typeof value === 'boolean';
    case 'timestamp': return typeof value === 'string' && value.includes('T') && Number.isFinite(Date.parse(value));
    case 'json': return jsonValue(value);
  }
}

function jsonValue(value: unknown): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(jsonValue);
  return typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype && Object.values(value).every(jsonValue);
}

export function validateFields(fields: readonly FieldContract[], values: Readonly<Record<string, unknown>>, path: string): void {
  for (const [name, value] of Object.entries(values)) {
    const field = fields.find(field => field.name === name);
    if (field === undefined) throw new GraphRefusal(fieldPath(path, name), `declared field (${fields.map(field => field.name).join(', ')})`, value);
    if (!fits(field, value)) throw new GraphRefusal(fieldPath(path, name), field.reference === undefined ? field.type : `reference:${field.reference}`, value);
  }
}
