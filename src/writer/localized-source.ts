/** Localized, source-grounded Markdown for extracted document entities. */
import { parseDocument, stringify } from 'yaml';
import type { DocEntity } from '../knowledge/doc-entities.js';
import { createHash } from 'node:crypto';
import type { McpToolDefinition } from '../fill/unit-mcp.js';
import { readPage } from './sentences.js';

export const LOCALIZED_SOURCE_SCHEMA = 'madarch.localized-document-source@1';

/** A short `Label: value` line is a glossary field, not prose; the structure is a colon, not a word list. */
function isFieldLine(line: string): boolean {
  let text = line.trim();
  if (text.startsWith('- ') || text.startsWith('* ') || text.startsWith('+ ')) text = text.slice(2).trimStart();
  const colon = text.indexOf(':');
  if (colon < 2 || colon > 24) return false;
  const label = text.slice(0, colon).trim();
  // A glossary's field label opens with a capital (`In code`, `Also called`, `В коде`);
  // a definition that happens to hold a colon opens as prose (`one purchase: ...`).
  let words = 1;
  let letters = 0;
  let first = '';
  for (const character of label) {
    if (character.trim() === '') words += 1;
    else {
      if (first === '') first = character;
      if (character.toLowerCase() !== character.toUpperCase()) letters += 1;
    }
  }
  return letters > 0 && words <= 3 && first !== '' && first === first.toUpperCase() && first !== first.toLowerCase();
}

function languageCounts(text: string): { cyrillic: number; latin: number } {
  const prose = text.split('\n').filter((line) => !isFieldLine(line)).join('\n');
  let cyrillic = 0;
  let latin = 0;
  for (const token of readPage(prose).tokens) {
    if (token.kind !== 'text') continue;
    for (const character of token.value) {
      const code = character.codePointAt(0) ?? 0;
      if (code >= 0x0400 && code <= 0x04ff) cyrillic += 1;
      else if ((code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a) || (code >= 0x00c0 && code <= 0x024f) || (code >= 0x1e00 && code <= 0x1eff)) latin += 1;
    }
  }
  return { cyrillic, latin };
}

/** Identify source language from enough prose, not code identifiers or known field labels. */
export function detectDocumentLanguage(text: string): 'en' | 'ru' | undefined {
  const { cyrillic, latin } = languageCounts(text);
  const total = cyrillic + latin;
  if (total < 8 || Math.min(cyrillic, latin) / total > 0.15) return undefined;
  return cyrillic > latin ? 'ru' : 'en';
}

/** Validate even a short statement without imposing the document detector's minimum length. */
export function detectStatementLanguage(text: string): 'en' | 'ru' | undefined {
  const { cyrillic, latin } = languageCounts(text);
  const total = cyrillic + latin;
  if (total < 2 || Math.min(cyrillic, latin) / total > 0.15) return undefined;
  return cyrillic > latin ? 'ru' : 'en';
}
export interface LocalizedDocumentSource {
  schema: typeof LOCALIZED_SOURCE_SCHEMA;
  entity: string;
  kind: string;
  wikiLanguage: 'en' | 'ru';
  sourceLanguage: 'en' | 'ru';
  sourceDocument: string;
  sourceLine: number;
  sourceEndLine: number;
  original: string;
  statement: string;
}

/** A reversible, path-safe identity filename; ids can contain repository paths and fragments. */
export function localizedSourcePath(entity: Pick<DocEntity, 'id' | 'kind'>): string {
  const kind = entity.kind.replace(/[^A-Za-z0-9._-]/g, '_');
  if (kind === '' || kind === '.' || kind === '..' || entity.id === '') throw new Error(`src/writer/localized-source.ts: cannot form a localized source path for ${JSON.stringify(entity.id)} (${JSON.stringify(entity.kind)})`);
  const digest = createHash('sha256').update(entity.id, 'utf8').digest('hex');
  return `docs/sources/${kind}/${digest}.md`;
}

export function renderLocalizedSource(source: LocalizedDocumentSource): string {
  const front = stringify({
    schema: source.schema, entity: source.entity, kind: source.kind,
    'wiki-language': source.wikiLanguage, 'source-language': source.sourceLanguage,
    'source-document': source.sourceDocument, 'source-line': source.sourceLine,
    'source-end-line': source.sourceEndLine,
  }).trimEnd();
  return `---\n${front}\n---\n\n## Localized statement\n\n${source.statement.trim()}\n\n## In the source\n\n${source.original.trim()}\n`;
}

export type LocalizedSourceRead = { ok: true; source: LocalizedDocumentSource } | { ok: false; line: number; message: string };

/** Reads a product-owned artifact and checks its identity and immutable source against the current extracted entity. */
export function parseLocalizedSource(path: string, text: string, entity: DocEntity, language: string): LocalizedSourceRead {
  const lines = text.replaceAll('\r\n', '\n').split('\n');
  if (lines[0] !== '---') return { ok: false, line: 1, message: 'localized source starts with YAML front matter' };
  const end = lines.indexOf('---', 1);
  if (end < 0) return { ok: false, line: 1, message: 'localized source front matter is not closed' };
  const parsed = parseDocument(lines.slice(1, end).join('\n'), { uniqueKeys: true });
  if (parsed.errors.length > 0) return { ok: false, line: parsed.errors[0]?.linePos?.[0]?.line ?? 2, message: `localized source front matter is invalid: ${parsed.errors[0]!.message.split('\n')[0]}` };
  let meta: unknown;
  try { meta = parsed.toJS(); } catch (error) { return { ok: false, line: 2, message: `localized source front matter cannot be read: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}` }; }
  if (meta === null || typeof meta !== 'object' || Array.isArray(meta)) return { ok: false, line: 2, message: 'localized source front matter is a mapping' };
  const record = meta as Record<string, unknown>;
  const fail = (field: string, expected: string): LocalizedSourceRead => ({ ok: false, line: 2, message: `${field} is ${JSON.stringify(record[field])}; expected ${expected}` });
  if (record['schema'] !== LOCALIZED_SOURCE_SCHEMA) return fail('schema', JSON.stringify(LOCALIZED_SOURCE_SCHEMA));
  if (record['entity'] !== entity.id) return fail('entity', JSON.stringify(entity.id));
  if (record['kind'] !== entity.kind) return fail('kind', JSON.stringify(entity.kind));
  if (record['wiki-language'] !== language) return fail('wiki-language', JSON.stringify(language));
  if (record['source-document'] !== (entity.repo === null ? entity.path : `repos/${entity.repo}/${entity.path}`)) return fail('source-document', JSON.stringify(entity.repo === null ? entity.path : `repos/${entity.repo}/${entity.path}`));
  if (record['source-line'] !== entity.line) return fail('source-line', String(entity.line));
  if (record['source-end-line'] !== entity.endLine) return fail('source-end-line', String(entity.endLine));
  const sourceLanguage = record['source-language'];
  if (sourceLanguage !== 'en' && sourceLanguage !== 'ru') return fail('source-language', '"en" or "ru"');
  const body = lines.slice(end + 1).join('\n');
  const bodyLines = body.trim().split('\n');
  let statementAt = -1;
  let sourceAt = -1;
  for (let index = 0; index < bodyLines.length; index += 1) {
    if (statementAt < 0 && bodyLines[index]!.trim() === '## Localized statement') statementAt = index;
    else if (sourceAt < 0 && bodyLines[index]!.trim() === '## In the source') sourceAt = index;
  }
  if (statementAt < 0 || sourceAt <= statementAt) return { ok: false, line: end + 2, message: 'localized source has non-empty Localized statement and In the source sections' };
  const statement = bodyLines.slice(statementAt + 1, sourceAt).join('\n').trim();
  const original = bodyLines.slice(sourceAt + 1).join('\n').trim();
  if (statement === '' || original === '') return { ok: false, line: end + 2, message: 'localized source has non-empty Localized statement and In the source sections' };
  if (detectStatementLanguage(statement) !== language) return { ok: false, line: end + 2, message: `localized statement does not appear to be in ${language}` };
  if (original !== entity.text.trim()) return { ok: false, line: end + 3 + sourceAt, message: 'In the source does not match the current extracted document section' };
  return { ok: true, source: {
    schema: LOCALIZED_SOURCE_SCHEMA, entity: entity.id, kind: entity.kind,
    wikiLanguage: language as 'en' | 'ru', sourceLanguage: sourceLanguage as 'en' | 'ru',
    sourceDocument: String(record['source-document']), sourceLine: entity.line, sourceEndLine: entity.endLine,
    original: entity.text, statement,
  } };
}


export const LOCALIZED_SOURCE_TOOL: McpToolDefinition = {
  name: 'write_localized_source',
  description: 'Write the source-grounded localized statement for the one document entity in this unit. The core adds fixed identity and exact original-source metadata. The statement must be in the wiki language and supported by the source excerpt.',
  inputSchema: { type: 'object', additionalProperties: false, required: ['statement'], properties: { statement: { type: 'string', description: 'A concise grounded Markdown statement in the requested wiki language, without front matter or source quote.' } } },
};

export function localizedSourcePrompt(input: { entity: DocEntity; language: 'en' | 'ru'; sourceLanguage: 'en' | 'ru'; file: string }): string {
  const language = input.language === 'ru' ? 'Russian' : 'English';
  const sourceLanguage = input.sourceLanguage === 'ru' ? 'Russian' : 'English';
  return [
    'You are translating one extracted document entity for a product knowledge wiki.',
    `Write one concise, faithful, grounded statement in ${language}. Do not translate the entity name or identifier. Do not add facts or omit requirements, conditions, quantities, or uncertainty.`,
    `The source is in ${sourceLanguage}. The original source text is preserved exactly in ${input.file}; the core adds it to the generated file.`,
    'Use only the supplied source excerpt. Call write_localized_source exactly once. Do not write files or use other tools.',
    '',
    `Entity id: ${input.entity.id}`,
    `Entity kind: ${input.entity.kind}`,
    `Entity name: ${input.entity.title}`,
    `Source document: ${input.entity.repo === null ? input.entity.path : `repos/${input.entity.repo}/${input.entity.path}`}`,
    `Source line range: ${input.entity.line}-${input.entity.endLine}`,
    `Source section excerpt:
${input.entity.text}`,
    '',
    'Every change is reader-facing. The statement must be a complete, accurate rendering of this excerpt, not a summary that loses a smaller condition or result.',
  ].join('\n');
}
