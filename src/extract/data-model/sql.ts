/**
 * A small reader of PostgreSQL DDL: the CREATE TABLE, ALTER TABLE and CREATE
 * INDEX statements a migration or seed script declares, each with the byte
 * span it stands at (records.ts, SourceSpan). It reads the dialect the
 * training repository's migrations are written in: quoted or bare identifiers,
 * schema-qualified names, inline column constraints, table constraints and
 * partial indexes with a WHERE clause. Pure: the text in, the statements out.
 */
import type {SourceSpan} from '../records.js';
import {ByteText} from './text-scan.js';

export interface SqlColumnDecl {
  readonly name: string;
  readonly type: string;
  readonly nullable: boolean;
  readonly default?: string;
  readonly primaryKey: boolean;
  readonly unique: boolean;
  readonly check?: string;
  /** The inline `REFERENCES` the column's definition carries, where it does. */
  readonly foreignKey?: SqlForeignKeyDecl;
  readonly span: SourceSpan;
}

export interface SqlForeignKeyDecl {
  readonly column: string;
  readonly targetTable: string;
  readonly targetSchema?: string;
  readonly targetColumn?: string;
  readonly onDelete?: string;
  readonly onUpdate?: string;
  readonly constraint?: string;
}

export interface SqlIndexDecl {
  readonly name: string;
  readonly columns: readonly string[];
  readonly unique: boolean;
  readonly where?: string;
  readonly span: SourceSpan;
}

export interface SqlTableDecl {
  readonly name: string;
  readonly schema: string;
  readonly columns: readonly SqlColumnDecl[];
  readonly foreignKeys: readonly SqlForeignKeyDecl[];
  readonly primaryKey: readonly string[];
  readonly span: SourceSpan;
}

export type SqlStatement =
  | {readonly kind: 'create-table'; readonly table: SqlTableDecl}
  | {readonly kind: 'alter-table-add-column'; readonly table: string; readonly schema: string; readonly column: SqlColumnDecl}
  | {readonly kind: 'alter-table-add-foreign-key'; readonly table: string; readonly schema: string; readonly foreignKey: SqlForeignKeyDecl; readonly span: SourceSpan}
  | {readonly kind: 'create-index'; readonly table: string; readonly schema: string; readonly index: SqlIndexDecl}
  | {readonly kind: 'other'};

/** One script read: its statements, each with its place. */
export interface SqlScript {
  readonly statements: readonly SqlStatement[];
}

/**
 * Reads one script's statements. `path` names the script in every span. A
 * script whose text holds no readable statement yields an empty list; the
 * caller turns that into a gap, never a silence.
 */
export function parseSqlScript(path: string, text: string): SqlScript {
  const bytes = new ByteText(text);
  const statements: SqlStatement[] = [];
  for (const piece of splitStatements(text)) {
    const statement = parseStatement(path, bytes, piece.start, piece.end);
    if (statement !== undefined) statements.push(statement);
  }
  return {statements};
}

interface Piece {
  readonly start: number;
  readonly end: number;
}

/** Splits the script on `;` outside strings, comments and parentheses. */
function splitStatements(text: string): readonly Piece[] {
  const pieces: Piece[] = [];
  let depth = 0;
  let start = 0;
  let index = 0;
  while (index < text.length) {
    const character = text[index];
    if (character === "'") {
      index = skipSingleQuoted(text, index);
      continue;
    }
    if (character === '-' && text[index + 1] === '-') {
      while (index < text.length && text[index] !== '\n') index++;
      continue;
    }
    if (character === '/' && text[index + 1] === '*') {
      index += 2;
      while (index < text.length && !(text[index] === '*' && text[index + 1] === '/')) index++;
      index = Math.min(text.length, index + 2);
      continue;
    }
    if (character === '(') depth++;
    if (character === ')') depth = Math.max(0, depth - 1);
    if (character === ';' && depth <= 0) {
      pieces.push({start, end: index});
      start = index + 1;
    }
    index++;
  }
  if (text.slice(start).trim() !== '') pieces.push({start, end: text.length});
  return pieces;
}

function skipSingleQuoted(text: string, open: number): number {
  let index = open + 1;
  while (index < text.length) {
    if (text[index] === "'" && text[index + 1] === "'") {
      index += 2;
      continue;
    }
    if (text[index] === "'") return index + 1;
    index++;
  }
  return index;
}

/**
 * Replaces every comment's characters with spaces (newlines kept), so the
 * offsets of the text stay the same and a body split never reads a comment as
 * a column.
 */
function stripComments(text: string): string {
  const out = [...text];
  let index = 0;
  while (index < text.length) {
    const character = text[index];
    if (character === "'") {
      index = skipSingleQuoted(text, index);
      continue;
    }
    if (character === '-' && text[index + 1] === '-') {
      const start = index;
      while (index < text.length && text[index] !== '\n') index++;
      for (let at = start; at < index; at++) out[at] = ' ';
      continue;
    }
    if (character === '/' && text[index + 1] === '*') {
      const start = index;
      index += 2;
      while (index < text.length && !(text[index] === '*' && text[index + 1] === '/')) index++;
      index = Math.min(text.length, index + 2);
      for (let at = start; at < index; at++) if (out[at] !== '\n') out[at] = ' ';
      continue;
    }
    index++;
  }
  return out.join('');
}

/** The half-open byte and line span of a character range of the file. */
function spanOf(bytes: ByteText, path: string, start: number, end: number): SourceSpan {
  return {
    path,
    byteStart: bytes.byteAt(start),
    byteEnd: bytes.byteAt(end),
    lineStart: bytes.lineOf(bytes.byteAt(start)),
    lineEnd: bytes.lineOf(bytes.byteAt(end)),
  };
}

function parseStatement(path: string, bytes: ByteText, pieceStart: number, pieceEnd: number): SqlStatement | undefined {
  const text = stripComments(bytes.text.slice(pieceStart, pieceEnd));
  const start = pieceStart + (text.length - text.trimStart().length);
  const trimmed = text.trim();
  if (trimmed === '') return undefined;
  const span = (): SourceSpan => spanOf(bytes, path, start, start + trimmed.length);

  const createTable = /^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:(?:"?(\w+)"?)\.)?("?(\w+)"?)\s*\(/i.exec(trimmed);
  if (createTable !== null) {
    const table = parseCreateTable(path, bytes, start, trimmed);
    if (table !== undefined) return {kind: 'create-table', table};
    return {kind: 'other'};
  }

  const createIndex =
    /^CREATE\s+(UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:(?:"?(\w+)"?)\.)?"?(\w+)"?\s+ON\s+(?:(?:"?(\w+)"?)\.)?"?(\w+)"?\s*\(([^)]*)\)(?:\s+WHERE\s+([\s\S]+))?$/i.exec(
      trimmed,
    );
  if (createIndex !== null) {
    const index: SqlIndexDecl = {
      name: unquote(createIndex[3]!),
      columns: createIndex[6]!.split(',').map((part) => identifierHead(part)).filter((column) => column !== ''),
      unique: createIndex[1] !== undefined,
      where: createIndex[7] !== undefined && createIndex[7].trim() !== '' ? createIndex[7].trim() : undefined,
      span: span(),
    };
    const schema = unquote(createIndex[4] ?? '');
    return {kind: 'create-index', table: unquote(createIndex[5]!), schema: schema === '' ? 'public' : schema, index};
  }

  const addColumn = /^ALTER\s+TABLE\s+(?:(?:"?(\w+)"?)\.)?"?(\w+)"?\s+ADD\s+COLUMN\s+([\s\S]+)$/i.exec(trimmed);
  if (addColumn !== null) {
    const column = parseColumnDef(path, bytes, start + (trimmed.length - addColumn[3]!.length), addColumn[3]!);
    if (column === undefined) return {kind: 'other'};
    const schema = unquote(addColumn[1] ?? '');
    return {kind: 'alter-table-add-column', table: unquote(addColumn[2]!), schema: schema === '' ? 'public' : schema, column};
  }

  const addForeignKey =
    /^ALTER\s+TABLE\s+(?:(?:"?(\w+)"?)\.)?"?(\w+)"?\s+ADD\s+CONSTRAINT\s+"?(\w+)"?\s+FOREIGN\s+KEY\s*\(\s*"?(\w+)"?\s*\)\s+REFERENCES\s+([\s\S]+)$/i.exec(
      trimmed,
    );
  if (addForeignKey !== null) {
    const target = parseReferenceTarget(addForeignKey[5]!);
    if (target === undefined) return {kind: 'other'};
    const schema = unquote(addForeignKey[1] ?? '');
    return {
      kind: 'alter-table-add-foreign-key',
      table: unquote(addForeignKey[2]!),
      schema: schema === '' ? 'public' : schema,
      foreignKey: {column: unquote(addForeignKey[4]!), constraint: unquote(addForeignKey[3]!), ...target},
      span: span(),
    };
  }
  return {kind: 'other'};
}

function parseCreateTable(path: string, bytes: ByteText, statementStart: number, trimmed: string): SqlTableDecl | undefined {
  const head = /^CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:(?:"?(\w+)"?)\.)?("?(\w+)"?)\s*\(/i.exec(trimmed)!;
  const schema = unquote(head[1] ?? '');
  const name = unquote(head[3] ?? head[2]!);
  const openParen = trimmed.indexOf('(', head[0].length - 1);
  const closeParen = matchingParen(trimmed, openParen);
  if (openParen === -1 || closeParen === -1) return undefined;
  const body = trimmed.slice(openParen + 1, closeParen);
  const columns: SqlColumnDecl[] = [];
  const foreignKeys: SqlForeignKeyDecl[] = [];
  const primaryKey: string[] = [];
  for (const part of splitTopLevel(body, ',')) {
    const partText = part.text.trim();
    if (partText === '') continue;
    const firstWord = /^"?([\w]+)"?/.exec(partText)?.[1] ?? '';
    if (TABLE_CONSTRAINT_WORDS.has(firstWord.toUpperCase())) {
      const constraint = parseTableConstraint(partText);
      if (constraint?.kind === 'primary') primaryKey.push(...constraint.columns);
      if (constraint?.kind === 'foreign') foreignKeys.push(constraint.foreignKey);
      continue;
    }
    const column = parseColumnDef(path, bytes, statementStart + openParen + 1 + part.start + (part.text.length - partText.length), partText);
    if (column !== undefined) columns.push(column);
  }
  return {
    name,
    schema: schema === '' ? 'public' : schema,
    columns,
    foreignKeys,
    primaryKey,
    span: spanOf(bytes, path, statementStart, statementStart + closeParen + 1),
  };
}

const TABLE_CONSTRAINT_WORDS = new Set(['CONSTRAINT', 'PRIMARY', 'FOREIGN', 'UNIQUE', 'CHECK']);

type TableConstraint =
  | {readonly kind: 'primary'; readonly columns: readonly string[]}
  | {readonly kind: 'foreign'; readonly foreignKey: SqlForeignKeyDecl}
  | {readonly kind: 'unique'; readonly columns: readonly string[]}
  | {readonly kind: 'other'};

function parseTableConstraint(part: string): TableConstraint {
  const withoutName = /^CONSTRAINT\s+"?\w+"?\s+([\s\S]+)$/i.exec(part)?.[1] ?? part;
  const primary = /^PRIMARY\s+KEY\s*\(([^)]*)\)/i.exec(withoutName);
  if (primary !== null) {
    return {kind: 'primary', columns: primary[1]!.split(',').map(identifierHead).filter((column) => column !== '')};
  }
  const foreign = /^FOREIGN\s+KEY\s*\(\s*"?(\w+)"?\s*\)\s+REFERENCES\s+([\s\S]+)$/i.exec(withoutName);
  if (foreign !== null) {
    const target = parseReferenceTarget(foreign[2]!);
    if (target !== undefined) return {kind: 'foreign', foreignKey: {column: unquote(foreign[1]!), ...target}};
  }
  const unique = /^UNIQUE\s*\(([^)]*)\)/i.exec(withoutName);
  if (unique !== null) {
    return {kind: 'unique', columns: unique[1]!.split(',').map(identifierHead).filter((column) => column !== '')};
  }
  return {kind: 'other'};
}

/** Parses `target_table (column) [ON DELETE x] [ON UPDATE y]` after REFERENCES. */
function parseReferenceTarget(text: string): Omit<SqlForeignKeyDecl, 'column' | 'constraint'> | undefined {
  const match =
    /^\s*(?:(?:"?(\w+)"?)\.)?"?(\w+)"?\s*(?:\(\s*"?(\w+)"?\s*\))?((?:\s+ON\s+(?:DELETE|UPDATE)\s+(?:CASCADE|RESTRICT|NO\s+ACTION|SET\s+NULL|SET\s+DEFAULT))*)\s*$/i.exec(
      text.trim().replace(/;$/, ''),
    );
  if (match === null) return undefined;
  const actions = match[4] ?? '';
  const onDelete = /ON\s+DELETE\s+(CASCADE|RESTRICT|NO\s+ACTION|SET\s+NULL|SET\s+DEFAULT)/i.exec(actions)?.[1]?.toUpperCase().replace(/\s+/g, ' ');
  const onUpdate = /ON\s+UPDATE\s+(CASCADE|RESTRICT|NO\s+ACTION|SET\s+NULL|SET\s+DEFAULT)/i.exec(actions)?.[1]?.toUpperCase().replace(/\s+/g, ' ');
  const targetSchema = unquote(match[1] ?? '');
  return {
    targetTable: unquote(match[2]!),
    ...(targetSchema === '' ? {} : {targetSchema}),
    ...(match[3] !== undefined ? {targetColumn: unquote(match[3])} : {}),
    ...(onDelete !== undefined ? {onDelete} : {}),
    ...(onUpdate !== undefined ? {onUpdate} : {}),
  };
}

/** Parses one column definition: `name TYPE [constraints]`, at its own place in the file. */
function parseColumnDef(path: string, bytes: ByteText, partStart: number, partText: string): SqlColumnDecl | undefined {
  const match = /^"?(\w+)"?\s+(\w+)\s*(\([^)]*\))?([\s\S]*)$/.exec(partText);
  if (match === null) return undefined;
  const name = unquote(match[1]!);
  let type = match[2]!.toUpperCase();
  if (match[3] !== undefined) type += match[3].replace(/\s+/g, '').toUpperCase();
  const tail = match[4] ?? '';
  const nullable = !/\bNOT\s+NULL\b/i.test(tail) && !/\bPRIMARY\s+KEY\b/i.test(tail);
  const primaryKey = /\bPRIMARY\s+KEY\b/i.test(tail);
  const unique = /\bUNIQUE\b/i.test(tail);
  const defaultMatch = /\bDEFAULT\s+(now\s*\(\s*\)|[A-Za-z_]\w*(?:\s*\(\s*\))?|'[^']*'|[+-]?\d+(?:\.\d+)?)/i.exec(tail);
  const defaultValue = defaultMatch !== null ? defaultMatch[1]!.replace(/\s+/g, '').toUpperCase() === 'NOW()' ? 'now()' : defaultMatch[1] : undefined;
  const referenceMatch = /\bREFERENCES\s+([\s\S]+)$/i.exec(tail);
  let foreignKey: SqlForeignKeyDecl | undefined;
  if (referenceMatch !== null) {
    const target = parseReferenceTarget(referenceMatch[1]!);
    if (target !== undefined) foreignKey = {column: name, ...target};
  }
  const checkMatch = /\bCHECK\s*\(/i.exec(tail);
  let check: string | undefined;
  if (checkMatch !== null) {
    const open = checkMatch.index + checkMatch[0].length - 1;
    const close = matchingParen(tail, open);
    if (close !== -1) check = tail.slice(open + 1, close).trim();
  }
  return {
    name,
    type,
    nullable,
    primaryKey,
    unique,
    ...(defaultValue !== undefined ? {default: defaultValue} : {}),
    ...(check !== undefined ? {check} : {}),
    ...(foreignKey !== undefined ? {foreignKey} : {}),
    span: spanOf(bytes, path, partStart, partStart + partText.length),
  };
}

function matchingParen(text: string, open: number): number {
  let depth = 0;
  let index = open;
  while (index < text.length) {
    const character = text[index];
    if (character === "'") {
      index = skipSingleQuoted(text, index);
      continue;
    }
    if (character === '(') depth++;
    if (character === ')') {
      depth--;
      if (depth === 0) return index;
    }
    index++;
  }
  return -1;
}

interface Piece2 {
  readonly start: number;
  readonly text: string;
}

function splitTopLevel(text: string, separator: string): readonly Piece2[] {
  const parts: Piece2[] = [];
  let depth = 0;
  let start = 0;
  let index = 0;
  while (index < text.length) {
    const character = text[index];
    if (character === "'") {
      index = skipSingleQuoted(text, index);
      continue;
    }
    if (character === '(') depth++;
    if (character === ')') depth--;
    if (character === separator && depth === 0) {
      parts.push({start, text: text.slice(start, index)});
      start = index + 1;
    }
    index++;
  }
  parts.push({start, text: text.slice(start)});
  return parts;
}

function unquote(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) return trimmed.slice(1, -1);
  return trimmed;
}

/** The bare identifier a piece of column list names, without quotes, collation or an order. */
function identifierHead(part: string): string {
  return unquote(part.trim().split(/\s+/)[0] ?? '');
}
