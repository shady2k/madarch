/**
 * The blocks of a document entity's page and of any page that is stated in a
 * file (madarch-m38l.6): `stated` (the document and line the entity is stated
 * at), `implementedby` (the code the entity's text names, and the code the
 * product's pages ground together with it) and `linkedfrom` (the pages that
 * ground in it and the documents that name its identifier).
 *
 * Every row is a fact of the graph or of a file; a code place the text names
 * that the graph does not hold is a row marked broken with its reason, never
 * dropped.
 */
import { byCodePoint } from '../model/order.js';
import { refOfGraph, refOfMarkdown, type RenderContext, type Subject } from './blocks.js';
import type { DocEntity } from './doc-entities.js';
import type { GraphEntity } from './graph-read.js';
import { parseTermText } from './glossary.js';
import { detectDocumentLanguage } from '../writer/localized-source.js';
import { identifierMentions, madarchTargets } from '../writer/mentions.js';
import { readStatements } from './markdown.js';
import type { Block, EntityRef, RefRow } from './model.js';
import { documentAddress, entityAddress } from './resolve.js';

/** The most rows a list of references shows. */
const REFS_LIMIT = 50;

export function statedBlock(ctx: RenderContext, subject: Subject, params: Readonly<Record<string, string>>, file: string, line: number): Block {
  const title = params['title'] ?? 'Stated in';
  if (subject.source === 'document') {
    const doc = subject.entity;
    // A product with one code repository does not name it: the reader knows which repository the pages are written from.
    const single = doc.repo !== null && ctx.repositories.length === 1;
    return { type: 'stated', title, place: { repo: doc.repo, path: doc.path, lineStart: doc.line, lineEnd: doc.endLine, href: documentAddress(doc.repo, doc.path, doc.anchor), commit: doc.repo === null ? null : ctx.commitOf(doc.repo), ...(single ? { single: true } : {}) } };
  }
  if (subject.source === 'markdown') {
    return { type: 'stated', title, place: { repo: null, path: subject.entity.file, lineStart: subject.entity.bodyLine, lineEnd: subject.entity.bodyLine, href: documentAddress(null, subject.entity.file), commit: null } };
  }
  return { type: 'problem', block: 'stated', file, line, message: 'the stated block names the document an entity is written in; the entities of this kind come from the graph and are stated in code' };
}

/** File name endings a document names a file by; a dotted name such as `orders.events` is not a path. */
const FILE_ENDINGS = new Set(['md', 'markdown', 'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'go', 'mod', 'sum', 'json', 'yaml', 'yml', 'toml', 'sql', 'proto', 'prisma', 'sh', 'py', 'rb', 'java', 'kt', 'rs', 'c', 'h', 'cpp', 'cs', 'txt', 'xml', 'html', 'css', 'lock', 'example', 'env', 'conf']);
const PATH_LIKE = (code: string): boolean => !/\s/.test(code) && (code.includes('/') || FILE_ENDINGS.has(code.slice(code.lastIndexOf('.') + 1).toLowerCase()) && code.includes('.'));

/** A text's inline code spans that are paths, with the parenthesised list of names that follows one: "`a/b.go` (`Name`, `Other`)". */
export function codeMentions(text: string): { path: string; names: string[] }[] {
  const found: { path: string; names: string[] }[] = [];
  const pattern = /`([^`\n]+)`(?:\s*\(((?:\s*`[^`\n]+`\s*,?)+)\))?/g;
  for (const match of text.matchAll(pattern)) {
    const code = match[1]!.trim();
    if (!PATH_LIKE(code)) continue;
    const names = match[2] === undefined ? [] : [...match[2].matchAll(/`([^`\n]+)`/g)].map((entry) => entry[1]!.trim()).filter((name) => /^[A-Za-z_$][\w$.]*$/.test(name));
    found.push({ path: code, names });
  }
  return found;
}

/** The other inline code spans of a text, each with whether the word "table" follows it: a channel, a type, a table may be named so. */
export function nameMentions(text: string): { code: string; table: boolean }[] {
  const without = text.replace(/`([^`\n]+)`(?:\s*\(((?:\s*`[^`\n]+`\s*,?)+)\))?/g, (whole, code: string) => (PATH_LIKE(code.trim()) ? ' '.repeat(whole.length) : whole));
  return [...without.matchAll(/`([^`\n]+)`(\s+table\b)?/g)].map((match) => ({ code: match[1]!.trim(), table: match[2] !== undefined }));
}

const broken = (id: string, kind: string, label: string, reason: string): EntityRef => ({ id, kind, label, href: null, broken: reason });

/** The entities of a kind whose key ends with `suffix` (a path tail, a qualified name), found through the graph's text filter. */
async function endingWith(ctx: RenderContext, kind: string, filter: string, suffix: string, separators: readonly string[]): Promise<GraphEntity[]> {
  const found = await ctx.graph.list(kind, { q: filter, limit: 40 });
  return found.rows.filter((entity) => separators.some((separator) => entity.key.endsWith(`${separator}${suffix}`))).slice(0, 3);
}

/** The entities that stand in the repository the document is in, when some do; a mention of code in another repository stays honest and is listed as it is found. */
function inDocumentRepo(ctx: RenderContext, doc: DocEntity, entities: readonly GraphEntity[]): GraphEntity[] {
  if (doc.repo === null) return [...entities];
  const same = entities.filter((entity) => ctx.repoOfScope(entity.scope) === doc.repo);
  return same.length > 0 ? same : [...entities];
}

export async function implementedByBlock(ctx: RenderContext, subject: Subject, params: Readonly<Record<string, string>>, file: string, line: number): Promise<Block> {
  const title = params['title'] ?? 'Implemented by';
  if (subject.source !== 'document') return { type: 'problem', block: 'implementedby', file, line, message: 'the implementedby block lists the code a document entity names or is grounded with; this entity is not one' };
  const doc = subject.entity;
  const rows = new Map<string, RefRow>();
  // A row found twice keeps its first reason: the reasons are alternatives, and the first is the strongest (the text names it).
  const add = (row: RefRow): void => {
    if (!rows.has(row.entity.id)) rows.set(row.entity.id, row);
  };
  const named = { note: 'named in the text', noteKey: 'named' } as const;
  // 1. The places the section's own text names. A path names a file or a module of the graph, by its whole key or by its tail.
  for (const mention of codeMentions(doc.text)) {
    let files: GraphEntity[] = inDocumentRepo(ctx, doc, await ctx.graph.find(`code.file:${mention.path}`)).slice(0, 1);
    if (files.length === 0) files = inDocumentRepo(ctx, doc, await endingWith(ctx, 'code.file', mention.path, mention.path, [':', '/']));
    const modules = files.length > 0 ? [] : inDocumentRepo(ctx, doc, [...(await ctx.graph.find(`code.module:${mention.path}`)), ...(await endingWith(ctx, 'code.module', mention.path, mention.path, ['/']))]).slice(0, 3);
    for (const found of [...files, ...modules]) add({ entity: refOfGraph(ctx, found), ...named });
    if (files.length + modules.length === 0) add({ entity: broken(`code.file:${mention.path}`, 'code.file', mention.path, `the text names the file ${mention.path}, and the graph holds no file or module of that name`), ...named });
    for (const name of mention.names) {
      const inFile = files.flatMap((found) => (found.properties['path'] === undefined ? [] : [String(found.properties['path'])]));
      const symbols: GraphEntity[] = [];
      for (const path of inFile.length > 0 ? inFile : [mention.path]) {
        const exact = inDocumentRepo(ctx, doc, await ctx.graph.find(`code.symbol:${path}#${name}`));
        if (exact.length > 0) symbols.push(exact[0]!);
        else symbols.push(...inDocumentRepo(ctx, doc, (await ctx.graph.byPrefix('code.symbol', `code.symbol:${path}#`, 500)).rows.filter((symbol) => symbol.key.endsWith(`.${name}`))).slice(0, 3));
      }
      for (const symbol of symbols) add({ entity: refOfGraph(ctx, symbol), ...named });
      if (symbols.length === 0) add({ entity: broken(`code.symbol:${mention.path}#${name}`, 'code.symbol', name, `the text names ${name} in ${mention.path}, and the graph holds no such symbol there`), ...named });
    }
  }
  // 2. The channels, types and tables the text names between backticks (what is not found is not guessed at).
  for (const mention of nameMentions(doc.text)) {
    const code = mention.code;
    if (/^[\w.-]+$/.test(code) && code.includes('.')) for (const channel of inDocumentRepo(ctx, doc, await ctx.graph.find(`code.channel:${code}`)).slice(0, 1)) add({ entity: refOfGraph(ctx, channel), ...named });
    // A type or function is named with a capital in its last word (`OutboxWriter`, `store.OutboxWriter`, `checkRefund`); a lower-case dotted name is a topic, a table or a word.
    const last = code.slice(code.lastIndexOf('.') + 1);
    if (/^[A-Za-z_]\w*(\.[A-Za-z_]\w*)*$/.test(code) && /[A-Z]/.test(last)) {
      for (const symbol of inDocumentRepo(ctx, doc, await endingWith(ctx, 'code.symbol', last, last, ['#', '.']))) add({ entity: refOfGraph(ctx, symbol), ...named });
    }
    if (mention.table) {
      const tables = await ctx.graph.list('code.table', { q: code, limit: 20 });
      for (const table of inDocumentRepo(ctx, doc, tables.rows.filter((entity) => entity.label === code)).slice(0, 3)) add({ entity: refOfGraph(ctx, table), ...named });
    }
  }
  // 3. The code a page of the product grounds in the same footnote as this entity.
  for (const page of [...ctx.markdown.values()].sort((a, b) => byCodePoint(a.id, b.id))) {
    const reading = readStatements(page.body, page.bodyLine);
    for (const urls of reading.definitions.values()) {
      const resolved = await Promise.all(urls.map((url) => ctx.resolver.resolve(url)));
      if (!resolved.some((resolution) => resolution.state === 'ok' && resolution.entity === doc.id)) continue;
      for (const resolution of resolved) {
        if (resolution.state !== 'ok' || resolution.entity === undefined || resolution.entity === doc.id || !resolution.kind.startsWith('code.')) continue;
        const [entity] = await ctx.graph.find(resolution.entity);
        if (entity !== undefined) add({ entity: refOfGraph(ctx, entity), note: `grounded with it on the page ${page.title}`, noteKey: 'groundedWith', noteArgs: { page: page.title } });
      }
    }
  }
  const ordered = [...rows.values()].sort((a, b) => byCodePoint(a.entity.id, b.entity.id));
  return { type: 'refs', title, total: ordered.length, rows: ordered.slice(0, REFS_LIMIT) };
}

/** The line of a text that names the identifier, as a short excerpt (the line is already one line). */
function excerpt(text: string): string {
  let flat = '';
  let space = false;
  for (const character of text) {
    if (character === '*' || character === '_' || character === '`') continue;
    if (character === ' ' || character === '\t' || character === '\n' || character === '\r') {
      if (flat !== '') space = true;
      continue;
    }
    if (space) { flat += ' '; space = false; }
    flat += character;
  }
  flat = flat.trim();
  return flat.length > 120 ? `${flat.slice(0, 119)}…` : flat;
}

export async function linkedFromBlock(ctx: RenderContext, subject: Subject, params: Readonly<Record<string, string>>, file: string, line: number): Promise<Block> {
  const title = params['title'] ?? 'Linked from';
  // A graph page lists the pages whose prose mentions it (madarch-ztyq.8): the core inserts those links, and the index
  // knows every statement that grounds or mentions the key. Before, a graph page had only its related block.
  const graphKey = subject.source === 'graph' ? subject.entity.key : undefined;
  const id = graphKey ?? ('id' in subject.entity ? subject.entity.id : subject.entity.key);
  const rows = new Map<string, RefRow>();
  // 1. The product's pages that ground a statement in this entity or link to it.
  for (const page of [...ctx.markdown.values()].sort((a, b) => byCodePoint(a.id, b.id))) {
    if (page.id === id) continue;
    const reading = readStatements(page.body, page.bodyLine);
    let statements = 0;
    for (const statement of reading.statements) {
      const urls = statement.notes.flatMap((note) => reading.definitions.get(note) ?? []);
      const resolved = await Promise.all(urls.map((url) => ctx.resolver.resolve(url)));
      if (resolved.some((resolution) => resolution.state === 'ok' && resolution.entity === id)) statements += 1;
    }
    let linked = statements > 0;
    if (!linked) {
      for (const target of madarchTargets(page.body)) {
        const resolution = await ctx.resolver.resolve(`madarch:${target}`);
        if (resolution.state === 'ok' && resolution.entity === id) { linked = true; break; }
      }
    }
    if (linked) rows.set(page.id, statements > 0
      ? { entity: refOfMarkdown(ctx, page), note: `${statements} statement${statements === 1 ? '' : 's'} grounded in it`, noteKey: 'statements', noteArgs: { count: statements } }
      : { entity: refOfMarkdown(ctx, page), note: 'links to it', noteKey: 'links' });
  }
  // 1b. The statements of the index that rely on this key (the index sees the page's footnotes whole).
  // The index names a section by its path alone: where the product and a connected repository both hold the path, it cannot tell them apart, and the Markdown reading above stands alone.
  const ambiguous = subject.source === 'document' && [...ctx.docEntities.values()].some((other) => other.path === subject.entity.path && other.anchor === subject.entity.anchor && other.repo !== subject.entity.repo);
  const indexKey = graphKey ?? (subject.source === 'document' ? `doc:${subject.entity.path}#${subject.entity.anchor}` : undefined);
  if (indexKey !== undefined && ctx.index !== undefined && !ambiguous) {
    const relied = await ctx.index.relyingOn(indexKey);
    for (const relying of relied) {
      const page = ctx.markdown.get(relying.page);
      if (page === undefined || rows.has(page.id)) continue;
      const count = relied.filter((other) => other.page === relying.page).length;
      rows.set(page.id, { entity: refOfMarkdown(ctx, page), note: `${count} statement${count === 1 ? '' : 's'} ${relying.how === 'grounds' ? 'grounded in it' : 'mention it'}`, noteKey: 'statements', noteArgs: { count } });
    }
  }
  // 2. The documents that name the identifier, outside the section itself.
  if (subject.source === 'document' && subject.entity.identifier !== null) {
    const doc: DocEntity = subject.entity;
    const identifier: string = doc.identifier!;
    for (const source of ctx.documents) {
      const own = source.repo === doc.repo && source.path === doc.path;
      // The parser says which lines are rendered prose: code, comments and unused notes are not.
      for (const { line: number, text } of identifierMentions(source.text, identifier)) {
        if (own && number >= doc.line && number <= doc.endLine) continue;
        const enclosing = [...ctx.docEntities.values()].find((entity) => entity.repo === source.repo && entity.path === source.path && number >= entity.line && number <= entity.endLine);
        const place = source.repo === null ? source.path : `${source.repo}: ${source.path}`;
        const entity: EntityRef = enclosing !== undefined && enclosing.id !== doc.id
          ? { id: enclosing.id, kind: enclosing.kind, label: enclosing.title, href: ctx.manifest.kinds.has(enclosing.kind) ? entityAddress(enclosing.id) : null }
          : { id: `doc:${source.repo === null ? '' : `@${source.repo}/`}${source.path}#L${number}`, kind: 'document', label: `${place}:${number}`, href: documentAddress(source.repo, source.path) };
        if (!rows.has(entity.id)) rows.set(entity.id, { entity, note: excerpt(text) });
      }
    }
  }
  const ordered = [...rows.values()].sort((a, b) => byCodePoint(a.entity.id, b.entity.id));
  return { type: 'refs', title, total: ordered.length, rows: ordered.slice(0, REFS_LIMIT), ...(params['hide-empty'] === 'true' ? { hideEmpty: true } : {}) };
}

/** The glossary term a document entity is: its definition, synonyms, code names, places of use and ambiguity (decision 0031). */
export function termBlock(ctx: RenderContext, subject: Subject, params: Readonly<Record<string, string>>, file: string, line: number): Block {
  if (subject.source !== 'document') return { type: 'problem', block: 'term', file, line, message: 'the term block shows a glossary term; the entities of this kind are not terms of a document' };
  const source = ctx.localizedSources.get(subject.entity.id);
  const detected = source === undefined ? undefined : source.sourceLanguage;
  const localized = source !== undefined && detected !== ctx.language;
  const originalFields = parseTermText(subject.entity.text);
  const localizedFields = localized ? parseTermText(source.statement) : originalFields;
  const needsLocalization = detectDocumentLanguage(subject.entity.text) !== ctx.language;
  const fields = localized ? { ...originalFields, definition: localizedFields.definition || source.statement } : originalFields;
  return { type: 'term', title: params['title'] ?? 'Term', ...fields, ...(localized ? { localized: { statement: source.statement, original: source.original, sourceDocument: source.sourceDocument, sourceLine: source.sourceLine, sourceEndLine: source.sourceEndLine } } : {}), ...(needsLocalization && source === undefined ? { definition: '' } : {}) };
}
