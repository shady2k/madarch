/** Shared value-type contracts and offline Draft 2020-12 validation (0039 items 3, 4, 29). */
import Ajv2020, { type AnySchema, type ValidateFunction } from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { fieldTypeOf, type FieldType } from './contract.js';

export const JSON_DIALECT = 'https://json-schema.org/draft/2020-12/schema';
export type JsonSchema = Record<string, unknown>;
export interface ValueTypeDeclaration {
  readonly storage: FieldType;
  readonly schema: JsonSchema;
}
export type ValueTypes = Readonly<Record<string, ValueTypeDeclaration>>;

function validator(): Ajv2020 {
  const ajv = new Ajv2020({ strict: true, allErrors: true, validateFormats: true });
  addFormats(ajv);
  // Git stores remote values without transport validation (builtin/remote.c, add/set-url).
  // A recorded remote is a C string, not an RFC URI; Git config admits even an empty one.
  ajv.addFormat('git-remote', { type: 'string', validate: (value: string) => !value.includes('\0') });
  return ajv;
}
const compiled = new WeakMap<object, WeakMap<object, ValidateFunction>>();
const validators = new WeakMap<object, Ajv2020>();

const VOCABULARIES = new Set([
  'https://json-schema.org/draft/2020-12/vocab/core',
  'https://json-schema.org/draft/2020-12/vocab/applicator',
  'https://json-schema.org/draft/2020-12/vocab/unevaluated',
  'https://json-schema.org/draft/2020-12/vocab/validation',
  'https://json-schema.org/draft/2020-12/vocab/meta-data',
  'https://json-schema.org/draft/2020-12/vocab/format-annotation',
  'https://json-schema.org/draft/2020-12/vocab/format-assertion',
  'https://json-schema.org/draft/2020-12/vocab/content',
]);
/** Walk schema positions, never property names or literal annotation/const data. */
function walkSchema(schema: unknown, visit: (schema: Record<string, unknown>) => void): void {
  if (schema === null || typeof schema !== 'object' || Array.isArray(schema)) return;
  const held = schema as Record<string, unknown>;
  visit(held);
  for (const name of ['$defs', 'definitions', 'properties', 'patternProperties', 'dependentSchemas']) {
    const map = held[name];
    if (map !== null && typeof map === 'object' && !Array.isArray(map)) for (const child of Object.values(map)) walkSchema(child, visit);
  }
  for (const name of ['allOf', 'anyOf', 'oneOf', 'prefixItems']) {
    const list = held[name];
    if (Array.isArray(list)) for (const child of list) walkSchema(child, visit);
  }
  for (const name of ['items', 'contains', 'additionalProperties', 'unevaluatedProperties', 'unevaluatedItems', 'propertyNames', 'not', 'if', 'then', 'else', 'contentSchema']) walkSchema(held[name], visit);
}
function checkVocabularies(schema: unknown): void {
  walkSchema(schema, (held) => {
    const vocabulary = held['$vocabulary'];
    if (vocabulary === undefined) return;
    if (vocabulary === null || typeof vocabulary !== 'object' || Array.isArray(vocabulary)) throw new Error('$vocabulary is a mapping');
    for (const name of Object.keys(vocabulary)) if (!VOCABULARIES.has(name)) throw new Error(`unsupported vocabulary ${name}`);
  });
}
function forbidsInlinePattern(schema: unknown): void {
  walkSchema(schema, (held) => {
    if ('pattern' in held || 'patternProperties' in held) throw new Error('patterns belong in shared catalogue value types (0039 item 3)');
  });
}

/** No remote loader: every reference must resolve in the installed catalogue. */
export function compileValueSchema(schema: JsonSchema, types: ValueTypes = {}): ValidateFunction {
  checkVocabularies(schema);
  for (const type of Object.values(types)) checkVocabularies(type.schema);
  if (!Object.values(types).some((type) => type.schema === schema)) forbidsInlinePattern(schema);
  let ajv = validators.get(types);
  if (ajv === undefined) {
    ajv = validator();
    for (const type of Object.values(types)) ajv.addSchema(type.schema as AnySchema);
    validators.set(types, ajv);
  }
  return ajv.compile(schema as AnySchema);
}

export function checkValueTypes(types: ValueTypes): void {
  if (types === null || typeof types !== 'object' || Array.isArray(types)) throw new Error('value-types is a mapping');
  const ids = new Set<string>();
  for (const [name, type] of Object.entries(types)) {
    if (type === null || typeof type !== 'object') throw new Error(`value type ${name}: declaration is a mapping`);
    if (fieldTypeOf(type.storage) === undefined) throw new Error(`value type ${name}: unknown storage ${type.storage}`);
    if (type.schema?.['$schema'] !== JSON_DIALECT || typeof type.schema['$id'] !== 'string') throw new Error(`value type ${name}: schema declares Draft 2020-12 and an immutable $id`);
    const id = type.schema['$id'];
    if (ids.has(id)) throw new Error(`value type ${name}: duplicate schema id ${id}`);
    ids.add(id);
  }
  for (const type of Object.values(types)) compileValueSchema(type.schema, types);
}

/** Resolves root references against the installed offline value-type registry. */
export function resolveValueSchema(schema: JsonSchema, types: ValueTypes): JsonSchema | undefined {
  let current = schema;
  const seen = new Set<JsonSchema>();
  while (typeof current['$ref'] === 'string') {
    if (seen.has(current)) return undefined;
    seen.add(current);
    const installed = Object.values(types).find(type => type.schema['$id'] === current['$ref'])?.schema;
    if (installed === undefined) return undefined;
    current = installed;
  }
  return current;
}

/** Validates before SQL; format checks and refs are identical at installation and writing. */
export function fitsValueSchema(schema: JsonSchema, types: ValueTypes, value: unknown): boolean {
  let registry = compiled.get(types);
  if (registry === undefined) { registry = new WeakMap(); compiled.set(types, registry); }
  let check = registry.get(schema);
  if (check === undefined) { check = compileValueSchema(schema, types); registry.set(schema, check); }
  return check(value) as boolean;
}
