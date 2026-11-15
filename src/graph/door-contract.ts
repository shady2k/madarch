/** Catalogue-generated request contracts, shared by MCP and HTTP (0039 items 7 and 30). */
import { z } from 'zod';
import type { FieldContract, GraphContract, VertexContract } from './contract.js';
import { fits, GraphRefusal } from './validation.js';

export const text = z.string().min(1);
const words = z.string().optional();
const instant = z.iso.datetime({ offset: true });
const evidenceTags = z.strictObject({ file: z.unknown(), conversation: z.unknown(), url: z.unknown(), commit: z.unknown(), blob: z.unknown() }).keyof().enum;
const fileEvidence = z.strictObject({ type: z.literal('file').optional(), repository: text.optional(), path: text, commit: text.optional(), blob: text.optional(), lineStart: z.int().min(1), lineEnd: z.int().min(1).optional() }).refine(value => value.commit !== undefined || value.blob !== undefined, { path: ['commit'], message: 'commit or blob' }).meta({ anyOf: [{ required: ['commit'] }, { required: [evidenceTags.blob] }] }).refine(value => value.lineEnd === undefined || value.lineEnd >= value.lineStart, { path: ['lineEnd'], message: 'lineEnd >= lineStart' });
export const evidence = z.array(z.union([
  fileEvidence,
  z.strictObject({ type: z.literal('conversation'), id: text, at: instant.optional(), speaker: z.string().optional(), words: text }),
  z.strictObject({ type: z.literal(evidenceTags.url), url: z.url().refine(value => { const protocol = new URL(value).protocol; return protocol === 'http:' || protocol === 'https:'; }, 'http or https URL').meta({ pattern: '^https?://' }), at: instant }),
])).min(1);

/** The generated JSON Schema and runtime parser come from this same declaration. */
export function parseRequest<T extends z.ZodType>(schema: T, input: unknown): z.infer<T> {
  if (schema instanceof z.ZodUnion && input !== null && typeof input === 'object' && !Array.isArray(input)) {
    const held = input as Record<string, unknown>;
    const options = schema.options as z.ZodType[];
    const selected = options.find(option => {
      if (!(option instanceof z.ZodObject)) return false;
      const shape = option.shape;
      const tags = Object.entries(shape).filter(([, type]) => type instanceof z.ZodLiteral);
      return tags.length > 0 ? tags.some(([key, type]) => type.safeParse(held[key]).success)
        : Object.keys(shape).some(key => key in held && shape[key] instanceof z.ZodUnion);
    });
    if (selected !== undefined) return parseRequest(selected, input) as z.infer<T>;
  }
  const parsed = schema.safeParse(input);
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues.find(issue => issue.code === 'unrecognized_keys') ?? parsed.error.issues[0]!;
  const parts = [...issue.path];
  if (issue.code === 'unrecognized_keys') parts.push(issue.keys[0]!);
  let actual = input;
  for (const part of parts) actual = actual !== null && typeof actual === 'object' ? (actual as Record<PropertyKey, unknown>)[part] : undefined;
  const path = parts.map(part => `/${String(part).replaceAll('~', '~0').replaceAll('/', '~1')}`).join('');
  throw new GraphRefusal(path, issue.message, actual === undefined ? null : actual);
}

export function inputSchema(schema: z.ZodType): Record<string, unknown> {
  return z.toJSONSchema(schema, { io: 'input' });
}

/** JSON Schema has no numeric bound for decimal strings; express each permitted prefix explicitly. */
function boundedDecimalPattern(bound: string): string {
  const shorter = Array.from({ length: bound.length - 1 }, (_, at) => at === 0 ? '[0-9]' : `[1-9][0-9]{${String(at)}}`);
  const prefixes: string[] = [];
  for (let at = 0; at < bound.length; at++) {
    const lower = at === 0 ? 1 : 0;
    const upper = Number(bound[at]) - 1;
    if (upper < lower) continue;
    prefixes.push(`${bound.slice(0, at)}[${String(lower)}-${String(upper)}][0-9]{${String(bound.length - at - 1)}}`);
  }
  return [...shorter, ...prefixes, bound].join('|');
}
const bigintPattern = `^(?:0*(${boundedDecimalPattern('9223372036854775807')})|-0*(${boundedDecimalPattern('9223372036854775808')}))$`;

function alternatives(schemas: z.ZodType[]): z.ZodType {
  return schemas.length === 0 ? z.never() : schemas.length === 1 ? schemas[0]! : z.union(schemas);
}

export function catalogueRequests(contract: GraphContract) {
  const keys = new Map<string, z.ZodType>();
  const keyOf = (kind: VertexContract): z.ZodType => {
    const held = keys.get(kind.name);
    if (held !== undefined) return held;
    const key = z.lazy(() => fields(kind.fields.filter(field => kind.key.includes(field.name)), true));
    keys.set(kind.name, key);
    return key;
  };
  const fieldType = (field: FieldContract): z.ZodType => {
    let schema: z.ZodType;
    if (field.reference !== undefined) {
      const target = contract.vertex.find(kind => kind.name === field.reference);
      schema = target === undefined ? z.never() : z.strictObject({ kind: z.literal(field.reference), key: keyOf(target) });
    } else {
      switch (field.type) {
        case 'text': schema = z.string(); break;
        case 'integer': schema = z.int32(); break;
        case 'bigint': schema = z.union([z.int().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER), z.string().refine(value => fits(field, value), 'signed 64-bit integer').meta({ pattern: bigintPattern })]); break;
        case 'boolean': schema = z.boolean(); break;
        case 'timestamp': schema = instant; break;
        case 'json': schema = z.json(); break;
      }
    }
    return field.nullable === true ? schema.nullable() : schema;
  };
  function fields(declared: readonly FieldContract[], required: boolean): z.ZodType {
    return z.strictObject(Object.fromEntries(declared.map(field => [field.name, required && field.nullable !== true ? fieldType(field) : fieldType(field).optional()])));
  }
  const end = (allowed: readonly string[]): z.ZodType => alternatives(contract.vertex.filter(kind => allowed.includes('any') || allowed.includes(kind.name)).map(kind => z.union([
    z.strictObject({ kind: z.literal(kind.name === 'manifest.kind' ? 'catalogue' : kind.name), key: keyOf(kind) }),
    z.strictObject({ kind: z.literal(kind.name === 'manifest.kind' ? 'catalogue' : kind.name), id: z.uuid() }),
  ])));
  const vertices = contract.vertex.map(kind => {
    const attributes = kind.fields.filter(field => !kind.key.includes(field.name));
    const identity = { kind: z.literal(kind.name), key: keyOf(kind).optional(), id: z.uuid().optional() };
    const identified = (value: { key?: unknown; id?: unknown }) => kind.key.length === 0 || value.key !== undefined || value.id !== undefined;
    return {
      put: z.strictObject({ ...identity, values: fields(attributes, false).refine(value => Object.keys(value as object).length > 0, 'at least one declared field').meta({ minProperties: 1 }), evidence, words }).refine(identified, { path: ['key'], message: 'key or id' }).meta(kind.key.length === 0 ? {} : { anyOf: [{ required: ['key'] }, { required: ['id'] }] }),
      retract: z.strictObject({ ...identity, fields: z.array(z.enum(attributes.map(field => field.name))).min(1).optional() }).refine(identified, { path: ['key'], message: 'key or id' }).meta(kind.key.length === 0 ? {} : { anyOf: [{ required: ['key'] }, { required: ['id'] }] }),
      authored: (action: string) => z.strictObject({ uid: text.optional(), values: action === 'create' && kind.fields.some(field => field.nullable !== true) ? fields(kind.fields, true) : fields(kind.fields, action === 'create').optional(), words, ifRevision: text.optional(), recordUnchanged: z.boolean().optional() }),
      kind: kind.name,
    };
  });
  const edges = contract.edge.map(kind => {
    const shape = { kind: z.literal(kind.name), from: end(kind.from), to: end(kind.to), ...(kind.repeats ? { discriminator: text } : {}) };
    return { put: z.strictObject({ ...shape, values: fields(kind.fields, false).optional(), evidence, words }), retract: z.strictObject(shape) };
  });
  return {
    put_entity: alternatives(vertices.map(kind => kind.put)),
    put_edge: alternatives(edges.map(kind => kind.put)),
    retract: z.union([
      z.strictObject({ entity: alternatives(vertices.map(kind => kind.retract)), evidence, words }),
      z.strictObject({ edge: alternatives(edges.map(kind => kind.retract)), evidence, words }),
    ]),
    authored(kind: string, action: string): z.ZodType {
      const held = vertices.find(vertex => vertex.kind === kind);
      if (held === undefined) throw new GraphRefusal('/kind', 'declared kind', kind);
      return held.authored(action);
    },
    kinds: z.enum(contract.vertex.map(kind => kind.name)),
  };
}

/** Kind-independent tools use closed envelopes; GraphQL validates its operation against the catalogue SDL. */
export const readRequests = {
  graph_schema: z.strictObject({}),
  graph_query: z.strictObject({ query: text, variables: z.record(z.string(), z.json()).nullable().optional(), operationName: text.nullable().optional(), lang: text.optional() }),
  render_diagram: z.strictObject({ entity: text, format: z.enum(['likec4', 'mermaid', 'archify']).optional(), depth: z.literal(1).optional(), aggregateAbove: z.int().min(1).optional(), lang: text.optional() }),
};
