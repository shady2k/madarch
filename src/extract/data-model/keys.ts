/**
 * The data-model extractor's logical keys (records.ts): the same database,
 * table, column, index, migration, function or file gives the same key in
 * every run. The key parts are joined with `/` and `#` and never hold a space
 * (records.ts, NodeKey).
 */

/** The node kinds this extractor emits, all under the engine's `code.` prefix. */
export const DATA_MODEL_NODE_KINDS = [
  'code.column',
  'code.database',
  'code.file',
  'code.function',
  'code.index',
  'code.migration',
  'code.table',
] as const;

/** The relation types this extractor emits, all under the engine's `code.` prefix. */
export const DATA_MODEL_EDGE_TYPES = [
  'code.foreign-key',
  'code.logical-reference',
  'code.reads-table',
  'code.writes-table',
] as const;

/** The producer id of this extractor (records.ts, Extraction.producer). */
export const DATA_MODEL_PRODUCER = 'code.extract.data-model';

/** The default PostgreSQL schema a table without an explicit one lives in. */
export const DEFAULT_SCHEMA = 'public';

export function databaseKey(database: string): string {
  return `code.database:${database}`;
}

export function tableKey(database: string, table: string, schema: string = DEFAULT_SCHEMA): string {
  return `code.table:${database}/${schema}.${table}`;
}

export function columnKey(database: string, table: string, column: string, schema: string = DEFAULT_SCHEMA): string {
  return `${tableKey(database, table, schema)}/${column}`;
}

export function indexKey(database: string, table: string, index: string, schema: string = DEFAULT_SCHEMA): string {
  return `code.index:${database}/${schema}.${table}/${index}`;
}

export function migrationKey(database: string, name: string): string {
  return `code.migration:${database}/${name}`;
}

export function functionKey(path: string, qualifiedName: string): string {
  return `code.function:${path}#${qualifiedName}`;
}

export function fileKey(path: string): string {
  return `code.file:${path}`;
}
