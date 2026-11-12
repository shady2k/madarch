/// <reference path="./ambient.d.ts" />
/**
 * The `db-schema` plugin (decision 0035, items 3 and 8; task madarch-47vw.3): it reads the SQL the code holds and answers
 * the catalogue's data entities — the database, its tables, their columns and indexes, and the edges that say which table
 * holds which column or index, which column references which, and which file declares the table.
 *
 * The files are the graph's TypeScript file vertices and their content, which the host answers: the plugin reads no
 * repository and walks no folder (items 9 and 15). A JavaScript/TypeScript parser (`@babel/parser`) gives every string and
 * template literal with its place; a PostgreSQL parser (`libpg-query`, libpg_query compiled to WebAssembly) reads each
 * literal that is SQL. No regular expression decides what SQL is, and no list of names stands in for the parse.
 *
 * A template literal with substitutions is read with each substitution standing as one harmless placeholder. A literal
 * the PostgreSQL parser refuses, and a statement whose table name is composed at run time, is never guessed: the unit
 * ends partial and names the file and the line of every such literal. Only CREATE TABLE, CREATE INDEX, CREATE UNIQUE INDEX
 * and ALTER TABLE state anything here; other SQL is read and left alone.
 */
import { parse as parseTypeScript } from '@babel/parser';
import { loadModule as loadPostgres, parseSync as parsePostgres, scanSync as scanPostgres } from 'libpg-query';
import { definePlugin, type EdgeResult, type ExtractContext, type Unit, type UnitResult, type VertexResult } from 'madarch-plugin-sdk';

/** The kinds the plugin fills. */
const DATABASE_KIND = 'code.database';
const TABLE_KIND = 'code.table';
const COLUMN_KIND = 'code.column';
const INDEX_KIND = 'code.index';

/** The edge kinds the plugin states. */
const HAS_COLUMN = 'code.has-column';
const HAS_INDEX = 'code.has-index';
const FOREIGN_KEY = 'code.foreign-key';
const DECLARED_IN = 'code.declared-in';

/** The placeholder each substitution of a template literal stands as, where the PostgreSQL parser needs a token. */
const PLACEHOLDER = 'madarch_substitution';

/** Where a value was read: the repository, the file and the lines the literal stands on. */
interface Place {
  readonly repository: string;
  readonly path: string;
  readonly lineStart: number;
  readonly lineEnd: number;
}

/** A literal the plugin could not read whole, with the place that says where: never a silence. */
interface Problem {
  readonly repository: string;
  readonly path: string;
  readonly line: number;
  readonly message: string;
}

/** One column as the SQL states it. */
interface Column {
  readonly name: string;
  type: string;
  nullable: boolean;
  defaultText: string | null;
  primary_key: boolean;
  unique: boolean;
  readonly checks: string[];
  readonly place: Place;
}

/** One foreign key: a column of this table pointing at a column of another table. */
interface Reference {
  readonly column: string;
  readonly targetTable: string;
  readonly target_column: string;
  readonly constraint: string | null;
  readonly place: Place;
}

/** One index the SQL creates. */
interface Index {
  readonly name: string;
  readonly unique: boolean;
  readonly columns: readonly string[];
  readonly where: string | null;
  readonly place: Place;
}

/** One table as the SQL creates and alters it, with the place that declares it. */
interface Table {
  readonly database: string;
  readonly name: string;
  readonly schema: string | null;
  readonly columns: Map<string, Column>;
  readonly indexes: Map<string, Index>;
  readonly references: Reference[];
  readonly notes: string[];
  declaration?: Place;
  readonly place: Place;
}

/** One database: the repository whose code holds the SQL, and the tables. */
interface Database {
  readonly name: string;
  readonly repository: string;
  readonly tables: Map<string, Table>;
  readonly place: Place;
}

/** Everything the unit read, by repository and database name. */
interface Model {
  readonly databases: Map<string, Database>;
  readonly problems: Problem[];
}

// ---- PostgreSQL's AST, as this plugin reads it ------------------------------------------------

/** A node of libpg_query's answer: the protobuf JSON shape, read field by field. */
type PgNode = { readonly [field: string]: unknown };

/** The node wrapped under one key of a libpg_query element, such as `{"ColumnDef": {...}}`. */
function only(element: unknown, key: string): PgNode | undefined {
  if (element === null || typeof element !== 'object') return undefined;
  const held = (element as Record<string, unknown>)[key];
  return held !== null && typeof held === 'object' && !Array.isArray(held) ? (held as PgNode) : undefined;
}

/** One string value libpg_query writes as `{"String": {"sval": "x"}}`, or undefined. */
function stringOf(value: unknown): string | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const held = (value as Record<string, unknown>)['String'];
  if (held === null || typeof held !== 'object') return undefined;
  const sval = (held as Record<string, unknown>)['sval'];
  return typeof sval === 'string' ? sval : undefined;
}

/** The strings of a libpg_query string list, in their order, skipping any that is not one. */
function stringsOf(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((one) => { const text = stringOf(one); return text === undefined ? [] : [text]; });
}

/** The integer libpg_query writes in a protobuf JSON field; a field it leaves out is protobuf's zero. */
function integerOf(value: unknown): number {
  if (value === null || typeof value !== 'object') return 0;
  const held = value as Record<string, unknown>;
  const ival = held['ival'];
  return typeof ival === 'number' ? ival : 0;
}

/** The PostgreSQL type name of one `TypeName` node, as the SQL writes it: `bigint`, `text`, `numeric(10, 2)`. */
function typeTextOf(typeName: PgNode | undefined): string {
  if (typeName === undefined) return 'unknown';
  const names = stringsOf(typeName['names']);
  const bare = names.filter((one) => one !== 'pg_catalog');
  const last = bare[bare.length - 1] ?? 'unknown';
  const rendered = PG_TYPE_NAMES[last] ?? last;
  const bounds = Array.isArray(typeName['arrayBounds']) ? typeName['arrayBounds'].length : 0;
  const args = Array.isArray(typeName['typmods']) ? (typeName['typmods'] as unknown[]).flatMap((one) => {
    const constant = only(one, 'A_Const');
    const value = constant === undefined ? undefined : constantTextOf(constant);
    return value === undefined ? [] : [value];
  }) : [];
  return `${rendered}${args.length === 0 ? '' : `(${args.join(', ')})`}${'[]'.repeat(bounds)}`;
}

/** PostgreSQL's internal type names as the SQL writes them. */
const PG_TYPE_NAMES: Readonly<Record<string, string>> = {
  bool: 'boolean',
  bpchar: 'character',
  float4: 'real',
  float8: 'double precision',
  int2: 'smallint',
  int4: 'integer',
  int8: 'bigint',
  serial: 'serial',
  serial4: 'serial',
  serial8: 'bigserial',
  time: 'time without time zone',
  timestamp: 'timestamp without time zone',
  timestamptz: 'timestamp with time zone',
  timetz: 'time with time zone',
  varchar: 'character varying',
};

/** One `A_Const` as the SQL writes it. A field protobuf omits is its zero, so an empty `ival` stands for 0. */
function constantTextOf(constant: PgNode): string | undefined {
  if (constant['isnull'] !== undefined) return 'null';
  const sval = only(constant, 'sval');
  if (sval !== undefined) {
    const text = stringOf({ String: sval }) ?? '';
    return `'${text.replace(/'/g, "''")}'`;
  }
  if (constant['ival'] !== undefined) return String(integerOf(constant['ival']));
  const fval = constant['fval'];
  if (typeof fval === 'string') return fval;
  if (constant['boolval'] !== undefined) {
    const held = constant['boolval'];
    const value = held !== null && typeof held === 'object' ? (held as Record<string, unknown>)['boolval'] : undefined;
    return value === true ? 'true' : 'false';
  }
  return undefined;
}

/**
 * One expression of the SQL as text: the values and calls the code holds (`gen_random_uuid()`, `'{}'::jsonb`,
 * `a > 0`), and, for a node this reader does not render, the node's own JSON — complete, never a guess at less.
 */
function expressionTextOf(expression: unknown): string | undefined {
  if (expression === null || typeof expression !== 'object') return undefined;
  const held = expression as Record<string, unknown>;
  const constant = only(held, 'A_Const');
  if (constant !== undefined) return constantTextOf(constant);
  const func = only(held, 'FuncCall');
  if (func !== undefined) {
    const name = stringsOf(func['funcname']).join('.');
    const args = Array.isArray(func['args']) ? (func['args'] as unknown[]).flatMap((one) => { const text = expressionTextOf(one); return text === undefined ? [] : [text]; }) : [];
    return `${name}(${args.join(', ')})`;
  }
  const cast = only(held, 'TypeCast');
  if (cast !== undefined) {
    const arg = expressionTextOf(cast['arg']);
    const type = typeTextOf(only(cast, 'typeName'));
    return arg === undefined ? undefined : `${arg}::${type}`;
  }
  const column = only(held, 'ColumnRef');
  if (column !== undefined) {
    const fields = stringsOf(column['fields']);
    if (fields.length > 0) return fields.join('.');
  }
  const array = only(held, 'A_ArrayExpr');
  if (array !== undefined) {
    const items = Array.isArray(array['elements']) ? (array['elements'] as unknown[]).flatMap((one) => { const text = expressionTextOf(one); return text === undefined ? [] : [text]; }) : [];
    return `ARRAY[${items.join(', ')}]`;
  }
  const operator = only(held, 'A_Expr');
  if (operator !== undefined) {
    const kind = String(operator['kind'] ?? '');
    const name = stringsOf(operator['name']).join(' ');
    const left = expressionTextOf(operator['lexpr']);
    const right = expressionTextOf(operator['rexpr']);
    if (kind === 'AEXPR_OP' && left !== undefined && right !== undefined) return `${left} ${name} ${right}`;
    if (kind === 'AEXPR_OP' && right !== undefined) return `${name} ${right}`;
  }
  const nullTest = only(held, 'NullTest');
  if (nullTest !== undefined) {
    const arg = expressionTextOf(nullTest['arg']);
    const kind = String(nullTest['nulltesttype'] ?? '');
    if (arg !== undefined && kind === 'IS_NOT_NULL') return `${arg} IS NOT NULL`;
    if (arg !== undefined && kind === 'IS_NULL') return `${arg} IS NULL`;
  }
  const list = only(held, 'List');
  if (list !== undefined) {
    const items = Array.isArray(list['items']) ? (list['items'] as unknown[]).flatMap((one) => { const text = expressionTextOf(one); return text === undefined ? [] : [text]; }) : [];
    return items.join(', ');
  }
  return JSON.stringify(expression);
}

// ---- reading the literals --------------------------------------------------------------------

/**
 * What the SQL lexer says about one literal: whether any word of it is a keyword that opens a statement this plugin
 * reads, and whether the literal opens with such a statement. The words are the lexer's tokens, so whether a literal is
 * SQL is never a pattern over the source text.
 */
const SCAN_CACHE = new Map<string, { holds: boolean; opens: boolean }>();

function schemaTokensOf(text: string): { holds: boolean; opens: boolean } {
  const cached = SCAN_CACHE.get(text);
  if (cached !== undefined) return cached;
  let scanned: { tokens?: readonly { text?: string; keywordKind?: number; tokenName?: string }[] };
  try {
    scanned = scanPostgres(text) as typeof scanned;
  } catch {
    SCAN_CACHE.set(text, { holds: false, opens: false });
    return { holds: false, opens: false };
  }
  const words: string[] = [];
  for (const token of scanned.tokens ?? []) {
    if (token.tokenName === 'SQL_COMMENT' || token.tokenName === 'C_COMMENT') continue;
    if ((token.keywordKind ?? 0) > 0 && typeof token.text === 'string') words.push(token.text.toUpperCase());
  }
  const answer = { holds: words.includes('CREATE') || words.includes('ALTER'), opens: opensSchemaStatement(words) };
  SCAN_CACHE.set(text, answer);
  return answer;
}

/**
 * Whether the first words of a literal open `CREATE [UNIQUE] TABLE|INDEX` or `ALTER TABLE`, reading the words the SQL
 * lexer gave: the modifiers PostgreSQL admits between CREATE and the object are skipped, and a literal that only
 * mentions a keyword inside a sentence opens no statement.
 */
function opensSchemaStatement(words: readonly string[]): boolean {
  if (words[0] === 'ALTER') return words[1] === 'TABLE';
  if (words[0] !== 'CREATE') return false;
  let at = 1;
  while (CREATE_MODIFIERS.includes(words[at] ?? '')) at += 1;
  return words[at] === 'TABLE' || words[at] === 'INDEX';
}

/** The words PostgreSQL admits between CREATE and the table or index it creates. */
const CREATE_MODIFIERS: readonly string[] = ['OR', 'REPLACE', 'TEMP', 'TEMPORARY', 'UNLOGGED', 'UNIQUE', 'GLOBAL', 'LOCAL'];

/** One string or template literal the TypeScript parser found, with its place in the file. */
interface Literal {
  /** The literal's text, with one placeholder standing where a substitution was. */
  readonly text: string;
  /** The line of the file the literal opens on. */
  readonly line: number;
  /** Whether a substitution stood in the literal: what the SQL parser reads may then not be the statement. */
  readonly substituted: boolean;
}

/** The offsets one text's lines start at, so a position's line is a search rather than a walk from the file's start. */
function lineStartsOf(text: string): number[] {
  const starts: number[] = [0];
  for (let at = 0; at < text.length; at += 1) if (text[at] === '\n') starts.push(at + 1);
  return starts;
}

/** The line a byte offset of a text stands on, counted from 1. */
function lineAt(starts: readonly number[], offset: number): number {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (starts[middle]! <= offset) low = middle;
    else high = middle - 1;
  }
  return low + 1;
}

/** The string and template literals of one TypeScript file, in source order, with the lines they open on. */
function literalsOf(text: string, path: string, problems: Problem[], place: (line: number) => Problem): Literal[] {
  let ast: unknown;
  try {
    ast = parseTypeScript(text, { sourceType: 'unambiguous', plugins: path.endsWith('.tsx') ? ['typescript', 'jsx'] : ['typescript'], errorRecovery: false });
  } catch (error) {
    const failure = error as Error & { loc?: { line?: number; column?: number } };
    problems.push(place(failure.loc?.line ?? 1));
    return [];
  }
  const constants = new Map<string, string>();
  const collect = (node: unknown): void => {
    if (node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(collect); return; }
    const held = node as Record<string, unknown>;
    if (held['type'] === 'VariableDeclaration' && held['kind'] === 'const' && Array.isArray(held['declarations'])) {
      for (const declaration of held['declarations'] as Record<string, unknown>[]) {
        const id = declaration['id'] as Record<string, unknown> | undefined;
        const init = declaration['init'] as Record<string, unknown> | undefined;
        if (id?.['type'] === 'Identifier' && typeof id['name'] === 'string' && init?.['type'] === 'StringLiteral' && typeof init['value'] === 'string') constants.set(id['name'], init['value']);
      }
    }
    if (held['type'] === 'ExportNamedDeclaration') collect(held['declaration']);
  };
  // Only top-level string constants are candidates. Shadowed names are removed below; no function is evaluated.
  const program = (ast as { program?: { body?: unknown[] } }).program;
  for (const statement of program?.body ?? []) collect(statement);
  const bindings = new Map<string, number>();
  const countBindings = (node: unknown): void => {
    if (node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(countBindings); return; }
    const held = node as Record<string, unknown>;
    const add = (binding: unknown): void => {
      if (binding === null || typeof binding !== 'object') return;
      const value = binding as Record<string, unknown>;
      if (value['type'] === 'Identifier' && typeof value['name'] === 'string') bindings.set(value['name'], (bindings.get(value['name']) ?? 0) + 1);
      else for (const child of Object.values(value)) {
        if (Array.isArray(child)) child.forEach(add);
        else if (child !== null && typeof child === 'object') add(child);
      }
    };
    if (held['type'] === 'VariableDeclarator' || held['type'] === 'FunctionDeclaration' || held['type'] === 'FunctionExpression' || held['type'] === 'ClassDeclaration' || held['type'] === 'ClassExpression') add(held['id']);
    if (Array.isArray(held['params'])) held['params'].forEach(add);
    if (held['type'] === 'CatchClause') add(held['param']);
    for (const [key, value] of Object.entries(held)) if (key !== 'loc') countBindings(value);
  };
  countBindings(ast);
  for (const name of constants.keys()) if (bindings.get(name) !== 1) constants.delete(name);
  const found: Literal[] = [];
  const starts = lineStartsOf(text);
  const walk = (node: unknown): void => {
    if (node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) { for (const one of node) walk(one); return; }
    const held = node as Record<string, unknown>;
    const type = held['type'];
    if (type === 'StringLiteral') {
      const value = held['value'];
      const start = held['start'];
      if (typeof value === 'string' && typeof start === 'number') found.push({ text: value, line: lineAt(starts, start), substituted: false });
      return;
    }
    if (type === 'TemplateLiteral') {
      const quasis = held['quasis'];
      const expressions = held['expressions'];
      const start = held['start'];
      if (Array.isArray(quasis) && typeof start === 'number') {
        let written = '';
        let allRead = true;
        for (const [at, element] of (quasis as unknown[]).entries()) {
          if (at > 0) {
            const expression = Array.isArray(expressions) ? expressions[at - 1] as Record<string, unknown> : undefined;
            written += expression?.['type'] === 'Identifier' && typeof expression['name'] === 'string' ? constants.get(expression['name']) ?? PLACEHOLDER : PLACEHOLDER;
          }
          const quasi = element !== null && typeof element === 'object' ? (element as Record<string, unknown>) : undefined;
          const value = quasi?.['value'];
          const held = value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;
          // The source text of a quasi is what the SQL parser needs; a cooked value has lost the escapes it wrote.
          const raw = typeof held?.['raw'] === 'string' ? (held['raw'] as string) : typeof held?.['cooked'] === 'string' ? (held['cooked'] as string) : undefined;
          if (raw === undefined) { allRead = false; continue; }
          written += raw;
        }
        if (!allRead) problems.push(place(lineAt(starts, start)));
        found.push({ text: written, line: lineAt(starts, start), substituted: Array.isArray(expressions) && expressions.length > 0 });
      }
      return;
    }
    for (const key of Object.keys(held)) {
      if (key === 'loc' || key === 'start' || key === 'end' || key === 'extra' || key === 'leadingComments' || key === 'trailingComments' || key === 'innerComments' || key === 'tokens') continue;
      walk(held[key]);
    }
  };
  walk(ast);
  return found;
}

// ---- building the model ----------------------------------------------------------------------

/** The table name the SQL writes: `schema.name` when the statement names a schema other than `public`. */
function tableNameOf(relation: PgNode | undefined): string | undefined {
  if (relation === undefined) return undefined;
  const name = relation['relname'];
  if (typeof name !== 'string' || name === '') return undefined;
  const schema = relation['schemaname'];
  if (name.includes(PLACEHOLDER) || typeof schema === 'string' && schema.includes(PLACEHOLDER)) return undefined;
  // Preserve every statically known schema qualification.
  return typeof schema === 'string' && schema !== '' && schema !== 'public' ? `${schema}.${name}` : name;
}

/** The columns a `PRIMARY KEY` or `UNIQUE` constraint names, from a table-level or column-level constraint. */
function keyColumnsOf(constraint: PgNode): string[] {
  return stringsOf(constraint['keys']);
}

/** One place's evidence, as a claim or a vertex names it. */
function evidenceOf(place: Place): { repository: string; path: string; lineStart: number; lineEnd: number } {
  return { repository: place.repository, path: place.path, lineStart: place.lineStart, lineEnd: place.lineEnd };
}

/** The column a table holds, made on first sight so a later ALTER TABLE can add to it. */
function columnOf(table: Table, name: string, place: Place): Column {
  const held = table.columns.get(name);
  if (held !== undefined) return held;
  const made: Column = { name, type: 'unknown', nullable: true, defaultText: null, primary_key: false, unique: false, checks: [], place };
  table.columns.set(name, made);
  return made;
}

/** One `ColumnDef` added to a table. */
function readColumn(table: Table, definition: PgNode, placeAt: (offset: number) => Place, problems: Problem[], where: (offset: number) => Problem): void {
  const name = definition['colname'];
  if (typeof name !== 'string' || name === '') return;
  const columnPlace = placeAt(typeof definition['location'] === 'number' ? (definition['location'] as number) : 0);
  const column = columnOf(table, name, columnPlace);
  column.type = typeTextOf(only(definition, 'typeName'));
  const constraints = Array.isArray(definition['constraints']) ? (definition['constraints'] as unknown[]) : [];
  for (const element of constraints) {
    const constraint = only(element, 'Constraint');
    if (constraint === undefined) continue;
    const type = constraint['contype'];
    if (type === 'CONSTR_NOTNULL') column.nullable = false;
    else if (type === 'CONSTR_PRIMARY') { column.primary_key = true; column.nullable = false; }
    else if (type === 'CONSTR_UNIQUE') column.unique = true;
    else if (type === 'CONSTR_DEFAULT') {
      const text = expressionTextOf(constraint['raw_expr']);
      if (text === undefined) problems.push(where(typeof constraint['location'] === 'number' ? (constraint['location'] as number) : 0));
      else column.defaultText = text;
    } else if (type === 'CONSTR_CHECK') {
      const text = expressionTextOf(constraint['raw_expr']);
      if (text === undefined) problems.push(where(typeof constraint['location'] === 'number' ? (constraint['location'] as number) : 0));
      else column.checks.push(text);
    } else if (type === 'CONSTR_FOREIGN') {
      const target = tableNameOf(only(constraint, 'pktable'));
      const targets = stringsOf(constraint['pk_attrs']);
      if (target !== undefined && targets.length > 0) table.references.push({ column: name, targetTable: target, target_column: targets[0]!, constraint: typeof constraint['conname'] === 'string' ? constraint['conname'] : null, place: columnPlace });
    }
  }
}

/** One table-level constraint: a primary key, a unique key, a foreign key or a check, added to the table. */
function readTableConstraint(table: Table, constraint: PgNode, placeAt: (offset: number) => Place): void {
  const type = constraint['contype'];
  if (type === 'CONSTR_PRIMARY' || type === 'CONSTR_UNIQUE') {
    const constraintPlace = placeAt(typeof constraint['location'] === 'number' ? (constraint['location'] as number) : 0);
    const keys = keyColumnsOf(constraint);
    if (type === 'CONSTR_UNIQUE' && keys.length > 1) {
      table.notes.push(`unsupported composite UNIQUE (${keys.join(', ')}); members are not individually unique`);
      return;
    }
    for (const name of keys) {
      const column = columnOf(table, name, constraintPlace);
      if (type === 'CONSTR_PRIMARY') { column.primary_key = true; column.nullable = false; }
      else column.unique = true;
    }
    return;
  }
  if (type === 'CONSTR_FOREIGN') {
    const target = tableNameOf(only(constraint, 'pktable'));
    const sources = stringsOf(constraint['fk_attrs']);
    const targets = stringsOf(constraint['pk_attrs']);
    if (target === undefined) return;
    for (const [at, source] of sources.entries()) {
      const target_column = targets[at] ?? targets[0];
      if (target_column === undefined) continue;
      table.references.push({ column: source, targetTable: target, target_column, constraint: typeof constraint['conname'] === 'string' ? constraint['conname'] : null, place: placeAt(typeof constraint['location'] === 'number' ? (constraint['location'] as number) : 0) });
    }
    return;
  }
  if (type === 'CONSTR_CHECK') {
    const text = expressionTextOf(constraint['raw_expr']);
    const onlyColumn = table.columns.size === 1 ? [...table.columns.values()][0] : undefined;
    if (text === undefined) table.notes.push('unsupported table CHECK expression');
    else if (onlyColumn !== undefined) onlyColumn.checks.push(text);
    else table.notes.push(`unsupported table CHECK: ${text}`);
  }
}

/** One `IndexStmt` added to its table. */
function readIndex(database: Database, statement: PgNode, place: Place, problems: Problem[], where: (line: number) => Problem): void {
  const name = statement['idxname'];
  const tableName = tableNameOf(only(statement, 'relation'));
  if (typeof name !== 'string' || name === '' || tableName === undefined || name.includes(PLACEHOLDER)) {
    if (name !== undefined && typeof name === 'string' && name.includes(PLACEHOLDER)) return;
    problems.push(where(typeof statement['location'] === 'number' ? (statement['location'] as number) : 0));
    return;
  }
  const table = tableOf(database, tableName, place);
  if (typeof statement['accessMethod'] === 'string' && statement['accessMethod'] !== 'btree') {
    table.notes.push(`unsupported access method ${statement['accessMethod']} on index ${name}`);
    return;
  }
  const columns: string[] = [];
  const params = Array.isArray(statement['indexParams']) ? (statement['indexParams'] as unknown[]) : [];
  for (const element of params) {
    const parameter = only(element, 'IndexElem');
    const column = parameter === undefined ? undefined : parameter['name'];
    if (typeof column !== 'string' || column === '') {
      table.notes.push(`unsupported expression index ${name}`);
      return;
    }
    if (parameter !== undefined && (Array.isArray(parameter['opclass']) && parameter['opclass'].length > 0)) {
      table.notes.push(`unsupported operator class on index ${name}: ${stringsOf(parameter['opclass']).join('.')}`);
      return;
    }
    columns.push(column);
  }
  const whereText = statement['whereClause'] === undefined ? null : expressionTextOf(statement['whereClause']);
  if (statement['whereClause'] !== undefined && whereText === undefined) problems.push(where(0));
  table.indexes.set(name, { name, unique: statement['unique'] === true, columns, where: whereText ?? null, place });
}

/** The table a database holds, made on first sight so an ALTER TABLE before its CREATE TABLE finds it. */
function tableOf(database: Database, name: string, place: Place): Table {
  const held = database.tables.get(name);
  if (held !== undefined) return held;
  const dot = name.indexOf('.');
  const made: Table = { database: database.name, name, schema: dot < 0 ? null : name.slice(0, dot), columns: new Map(), indexes: new Map(), references: [], notes: [], place };
  database.tables.set(name, made);
  return made;
}

/** The database a repository's SQL belongs to, made on first sight. */
function databaseOf(model: Model, repository: string, place: Place): Database {
  const held = model.databases.get(repository);
  if (held !== undefined) return held;
  const made: Database = { name: repository, repository, tables: new Map(), place };
  model.databases.set(repository, made);
  return made;
}

/** One statement of a literal, applied to the model. `lineOf` maps a byte offset of the literal to a file line. */
function readStatement(database: Database, statement: PgNode, place: Place, lineOf: (offset: number) => number, problems: Problem[]): void {
  const create = only(statement, 'CreateStmt');
  const index = only(statement, 'IndexStmt');
  const alter = only(statement, 'AlterTableStmt');
  // A column's or a constraint's own place inside the statement: the line its name stands on, not the table's first line.
  const placeAt = (offset: number): Place => {
    const line = lineOf(offset);
    return { repository: place.repository, path: place.path, lineStart: line, lineEnd: line };
  };
  const where = (offset: number): Problem => ({ ...placeAt(offset), line: placeAt(offset).lineStart, message: 'a value of the statement could not be read as the SQL writes it' });
  if (create !== undefined) {
    const name = tableNameOf(only(create, 'relation'));
    if (name === undefined || name.includes(PLACEHOLDER)) {
      if (name === undefined) problems.push(where(0));
      return;
    }
    const existing = database.tables.get(name);
    if (existing?.declaration !== undefined) {
      const message = `unsupported duplicate table declaration ${name}: ${database.repository}/${existing.declaration.path}:${existing.declaration.lineStart} and ${place.repository}/${place.path}:${place.lineStart}; definitions were not merged`;
      existing.notes.push(message);
      problems.push({ repository: place.repository, path: place.path, line: place.lineStart, message });
      return;
    }
    const table = tableOf(database, name, place);
    table.declaration = place;
    for (const element of Array.isArray(create['tableElts']) ? (create['tableElts'] as unknown[]) : []) {
      const column = only(element, 'ColumnDef');
      if (column !== undefined) { readColumn(table, column, placeAt, problems, where); continue; }
      const constraint = only(element, 'Constraint');
      if (constraint !== undefined) readTableConstraint(table, constraint, placeAt);
    }
    return;
  }
  if (index !== undefined) {
    readIndex(database, index, place, problems, where);
    return;
  }
  if (alter !== undefined) {
    const name = tableNameOf(only(alter, 'relation'));
    if (name === undefined || name.includes(PLACEHOLDER)) {
      if (name === undefined) problems.push(where(0));
      return;
    }
    const table = tableOf(database, name, place);
    for (const element of Array.isArray(alter['cmds']) ? (alter['cmds'] as unknown[]) : []) {
      const command = only(element, 'AlterTableCmd');
      if (command === undefined) continue;
      const subtype = command['subtype'];
      if (subtype === 'AT_AddColumn') {
        const definition = only(command['def'], 'ColumnDef');
        if (definition !== undefined) readColumn(table, definition, placeAt, problems, where);
        continue;
      }
      if (subtype === 'AT_AddConstraint') {
        const constraint = only(command['def'], 'Constraint');
        if (constraint !== undefined) readTableConstraint(table, constraint, placeAt);
        continue;
      }
      problems.push(where(typeof command['location'] === 'number' ? (command['location'] as number) : 0));
    }
    return;
  }
}

/**
 * One literal's SQL, applied to the model. A literal whose first keyword opens a schema statement and that the parser
 * refuses is a problem naming its file and line; a literal that only mentions CREATE or ALTER inside other SQL is read
 * when it parses, and left alone when it does not.
 */
function readLiteral(database: Database, literal: Literal, place: Place, problems: Problem[], startsAsStatement: boolean): void {
  let answer: unknown;
  try {
    answer = parsePostgres(literal.text);
  } catch (error) {
    if (!startsAsStatement) return;
    problems.push({ repository: place.repository, path: place.path, line: place.lineStart, message: `the SQL parser refused the literal: ${(error as Error).message.split('\n')[0] ?? 'no cause stated'}` });
    return;
  }
  const statements = answer !== null && typeof answer === 'object' ? (answer as Record<string, unknown>)['stmts'] : undefined;
  if (!Array.isArray(statements) || statements.length === 0) return;
  const text = literal.text;
  for (const element of statements) {
    const held = element as Record<string, unknown>;
    const statement = held['stmt'];
    if (statement === null || typeof statement !== 'object') continue;
    const at = typeof held['stmt_location'] === 'number' ? held['stmt_location'] : 0;
    const length = typeof held['stmt_len'] === 'number' ? held['stmt_len'] : 0;
    const openLine = lineOfOffset(text, at);
    const closeLine = length > 0 ? lineOfOffset(text, Math.min(at + length - 1, text.length)) : lineOfOffset(text, Math.max(0, text.trimEnd().length - 1));
    const statementPlace: Place = { repository: place.repository, path: place.path, lineStart: place.lineStart + openLine - 1, lineEnd: place.lineStart + closeLine - 1 };
    const offsetLine = (offset: number): number => place.lineStart + lineOfOffset(text, offset) - 1;
    readStatement(database, statement as PgNode, statementPlace, offsetLine, problems);
  }
}

/** The line a byte offset of a text stands on, and 1 for an offset at its end. */
function lineOfOffset(text: string, offset: number): number {
  let line = 1;
  const stop = Math.max(0, Math.min(offset, text.length));
  for (let at = 0; at < stop; at += 1) if (text[at] === '\n') line += 1;
  return line;
}

/** Whether a statement's object name is composed at run time: the substitution's placeholder stands where a name goes. */
function composedName(statement: PgNode): boolean {
  const visit = (node: unknown): boolean => {
    if (node === null || typeof node !== 'object') return false;
    if (Array.isArray(node)) return node.some(visit);
    return Object.entries(node).some(([key, value]) =>
      (key === 'relname' || key === 'schemaname' || key === 'idxname') && typeof value === 'string' && value.includes(PLACEHOLDER) || visit(value));
  };
  return visit(statement);
}

/** One statement of a literal that names its object at run time, as the problem that says so. */
function composedProblems(literal: Literal, place: Place): Problem[] {
  if (!literal.substituted) return [];
  const problems: Problem[] = [];
  try {
    const answer = parsePostgres(literal.text) as { stmts?: readonly { stmt?: unknown; stmt_location?: number }[] } | undefined;
    for (const element of answer?.stmts ?? []) {
      const statement = element.stmt;
      if (statement === null || typeof statement !== 'object') continue;
      if (!composedName(statement as PgNode)) continue;
      problems.push({ repository: place.repository, path: place.path, line: place.lineStart, message: 'the table or index is named by a substitution, so the SQL does not state which one it creates: the literal is read as far as the names it holds' });
    }
  } catch {
    // The literal's own refusal is read once, by readLiteral, and named there.
  }
  return problems;
}

// ---- the unit's answer -----------------------------------------------------------------------

async function extract(unit: Unit, context: ExtractContext): Promise<UnitResult> {
  const inputs = (unit.inputs ?? {}) as { patterns?: unknown };
  const patterns = Array.isArray(inputs.patterns) && inputs.patterns.length > 0 && inputs.patterns.every((one) => typeof one === 'string' && one !== '')
    ? (inputs.patterns as string[])
    : [];
  const model: Model = { databases: new Map(), problems: [] };
  const files: { repository: string; path: string; content: string }[] = [];
  for (const pattern of patterns) {
    for (const file of await context.graph.files(pattern)) {
      const repository = String(file.key['repository'] ?? '');
      const path = String(file.key['path'] ?? '');
      const content = await context.graph.value<string | null>(file.kind, file.key, 'content');
      if (typeof content === 'string' && content !== '') files.push({ repository, path, content });
    }
  }
  const uniqueFiles = [...new Map(files.map((file) => [JSON.stringify([file.repository, file.path]), file])).values()]
    .sort((left, right) => compare(left.repository, right.repository) || compare(left.path, right.path));
  files.splice(0, files.length, ...uniqueFiles);
  if (files.length > 0) await loadPostgres();
  context.progress(0, files.length, 'read the file vertices');
  for (const [at, file] of files.entries()) {
    const literalProblems: Problem[] = [];
    const literalPlace = (line: number): Problem => ({ repository: file.repository, path: file.path, line, message: 'the TypeScript parser refused the file, so the SQL it holds was not read' });
    const literals = literalsOf(file.content, file.path, literalProblems, literalPlace);
    model.problems.push(...literalProblems);
    const database = databaseOf(model, file.repository, { repository: file.repository, path: file.path, lineStart: 1, lineEnd: 1 });
    for (const literal of literals) {
      const scanned = schemaTokensOf(literal.text);
      if (!scanned.holds) continue;
      const place: Place = { repository: file.repository, path: file.path, lineStart: literal.line, lineEnd: literal.line };
      model.problems.push(...composedProblems(literal, place));
      readLiteral(database, literal, place, model.problems, scanned.opens);
    }
    context.progress(at + 1, files.length, file.path);
  }
  return answerOf(model);
}

/** The vertices and edges of the model, and how the unit ended. */
function answerOf(model: Model): UnitResult {
  const vertices: VertexResult[] = [];
  const edges: EdgeResult[] = [];
  const databases = [...model.databases.values()].filter((database) => database.tables.size > 0).sort((left, right) => compare(left.name, right.name));
  for (const database of databases) {
    vertices.push(vertexOf(DATABASE_KIND, { name: database.name }, databaseValuesOf(database), database.place));
    const tables = [...database.tables.values()].sort((left, right) => compare(left.name, right.name));
    for (const table of tables) {
      const tableKey = tableKeyOf(database.name, table.name);
      vertices.push(vertexOf(TABLE_KIND, { database: database.name, name: table.name }, tableValuesOf(database, table), table.place));
      // The file's key is its repository and its path, as the graph answered it: the writer lifts the repository's name
      // to the reference the graph declares, so the plugin states the key it was given.
      edges.push({ kind: DECLARED_IN, from: { kind: TABLE_KIND, key: { database: database.name, name: table.name } }, to: { kind: 'code.file', key: { repository: table.place.repository, path: table.place.path } }, evidence: evidenceOf(table.place) });
      const columns = [...table.columns.values()].sort((left, right) => compare(left.name, right.name));
      for (const column of columns) {
        vertices.push(vertexOf(COLUMN_KIND, { table: tableKey, name: column.name }, columnValuesOf(tableKey, column), column.place));
        edges.push({ kind: HAS_COLUMN, from: { kind: TABLE_KIND, key: { database: database.name, name: table.name } }, to: { kind: COLUMN_KIND, key: { table: tableKey, name: column.name } }, evidence: evidenceOf(table.place) });
      }
      const indexes = [...table.indexes.values()].sort((left, right) => compare(left.name, right.name));
      for (const index of indexes) {
        vertices.push(vertexOf(INDEX_KIND, { table: tableKey, name: index.name }, indexValuesOf(tableKey, index), index.place));
        edges.push({ kind: HAS_INDEX, from: { kind: TABLE_KIND, key: { database: database.name, name: table.name } }, to: { kind: INDEX_KIND, key: { table: tableKey, name: index.name } }, evidence: evidenceOf(index.place) });
      }
    }
    for (const table of tables) {
      // Repeated references from ALTER statements describe one relation.
      const stated = new Set<string>();
      for (const reference of table.references) {
        const identity = JSON.stringify([reference.column, reference.targetTable, reference.target_column, reference.constraint]);
        if (stated.has(identity)) continue;
        stated.add(identity);
        const target = database.tables.get(reference.targetTable);
        if (target === undefined) continue;
        edges.push({
          kind: FOREIGN_KEY,
          from: { kind: COLUMN_KIND, key: { table: tableKeyOf(database.name, table.name), name: reference.column } },
          to: { kind: COLUMN_KIND, key: { table: tableKeyOf(database.name, target.name), name: reference.target_column } },
          discriminator: reference.column,
          values: { column: reference.column, target_column: reference.target_column, constraint: reference.constraint },
          evidence: evidenceOf(reference.place),
        });
      }
    }
  }
  const partial = model.problems.length > 0;
  return {
    vertices,
    edges,
    end: partial
      ? { state: 'partial', cause: `${String(model.problems.length)} literal${model.problems.length === 1 ? '' : 's'} could not be read whole: ${model.problems.map((problem) => `${problem.repository}/${problem.path}:${String(problem.line)} ${problem.message}`).join('; ')}` }
      : { state: 'complete' },
  };
}

/** A table's key value inside a column or index key: its database and its name, as one path. */
function tableKeyOf(database: string, table: string): string {
  return `${database}/${table}`;
}

// ---- one entity's values ---------------------------------------------------------------------

/**
 * One entity's field values, by field name. They are assembled here, in one function per kind, and nowhere else: protocol
 * `madarch.plugins/2` answers one `values` map per entity with one evidence list instead of `attributes` and `claims`, so
 * a move to it changes `vertexOf` and the declaration's field markers alone, never the reading below.
 */
type Values = Readonly<Record<string, unknown>>;

/** One entity as the plugin answers it: its kind, its key, its values and the place it was read at. */
function vertexOf(kind: string, key: Readonly<Record<string, string>>, values: Values, place: Place): VertexResult {
  return { kind, key, values, evidence: evidenceOf(place) };
}

/** A database's values: the repository whose SQL names it. */
function databaseValuesOf(database: Database): Values {
  return { repository: database.repository };
}

/** A table's values: the schema the SQL names (null for `public`). Its database stands in its key, not as a value. */
function tableValuesOf(_database: Database, table: Table): Values {
  return { schema: table.schema, unsupported: table.notes.join("\n") || null };
}

/** A column's values: its type, whether it admits null, its default, its key flags and its checks. Its table is its key. */
function columnValuesOf(_tableKey: string, column: Column): Values {
  return { type: column.type, nullable: column.nullable, default: column.defaultText, primary_key: column.primary_key, unique: column.unique, check: column.checks };
}

/** An index's values: whether it is unique, the columns it covers and a partial index's predicate. Its table is its key. */
function indexValuesOf(_tableKey: string, index: Index): Values {
  return { unique: index.unique, columns: index.columns, where: index.where };
}

/** Code point order, as the host orders keys. */
function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

// ---- the declaration -------------------------------------------------------------------------

/** One field of the declaration: a field the plugin states of the entities it reads from the SQL it parses. */
type Field = { readonly name: string; readonly type: 'text' | 'integer' | 'bigint' | 'boolean' | 'timestamp' | 'json'; readonly meaning: string; readonly example: unknown; readonly required: boolean };

/** One field the plugin states, as its contract and the manifest binding name it. */
function field(name: string, type: Field['type'], meaning: string, example: unknown, required: boolean): Field {
  return { name, type, meaning, example, required };
}

const CONTRACT = {
  vertices: [
    {
      kind: DATABASE_KIND,
      key: ['name'],
      fields: [
        field('name', 'text', 'The database a code repository\'s SQL writes to, named after the repository.', 'madarch', true),
        field('repository', 'text', 'The product\'s repository whose code holds the SQL.', 'madarch', true),
      ],
    },
    {
      kind: TABLE_KIND,
      key: ['database', 'name'],
      fields: [
        field('database', 'text', 'The database the table stands in, by its name.', 'madarch', true),
        field('name', 'text', 'The table\'s name, schema-qualified when the SQL names a schema other than public.', 'node', true),
        field('schema', 'text', 'The schema the table stands in, when the SQL names one other than public.', 'graph', false),
        field('unsupported', 'text', 'Unsupported SQL and ambiguous declarations that prevent a complete table description.', 'unsupported expression index', false),
      ],
    },
    {
      kind: COLUMN_KIND,
      key: ['table', 'name'],
      fields: [
        field('table', 'text', 'The table that holds the column, as its database and its name.', 'madarch/node', true),
        field('name', 'text', 'The column\'s name.', 'kind_id', true),
        field('type', 'text', 'The column\'s type, as the SQL writes it.', 'bigint', true),
        field('nullable', 'boolean', 'Whether the column admits null.', false, true),
        field('default', 'text', 'The column\'s default value, as the SQL writes it; null when it has none.', 'gen_random_uuid()', false),
        field('primary_key', 'boolean', 'Whether the column is part of the table\'s primary key.', true, true),
        field('unique', 'boolean', 'Whether the column alone is unique.', false, true),
        field('check', 'json', 'The CHECK expressions the column holds, as the SQL writes them.', ['line_end >= line_start'], false),
      ],
    },
    {
      kind: INDEX_KIND,
      key: ['table', 'name'],
      fields: [
        field('table', 'text', 'The table the index covers, as its database and its name.', 'madarch/edge', true),
        field('name', 'text', 'The index\'s name.', 'edge_once', true),
        field('unique', 'boolean', 'Whether the index is unique.', true, true),
        field('columns', 'json', 'The columns the index covers, in order.', ['kind_id', 'from_node'], true),
        field('where', 'text', 'The predicate of a partial index, as the SQL writes it; null when it covers every row.', 'parent IS NULL', false),
      ],
    },
  ],
  edges: [
    { kind: HAS_COLUMN, from: TABLE_KIND, to: COLUMN_KIND },
    { kind: HAS_INDEX, from: TABLE_KIND, to: INDEX_KIND },
    {
      kind: FOREIGN_KEY,
      from: COLUMN_KIND,
      to: COLUMN_KIND,
      fields: [
        field('column', 'text', 'The column that holds the key.', 'kind_id', true),
        field('target_column', 'text', 'The column it references.', 'id', true),
        field('constraint', 'text', 'The name the SQL gives the foreign key, when it names one.', 'edge_kind_id_fkey', false),
      ],
    },
    { kind: DECLARED_IN, from: TABLE_KIND, to: 'code.file' },
  ],
};

await definePlugin({
  name: 'db-schema',
  version: '1.0.0',
  // The graph's file vertices and their content, and no repository: the files producer alone reads the source.
  graph: true,
  contract: CONTRACT,
  extract,
});
