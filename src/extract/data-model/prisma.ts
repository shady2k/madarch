/**
 * A small reader of Prisma schema files: the models a `schema.prisma`
 * declares, with their mapped table and column names, their nullability,
 * defaults, keys and relations, each with the byte span it stands at
 * (records.ts, SourceSpan). Pure: the text in, the models out.
 */
import type {SourceSpan} from '../records.js';
import {ByteText} from './text-scan.js';

export interface PrismaField {
  /** The field's name as the schema writes it (`orderId`). */
  readonly field: string;
  /** The column's database name (`order_id`), from `@map` or the field's own name. */
  readonly column: string;
  /** The declared type (`String`, `Int`, `DateTime`). */
  readonly type: string;
  readonly nullable: boolean;
  readonly primaryKey: boolean;
  readonly unique: boolean;
  readonly default?: string;
  /** The relation the field carries, with the fields and references it names. */
  readonly relation?: {
    readonly fields: readonly string[];
    readonly references: readonly string[];
    readonly onDelete?: string;
    readonly onUpdate?: string;
  };
  /** The field's own span: its line, where a comment above it starts with it. */
  readonly span: SourceSpan;
  /** The comment block directly above the field, its markers kept, where one stands there. */
  readonly comment?: string;
  /** Whether the field is a relation and no column of the table (`refunds Refund[]`). */
  readonly isRelation: boolean;
}

export interface PrismaModelAttribute {
  readonly columns: readonly string[];
  readonly name?: string;
}

export interface PrismaModel {
  /** The model's name as the schema writes it (`Payment`). */
  readonly model: string;
  /** The table's database name (`payments`), from `@@map` or the model's own name. */
  readonly table: string;
  readonly fields: readonly PrismaField[];
  readonly indexes: readonly PrismaModelAttribute[];
  readonly uniqueIndexes: readonly PrismaModelAttribute[];
  /** The whole model block's span. */
  readonly span: SourceSpan;
}

/**
 * Reads one schema's models. A file that declares no model yields an empty
 * list; the caller turns that into a gap, never a silence.
 */
export function parsePrismaSchema(path: string, text: string): readonly PrismaModel[] {
  const bytes = new ByteText(text);
  const models: PrismaModel[] = [];
  const blockPattern = /\bmodel\s+([A-Za-z_]\w*)\s*\{/g;
  for (let match = blockPattern.exec(text); match !== null; match = blockPattern.exec(text)) {
    const openBrace = match.index + match[0].length - 1;
    const closeBrace = matchingBrace(text, openBrace);
    if (closeBrace === -1) continue;
    const body = text.slice(openBrace + 1, closeBrace);
    const bodyStart = openBrace + 1;
    const fields: PrismaField[] = [];
    const indexes: PrismaModelAttribute[] = [];
    const uniqueIndexes: PrismaModelAttribute[] = [];
    let table = match[1]!;
    const lines = linePieces(body, bodyStart);
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
      const line = lines[lineIndex]!;
      const lineText = line.text.trim();
      if (lineText === '' || lineText.startsWith('//')) continue;
      if (lineText.startsWith('@@')) {
        const map = /^@@map\(\s*"([^"]*)"\s*\)/.exec(lineText);
        if (map !== null) {
          table = map[1]!;
          continue;
        }
        const index = /^@@index\(\s*\[([^\]]*)\]\s*(?:,\s*map:\s*"([^"]*)")?\s*\)/.exec(lineText);
        if (index !== null) {
          indexes.push({columns: names(index[1]!), name: index[2]});
          continue;
        }
        const unique = /^@@unique\(\s*\[([^\]]*)\]\s*(?:,\s*map:\s*"([^"]*)")?\s*\)/.exec(lineText);
        if (unique !== null) {
          uniqueIndexes.push({columns: names(unique[1]!), name: unique[2]});
          continue;
        }
        continue;
      }
      const field = parseField(path, bytes, line.start, lineText, lines, lineIndex);
      if (field !== undefined) fields.push(field);
    }
    models.push({
      model: match[1]!,
      table,
      fields,
      indexes,
      uniqueIndexes,
      span: {path, byteStart: bytes.byteAt(match.index), byteEnd: bytes.byteAt(closeBrace + 1), lineStart: bytes.lineOf(bytes.byteAt(match.index)), lineEnd: bytes.lineOf(bytes.byteAt(closeBrace + 1))},
    });
  }
  return models;
}

interface LinePiece {
  readonly start: number;
  readonly text: string;
}

function linePieces(text: string, base: number): readonly LinePiece[] {
  const pieces: LinePiece[] = [];
  let start = 0;
  for (let index = 0; index <= text.length; index++) {
    if (index === text.length || text[index] === '\n') {
      pieces.push({start: base + start, text: text.slice(start, index)});
      start = index + 1;
    }
  }
  return pieces;
}

function parseField(
  path: string,
  bytes: ByteText,
  lineStart: number,
  lineText: string,
  lines: readonly LinePiece[],
  lineIndex: number,
): PrismaField | undefined {
  const match = /^([A-Za-z_]\w*)\s+([A-Za-z_]\w*)(\[\])?(\?)?(?:\s+(@[\s\S]*))?$/.exec(lineText);
  if (match === null) return undefined;
  const field = match[1]!;
  const type = match[2]!;
  const isList = match[3] !== undefined;
  const optional = match[4] !== undefined;
  const attributes = match[5] ?? '';
  const map = /@map\(\s*"([^"]*)"\s*\)/.exec(attributes)?.[1];
  const id = /@id\b/.test(attributes);
  const unique = /@unique\b/.test(attributes);
  const defaultMatch = /@default\(\s*([^)]*?)\s*\)/.exec(attributes)?.[1];
  const relationMatch = /@relation\(\s*([\s\S]*?)\s*\)/.exec(attributes)?.[1];
  let relation: PrismaField['relation'] | undefined;
  if (relationMatch !== undefined) {
    const fields = /fields:\s*\[([^\]]*)\]/.exec(relationMatch)?.[1];
    const references = /references:\s*\[([^\]]*)\]/.exec(relationMatch)?.[1];
    const onDelete = /onDelete:\s*(\w+)/.exec(relationMatch)?.[1];
    const onUpdate = /onUpdate:\s*(\w+)/.exec(relationMatch)?.[1];
    relation = {
      fields: fields !== undefined ? names(fields) : [],
      references: references !== undefined ? names(references) : [],
      ...(onDelete !== undefined ? {onDelete} : {}),
      ...(onUpdate !== undefined ? {onUpdate} : {}),
    };
  }
  // A relation field names no column: a list (`refunds Refund[]`) or any
  // `@relation` field (`payment Payment @relation(fields: [paymentId], ...)`),
  // whose scalar columns the `fields` list names.
  const isRelation = isList || relation !== undefined;
  // The comment block whose lines stand directly above the field cites the
  // field's intent; the field's span starts at it, so a record of the field
  // cites what the schema says about it.
  const commentLines: string[] = [];
  let commentStart = -1;
  for (let index = lineIndex - 1; index >= 0; index--) {
    const trimmed = lines[index]!.text.trim();
    if (!trimmed.startsWith('//')) break;
    commentLines.unshift(lines[index]!.text);
    commentStart = lines[index]!.start;
  }
  const spanStart = commentStart === -1 ? lineStart : commentStart;
  return {
    field,
    column: map ?? field,
    type,
    nullable: optional && !id,
    primaryKey: id,
    unique: unique || id,
    ...(defaultMatch !== undefined ? {default: defaultMatch} : {}),
    ...(relation !== undefined ? {relation} : {}),
    span: {
      path,
      byteStart: bytes.byteAt(spanStart),
      byteEnd: bytes.byteAt(lineStart + lineText.length),
      lineStart: bytes.lineOf(bytes.byteAt(spanStart)),
      lineEnd: bytes.lineOf(bytes.byteAt(lineStart + lineText.length)),
    },
    ...(commentLines.length > 0 ? {comment: commentLines.join('\n')} : {}),
    isRelation,
  };
}

function matchingBrace(text: string, open: number): number {
  let depth = 0;
  let index = open;
  while (index < text.length) {
    const character = text[index];
    if (character === '/' && text[index + 1] === '/') {
      while (index < text.length && text[index] !== '\n') index++;
      continue;
    }
    if (character === '"') {
      index++;
      while (index < text.length && text[index] !== '"') index++;
      index++;
      continue;
    }
    if (character === '{') depth++;
    if (character === '}') {
      depth--;
      if (depth === 0) return index;
    }
    index++;
  }
  return -1;
}

/** The field or column names a `[a, b]` attribute list holds. */
function names(list: string): readonly string[] {
  return list.split(',').map((part) => part.trim()).filter((part) => part !== '');
}
