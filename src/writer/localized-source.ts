/** Localized, source-grounded Markdown for extracted document entities. */
import { parseDocument, stringify } from 'yaml';
import type { DocEntity } from '../knowledge/doc-entities.js';
import { createHash } from 'node:crypto';
import type { McpToolDefinition } from '../fill/unit-mcp.js';

export const LOCALIZED_SOURCE_SCHEMA = 'madarch.localized-document-source@1';

/** Identify the two supported source languages from prose, not code identifiers or known field labels. */
export function detectDocumentLanguage(text: string): 'en' | 'ru' | undefined {
  const prose = text.replace(/`[^`]*`/g, ' ').replace(/^\s*(?:In code|Code names|Also called|Synonyms|Used in|Ambiguous|в коде|также называют|синонимы|где используется|неоднозначно)\s*:\s*.*$/gim, ' ');
  const letters = [...prose.matchAll(/[\p{L}]/gu)].map((match) => match[0]!);
  if (letters.length < 8) return undefined;
  const cyrillic = letters.filter((letter) => /\p{Script=Cyrillic}/u.test(letter)).length;
  const latin = letters.filter((letter) => /\p{Script=Latin}/u.test(letter)).length;
  const total = cyrillic + latin;
  if (total < 8 || Math.min(cyrillic, latin) / total > 0.15) return undefined;
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
  const lines = text.replace(/\r\n/g, '\n').split('\n');
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
  const match = /^## Localized statement\s*\n+([\s\S]*?)\n+## In the source\s*\n+([\s\S]*?)\s*$/.exec(body.trim());
  if (match === null || match[1]!.trim() === '' || match[2]!.trim() === '') return { ok: false, line: end + 2, message: 'localized source has non-empty Localized statement and In the source sections' };
  const statementLetters = [...match[1]!.matchAll(/[\p{L}]/gu)].map((item) => item[0]!);
  const cyrillic = statementLetters.filter((letter) => /\p{Script=Cyrillic}/u.test(letter)).length;
  const latin = statementLetters.filter((letter) => /\p{Script=Latin}/u.test(letter)).length;
  if (language === 'ru' && cyrillic < 4 || language === 'en' && latin < 4) return { ok: false, line: end + 2, message: `localized statement does not appear to be in ${language}` };
  if (match[2]!.trim() !== entity.text.trim()) return { ok: false, line: end + 2 + body.split('\n').findIndex((line) => line.trim() === '## In the source') + 1, message: 'In the source does not match the current extracted document section' };
  return { ok: true, source: {
    schema: LOCALIZED_SOURCE_SCHEMA, entity: entity.id, kind: entity.kind,
    wikiLanguage: language as 'en' | 'ru', sourceLanguage: sourceLanguage as 'en' | 'ru',
    sourceDocument: String(record['source-document']), sourceLine: entity.line, sourceEndLine: entity.endLine,
    original: entity.text, statement: match[1]!.trim(),
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
