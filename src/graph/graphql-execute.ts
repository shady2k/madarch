/**
 * The GraphQL API's executor (decision 0036, sections 1, 4 and 5): one operation, one read-only snapshot transaction,
 * the schema derived from the product's published manifest, and the read layer's resolvers. Admission refuses a query
 * deeper than six levels before any read; the transaction's own deadline stops one that runs longer than two seconds.
 * A refused or stopped query returns no data and one error whose `extensions.code` names the limit.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { buildSchema, execute, GraphQLError, Kind, parse, validate, type GraphQLInterfaceType, type GraphQLScalarType, type GraphQLSchema, type DocumentNode, type SelectionSetNode } from 'graphql';
import type { DatabaseOwner } from '../adapters/database-owner.js';
import { sha256Hex } from './digest.js';
import type { KindsManifest } from '../product/manifest/kinds.js';
import { publishedManifestOf } from '../graphql/manifest.js';
import { SchemaRefusal } from '../graphql/names.js';
import { ReadContext, entityOf } from './graphql-read.js';
import { graphqlSchemaOf } from '../graphql/schema.js';

/** The depth a query may reach, counting the root field as one (decision 0036, section 5). */
export const MAX_DEPTH = 6;
/** The deadline of one operation, in milliseconds. */
export const DEADLINE_MS = 2000;

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
  readonly manifest: KindsManifest;
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

/** The largest field-chain depth of one operation, fragments inlined (decision 0036, section 5). */
export function queryDepth(document: DocumentNode): number {
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
  let max = 0;
  for (const definition of document.definitions) {
    if (definition.kind !== Kind.OPERATION_DEFINITION) continue;
    max = Math.max(max, depthOf(definition.selectionSet, new Set<string>()));
  }
  // Depth counts the selections below the root's own set: one root field alone is depth 0, and a list's edges, its
  // nodes and their fields are three. Section 5's six then leaves a list of entities with a relation on each.
  return Math.max(0, max - 1);
}

/** The product's templates: every file under `templates/`, named by its relative path without its extension. */
export function templatesOf(folder: string): { name: string; body: string }[] {
  const root = join(folder, 'templates');
  const out: { name: string; body: string }[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && statSync(path).isFile()) {
        const name = relative(root, path).replace(/\.[^.]*$/u, '');
        out.push({ name, body: readFileSync(path, 'utf8') });
      }
    }
  };
  try {
    visit(root);
  } catch {
    return [];
  }
  return out.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
}

/** The revision of the schema and every template: what a client refetches its bootstrap when it changes (section 6). */
export function structureRevisionOf(sdl: string, templates: readonly { name: string; body: string }[]): string {
  return sha256Hex(new TextEncoder().encode([sdl, ...templates.map((one) => `${one.name}\u0000${one.body}`)].join('\u0000')));
}

/** Runs one operation against the product's graph: the schema, the admission, one snapshot, the resolvers. */
export async function executeGraphql(owner: DatabaseOwner, product: GraphqlProduct, operation: GraphqlOperation): Promise<GraphqlAnswer> {
  const published = publishedManifestOf(product.manifest);
  const sdl = graphqlSchemaOf(published);
  const schema = schemaOf(sdl);
  let document: DocumentNode;
  try {
    document = parse(operation.query);
  } catch (error) {
    return { status: 400, body: { errors: [{ message: error instanceof GraphQLError ? error.message : String(error) }] } };
  }
  const depth = queryDepth(document);
  if (depth > MAX_DEPTH) {
    return { status: 400, body: { errors: [{ message: `the query is ${String(depth)} levels deep; the limit is ${String(MAX_DEPTH)}`, extensions: { code: 'LIMIT_DEPTH' } }] } };
  }
  const invalid = validate(schema, document);
  if (invalid.length > 0) {
    return { status: 400, body: { errors: invalid.map((error) => ({ message: error.message })) } };
  }
  const templates = templatesOf(product.folder);
  const structure = structureRevisionOf(sdl, templates);
  const work = owner.transaction('snapshot', async (tx) => {
    await tx.query("SET LOCAL statement_timeout = '2000ms'");
    const context = new ReadContext(tx, product.manifest, published, product.folder, operation.lang, structure, templates);
    return await execute({
      schema,
      document,
      variableValues: operation.variables,
      operationName: operation.operationName ?? undefined,
      contextValue: context,
      fieldResolver: context.resolve,
    });
  });
  // A deadline of the executor's own, beside the statement timeout: a slow statement is cancelled, and a slow sequence
  // of them never holds the answer past the bound.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new GraphqlRefusal('TIMEOUT', `the query did not finish within ${String(DEADLINE_MS)} ms`, 200)), DEADLINE_MS);
  });
  work.catch(() => undefined);
  try {
    const result = await Promise.race([work, deadline]);
    if (result.errors !== undefined && result.errors.length > 0) {
      return {
        status: 200,
        body: {
          ...(result.data === undefined ? {} : { data: result.data }),
          errors: result.errors.map((error) => ({ message: error.message, ...(error.extensions?.['code'] === undefined ? {} : { extensions: { code: String(error.extensions['code']) } }) })),
        },
      };
    }
    return { status: 200, body: { data: result.data } };
  } catch (error) {
    if (error instanceof GraphqlRefusal) return { status: error.status, body: { errors: [{ message: error.message, extensions: { code: error.code } }] } };
    if (error instanceof SchemaRefusal) return { status: 400, body: { errors: [{ message: error.message }] } };
    return { status: 500, body: { errors: [{ message: error instanceof Error ? error.message : String(error) }] } };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
