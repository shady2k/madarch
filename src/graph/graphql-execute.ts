/**
 * The GraphQL API's executor (decision 0036, sections 1, 4 and 5): one operation, one read-only snapshot transaction,
 * the schema derived from the product's published manifest, and the read layer's resolvers. Admission refuses a query
 * deeper than six levels before any read; the transaction's own deadline stops one that runs longer than two seconds.
 * A refused or stopped query returns no data and one error whose `extensions.code` names the limit.
 */
import { buildSchema, execute, getNamedType, GraphQLError, isInterfaceType, isObjectType, Kind, parse, validate, type GraphQLInterfaceType, type GraphQLScalarType, type GraphQLSchema, type DocumentNode, type FieldNode, type GraphQLNamedType, type OperationDefinitionNode, type SelectionSetNode } from 'graphql';
import type { DatabaseOwner } from '../adapters/database-owner.js';
import { sha256Hex } from './digest.js';
import type { KindsManifest } from '../product/manifest/kinds.js';
import { readPublishedManifest } from './manifest-publication.js';
import { publishedManifestOf } from '../graphql/manifest.js';
import { SchemaRefusal } from '../graphql/names.js';
import { ReadContext, entityOf } from './graphql-read.js';
import { graphqlSchemaOf } from '../graphql/schema.js';
import { readProductTemplates } from './product-templates.js';

/** The depth a query may reach, counting the root field as one (decision 0036, section 5). */
export const MAX_DEPTH = 6;
/** The deadline of one operation, in milliseconds. */
export const DEADLINE_MS = 2000;
/** The aliases one operation may hold (decision 0036, section 5). */
export const MAX_ALIASES = 50;
/** The nodes one operation may cost, the product of the `first`s along every connection on a path summed (section 5). */
export const MAX_NODES = 5000;
/** The largest response, in bytes (section 5). */
export const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

/** A refusal the API answers with no data and one coded error. */
export class GraphqlRefusal extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) {
    super(message);
  }
}

/** One operation a client sends. */
export interface GraphqlOperation {
  readonly query: string;
  readonly variables?: Readonly<Record<string, unknown>>;
  readonly operationName?: string | null;
  readonly lang?: string;
}

/** What the executor needs of the product it answers for. */
export interface GraphqlProduct {
  /** The published manifest, when the caller already holds it; left out, it is read inside the operation's snapshot. */
  readonly manifest?: KindsManifest;
  readonly folder: string;
}

/** The answer of one operation: the GraphQL result, and the HTTP status a route gives it. */
export interface GraphqlAnswer {
  readonly status: number;
  readonly body: MessageBody;
}

/** The GraphQL response shape: `data` only on success, one error on a refusal. */
export interface MessageBody {
  readonly data?: unknown;
  readonly errors?: readonly { message: string; extensions?: { code: string } }[];
}

/** The schemas derived so far, by their SDL: one build per manifest revision. */
const schemas = new Map<string, GraphQLSchema>();

/** The schema of one SDL, with the scalars' own serialisation and the interface's concrete types. */
function schemaOf(sdl: string): GraphQLSchema {
  const held = schemas.get(sdl);
  if (held !== undefined) return held;
  const schema = buildSchema(sdl);
  for (const [name, serialize] of [
    ['BigInt', (value: unknown) => (value === null || value === undefined ? null : String(value))],
    ['DateTime', (value: unknown) => (value === null || value === undefined ? null : value instanceof Date ? value.toISOString() : String(value))],
    ['JSON', (value: unknown) => value],
  ] as const) {
    const scalar = schema.getType(name) as GraphQLScalarType | undefined;
    if (scalar === undefined) continue;
    (scalar as unknown as { serialize: (value: unknown) => unknown }).serialize = serialize;
    (scalar as unknown as { parseValue: (value: unknown) => unknown }).parseValue = (value) => value;
  }
  const entity = schema.getType('Entity') as GraphQLInterfaceType | undefined;
  if (entity !== undefined) entity.resolveType = (value) => entityOf(value)?.typeName;
  schemas.set(sdl, schema);
  while (schemas.size > 8) schemas.delete(schemas.keys().next().value!);
  return schema;
}

/** The operation one request names, or the only one the document holds. */
function selectedOperation(document: DocumentNode, operationName: string | null | undefined): OperationDefinitionNode | undefined {
  const operations = document.definitions.filter((definition): definition is OperationDefinitionNode => definition.kind === Kind.OPERATION_DEFINITION);
  if (operationName === null || operationName === undefined) return operations.length === 1 ? operations[0] : undefined;
  return operations.find((operation) => operation.name?.value === operationName);
}

/** The largest field-chain depth of the selected operation, fragments inlined (decision 0036, section 5). */
export function queryDepth(document: DocumentNode, operationName?: string | null): number {
  const fragments = new Map<string, SelectionSetNode>();
  for (const definition of document.definitions) if (definition.kind === Kind.FRAGMENT_DEFINITION) fragments.set(definition.name.value, definition.selectionSet);
  const depthOf = (set: SelectionSetNode, seen: ReadonlySet<string>): number => {
    let max = 0;
    for (const selection of set.selections) {
      if (selection.kind === Kind.FIELD) {
        max = Math.max(max, 1 + (selection.selectionSet === undefined ? 0 : depthOf(selection.selectionSet, seen)));
      } else if (selection.kind === Kind.INLINE_FRAGMENT) {
        max = Math.max(max, depthOf(selection.selectionSet, seen));
      } else {
        const name = selection.name.value;
        const held = fragments.get(name);
        if (held === undefined || seen.has(name)) continue;
        max = Math.max(max, depthOf(held, new Set([...seen, name])));
      }
    }
    return max;
  };
  const operation = selectedOperation(document, operationName);
  const max = operation === undefined ? 0 : depthOf(operation.selectionSet, new Set<string>());
  // Depth counts the selections below the root's own set: one root field alone is depth 0, and a list's edges, its
  // nodes and their fields are three. Section 5's six then leaves a list of entities with a relation on each.
  return Math.max(0, max - 1);
}

/** The aliases the selected operation writes, fragments inlined once each. */
export function queryAliases(document: DocumentNode, operationName?: string | null): number {
  const fragments = new Map<string, SelectionSetNode>();
  for (const definition of document.definitions) if (definition.kind === Kind.FRAGMENT_DEFINITION) fragments.set(definition.name.value, definition.selectionSet);
  const countOf = (set: SelectionSetNode, seen: ReadonlySet<string>): number => {
    let total = 0;
    for (const selection of set.selections) {
      if (selection.kind === Kind.FIELD) {
        if (selection.alias !== undefined) total += 1;
        if (selection.selectionSet !== undefined) total += countOf(selection.selectionSet, seen);
      } else if (selection.kind === Kind.INLINE_FRAGMENT) {
        total += countOf(selection.selectionSet, seen);
      } else {
        const name = selection.name.value;
        const held = fragments.get(name);
        if (held === undefined || seen.has(name)) continue;
        total += countOf(held, new Set([...seen, name]));
      }
    }
    return total;
  };
  const operation = selectedOperation(document, operationName);
  return operation === undefined ? 0 : countOf(operation.selectionSet, new Set<string>());
}

/** A field's `first`, as the operation states it or a variable carries it; the default 50 when it states none. */
function firstOf(field: FieldNode, variables: Readonly<Record<string, unknown>> | undefined): number {
  const argument = field.arguments?.find((one) => one.name.value === 'first');
  if (argument === undefined) return 50;
  if (argument.value.kind === Kind.INT) return Math.min(Math.max(0, Number(argument.value.value)), 200);
  if (argument.value.kind === Kind.VARIABLE) {
    const held = variables?.[argument.value.name.value];
    if (typeof held === 'number' && Number.isFinite(held)) return Math.min(Math.max(0, Math.trunc(held)), 200);
  }
  return 50;
}

/** The named type a field answers, for following a selection into its own fields. */
function fieldTypeOf(parent: GraphQLNamedType | undefined, field: FieldNode): GraphQLNamedType | undefined {
  const fields = parent !== undefined && (isObjectType(parent) || isInterfaceType(parent)) ? parent.getFields() : undefined;
  const type = fields?.[field.name.value]?.type;
  return type === undefined ? undefined : getNamedType(type);
}

/**
 * The operation's cost (decision 0036, section 5): for every connection on a path, the product of the `first`s of
 * the connections above it, summed. A field that is no connection costs one; an opinions list or an aggregate's own
 * weight is not counted yet.
 */
export function queryCost(document: DocumentNode, schema: GraphQLSchema, variables?: Readonly<Record<string, unknown>>, operationName?: string | null): number {
  const fragments = new Map<string, SelectionSetNode>();
  const fragmentTypes = new Map<string, string | undefined>();
  for (const definition of document.definitions) {
    if (definition.kind !== Kind.FRAGMENT_DEFINITION) continue;
    fragments.set(definition.name.value, definition.selectionSet);
    fragmentTypes.set(definition.name.value, definition.typeCondition.name.value);
  }
  const typeOfName = (name: string | undefined): GraphQLNamedType | undefined => (name === undefined ? undefined : schema.getType(name));
  const costOf = (set: SelectionSetNode, parent: GraphQLNamedType | undefined, multiplier: number, seen: ReadonlySet<string>): number => {
    let total = 0;
    for (const selection of set.selections) {
      if (selection.kind === Kind.FIELD) {
        const type = fieldTypeOf(parent, selection);
        const connection = type !== undefined && type.name.endsWith('Connection');
        const first = connection ? firstOf(selection, variables) : 1;
        total += multiplier * first;
        if (selection.selectionSet !== undefined) total += costOf(selection.selectionSet, type, connection ? multiplier * first : multiplier, seen);
      } else if (selection.kind === Kind.INLINE_FRAGMENT) {
        total += costOf(selection.selectionSet, typeOfName(selection.typeCondition?.name.value) ?? parent, multiplier, seen);
      } else {
        const name = selection.name.value;
        const held = fragments.get(name);
        if (held === undefined || seen.has(name)) continue;
        total += costOf(held, typeOfName(fragmentTypes.get(name)) ?? parent, multiplier, new Set([...seen, name]));
      }
    }
    return total;
  };
  const operation = selectedOperation(document, operationName);
  if (operation === undefined) return 0;
  return costOf(operation.selectionSet, schema.getQueryType() ?? undefined, 1, new Set<string>());
}

/** The revision of the schema and every template: what a client refetches its bootstrap when it changes (section 6). */
export function structureRevisionOf(sdl: string, templates: readonly { name: string; body: string }[]): string {
  return sha256Hex(new TextEncoder().encode([sdl, ...templates.map((one) => `${one.name}\u0000${one.body}`)].join('\u0000')));
}

/** Whether a GraphQL error is PostgreSQL's statement timeout or a cancelled statement. */
function isStatementTimeout(error: GraphQLError): boolean {
  return /canceling statement due to statement timeout|cancelled statement|canceling statement due to user request/iu.test(error.message);
}

/** One answer's JSON size, or its refusal when it is over the response bound. */
function boundResponse(body: MessageBody): MessageBody {
  const bytes = Buffer.byteLength(JSON.stringify(body), 'utf8');
  if (bytes <= MAX_RESPONSE_BYTES) return body;
  return { errors: [{ message: `the response is ${String(bytes)} bytes; the limit is ${String(MAX_RESPONSE_BYTES)}`, extensions: { code: 'TOO_LARGE' } }] };
}

/** The refusal a product without a published manifest answers. */
function missingManifest(folder: string): never {
  throw new GraphqlRefusal('NO_MANIFEST', `${folder}/madarch/catalog.yaml:1: the graph holds no published manifest`, 409);
}

/** The schema one manifest makes, with the query checked against it and its cost admitted (sections 1, 4 and 5). */
function prepare(manifest: KindsManifest, document: DocumentNode, operation: GraphqlOperation): { manifest: KindsManifest; published: ReturnType<typeof publishedManifestOf>; sdl: string; schema: GraphQLSchema } {
  const published = publishedManifestOf(manifest);
  const sdl = graphqlSchemaOf(published);
  const schema = schemaOf(sdl);
  const invalid = validate(schema, document);
  if (invalid.length > 0) throw new GraphqlRefusal('INVALID_QUERY', invalid.map((error) => error.message).join('; '), 400);
  const cost = queryCost(document, schema, operation.variables, operation.operationName);
  if (cost > MAX_NODES) throw new GraphqlRefusal('LIMIT_NODES', `the query costs ${String(cost)} nodes; the limit is ${String(MAX_NODES)}`);
  return { manifest, published, sdl, schema };
}

/** Runs one operation against the product's graph: the schema, the admission, one snapshot, the resolvers. */
export async function executeGraphql(owner: DatabaseOwner, product: GraphqlProduct, operation: GraphqlOperation): Promise<GraphqlAnswer> {
  let document: DocumentNode;
  try {
    document = parse(operation.query);
  } catch (error) {
    return { status: 400, body: { errors: [{ message: error instanceof GraphQLError ? error.message : String(error) }] } };
  }
  const depth = queryDepth(document, operation.operationName);
  if (depth > MAX_DEPTH) {
    return { status: 400, body: { errors: [{ message: `the query is ${String(depth)} levels deep; the limit is ${String(MAX_DEPTH)}`, extensions: { code: 'LIMIT_DEPTH' } }] } };
  }
  const aliases = queryAliases(document, operation.operationName);
  if (aliases > MAX_ALIASES) {
    return { status: 400, body: { errors: [{ message: `the query holds ${String(aliases)} aliases; the limit is ${String(MAX_ALIASES)}`, extensions: { code: 'LIMIT_ALIASES' } }] } };
  }
  const templates = readProductTemplates(product.folder);
  let backend: number | undefined;
  // A caller that holds the manifest is admitted before the snapshot: a refusal costs no connection.
  let prepared: { manifest: KindsManifest; published: ReturnType<typeof publishedManifestOf>; sdl: string; schema: GraphQLSchema } | undefined;
  if (product.manifest !== undefined) {
    try {
      prepared = prepare(product.manifest, document, operation);
    } catch (error) {
      if (error instanceof GraphqlRefusal) return { status: error.status, body: { errors: [{ message: error.message, extensions: { code: error.code } }] } };
      if (error instanceof SchemaRefusal) return { status: 400, body: { errors: [{ message: error.message }] } };
      throw error;
    }
  }
  const work = owner.transaction('snapshot', async (tx) => {
    await tx.query("SET LOCAL statement_timeout = '2000ms'");
    const pid = await tx.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
    backend = Number(pid.rows[0]?.pid);
    // The manifest is read inside the operation's snapshot: a publication between the schema and the data would
    // otherwise answer a query whose fields the rows no longer match.
    const see = prepared ?? prepare(await readPublishedManifest(tx) ?? missingManifest(product.folder), document, operation);
    const { manifest, published, sdl, schema } = see;
    const structure = structureRevisionOf(sdl, templates.templates);
    const context = new ReadContext(tx, manifest, published, product.folder, operation.lang, structure, templates);
    const result = await execute({
      schema,
      document,
      variableValues: operation.variables,
      operationName: operation.operationName ?? undefined,
      contextValue: context,
      fieldResolver: context.resolve,
    });
    // A statement timeout or a cancellation is the operation's, not a field's: the transaction rolls back and the
    // answer is one TIMEOUT error with no data.
    if (result.errors?.some((error) => isStatementTimeout(error)) === true) throw new GraphqlRefusal('TIMEOUT', `the query did not finish within ${String(DEADLINE_MS)} ms`, 200);
    return result;
  });
  // A deadline of the executor's own, beside the statement timeout: when it passes, the backend's statement is
  // cancelled and the transaction is awaited to its rollback, so nothing of the operation keeps running.
  let timer: ReturnType<typeof setTimeout> | undefined;
  let expired = false;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => { expired = true; reject(new GraphqlRefusal('TIMEOUT', `the query did not finish within ${String(DEADLINE_MS)} ms`, 200)); }, DEADLINE_MS);
  });
  work.catch(() => undefined);
  try {
    const result = await Promise.race([work, deadline]);
    if (result.errors !== undefined && result.errors.length > 0) {
      return {
        status: 200,
        body: boundResponse({
          ...(result.data === undefined ? {} : { data: result.data }),
          errors: result.errors.map((error) => ({ message: error.message, ...(error.extensions?.['code'] === undefined ? {} : { extensions: { code: String(error.extensions['code']) } }) })),
        }),
      };
    }
    return { status: 200, body: boundResponse({ data: result.data }) };
  } catch (error) {
    if (error instanceof GraphqlRefusal) {
      if (expired) {
        if (backend !== undefined) await owner.run(async (tx) => { await tx.query('SELECT pg_cancel_backend($1)', [backend]); }).catch(() => undefined);
        await work.catch(() => undefined);
      }
      return { status: error.status, body: { errors: [{ message: error.message, extensions: { code: error.code } }] } };
    }
    if (error instanceof SchemaRefusal) return { status: 400, body: { errors: [{ message: error.message }] } };
    return { status: 500, body: { errors: [{ message: error instanceof Error ? error.message : String(error) }] } };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
