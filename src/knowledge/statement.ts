/**
 * The statement view (madarch-m38l.6): one sentence of a page the agent wrote,
 * the paragraph it stands in, and each of its grounds with an excerpt of what
 * it points at, the lines of code with the cited ones marked or the text of the
 * use case, rule or decision. The sentence is found by its text in the page's
 * body; a sentence the body does not hold is refused in words, never guessed.
 */
import { byCodePoint } from '../model/order.js';
import { findAnchor } from './anchors.js';
import { languageOf, refOfMarkdown, type RenderContext } from './blocks.js';
import type { GraphEntity } from './graph-read.js';
import { parseTarget, readStatements } from './markdown.js';
import type { CodeLocation, Excerpt, GroundView, RelyingRef, StatementModel } from './model.js';
import { documentAddress, noEntityMessage, sourceAddress, type Resolution } from './resolve.js';

/** Lines of context shown above and below the cited lines, and the most lines an excerpt shows. */
const CONTEXT_LINES = 3;
const EXCERPT_LINES = 60;

export type StatementResult = { ok: true; statement: StatementModel } | { ok: false; status: 404; message: string };

const squash = (text: string): string => text.replace(/\s+/g, ' ').trim();

async function codeExcerpt(ctx: RenderContext, entity: GraphEntity, location: CodeLocation): Promise<Excerpt | null> {
  const text = await ctx.readSource(location.repo, location.path);
  if (text === undefined) return null;
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  const markedStart = Math.max(1, Math.min(location.lineStart, lines.length));
  const markedEnd = Math.max(markedStart, Math.min(location.lineEnd, lines.length));
  // A file without a declaration is shown from its top; a long declaration, from its first line.
  const whole = entity.span === undefined;
  const from = whole ? 1 : Math.max(1, markedStart - CONTEXT_LINES);
  const to = whole ? Math.min(lines.length, EXCERPT_LINES) : Math.min(lines.length, markedEnd + CONTEXT_LINES);
  const stop = Math.min(to, from + EXCERPT_LINES - 1);
  return {
    type: 'code',
    location,
    language: languageOf(location.path),
    firstLine: from,
    text: lines.slice(from - 1, stop).join('\n'),
    marked: whole ? { start: 0, end: 0 } : { start: markedStart, end: Math.min(markedEnd, stop) },
    truncated: stop < (whole ? lines.length : to),
  };
}

/** The lines of a document from the section's line to the next heading, at most `EXCERPT_LINES`. */
function sectionText(text: string, line: number): { markdown: string; lineEnd: number } {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  let end = line;
  for (let at = line; at < lines.length && at < line + EXCERPT_LINES; at += 1) {
    if (at > line && /^#{1,6}\s/.test(lines[at]!)) break;
    end = at + 1;
  }
  while (end > line && lines[end - 1]!.trim() === '') end -= 1;
  return { markdown: lines.slice(line - 1, end).join('\n'), lineEnd: end };
}

async function groundOf(ctx: RenderContext, url: string): Promise<GroundView> {
  const resolution: Resolution = await ctx.resolver.resolve(url);
  if (resolution.state === 'broken') return { url, resolution, excerpt: null };
  if (resolution.entity !== undefined) {
    const doc = ctx.docEntities.get(resolution.entity);
    if (doc !== undefined) {
      return { url, resolution, excerpt: { type: 'text', markdown: `**${doc.title}**\n\n${doc.text}`, place: { repo: doc.repo, path: doc.path, lineStart: doc.line, lineEnd: doc.endLine, href: documentAddress(doc.repo, doc.path, doc.anchor) } } };
    }
    if (ctx.markdown.has(resolution.entity)) return { url, resolution, excerpt: null };
    const [entity] = await ctx.graph.find(resolution.entity);
    if (entity !== undefined && resolution.location !== undefined) return { url, resolution, excerpt: await codeExcerpt(ctx, entity, resolution.location) };
    if (entity !== undefined && typeof entity.properties['path'] === 'string') {
      const repo = ctx.repoOfScope(entity.scope) ?? null;
      const web = ctx.webOf?.(repo, entity.properties['path'], 1, 1);
      const location: CodeLocation = { repo, path: entity.properties['path'], lineStart: 1, lineEnd: 1, href: sourceAddress(repo, entity.properties['path'], 1), ...(web === undefined ? {} : { web }) };
      return { url, resolution, excerpt: await codeExcerpt(ctx, entity, location) };
    }
    return { url, resolution, excerpt: null };
  }
  // A section of a document the manifest makes no entity of: its text from the heading to the next.
  const target = parseTarget(url);
  if (target.kind === 'doc') {
    for (const root of [null, ...ctx.repositories]) {
      const text = await ctx.readSource(root, target.path);
      if (text === undefined) continue;
      const line = target.anchor === null || target.anchor === '' ? 1 : findAnchor(text, target.anchor);
      if (line === null) continue;
      const section = sectionText(text, line);
      return { url, resolution, excerpt: { type: 'text', markdown: section.markdown, place: { repo: root, path: target.path, lineStart: line, lineEnd: section.lineEnd, href: documentAddress(root, target.path, target.anchor) } } };
    }
  }
  return { url, resolution, excerpt: null };
}

/** The statement of a page whose text is the sentence; the page is a Markdown entity of the product. */
export async function buildStatement(ctx: RenderContext, pageId: string, sentence: string, turn = 0): Promise<StatementResult> {
  const page = ctx.markdown.get(pageId);
  if (page === undefined) return { ok: false, status: 404, message: noEntityMessage(pageId) };
  const wanted = squash(sentence);
  if (wanted === '') return { ok: false, status: 404, message: 'the sentence is empty' };
  const reading = readStatements(page.body, page.bodyLine);
  const found = reading.statements.filter((statement) => squash(statement.text) === wanted)[turn];
  if (found === undefined) {
    return { ok: false, status: 404, message: `${page.file} holds no statement ${JSON.stringify(sentence.length > 120 ? `${sentence.slice(0, 119)}…` : sentence)}${turn > 0 ? ` at its turn ${turn}` : ''}: the page changed since it was drawn, or the text is not one sentence of its body` };
  }
  const urls: string[] = [];
  for (const note of found.notes) for (const url of reading.definitions.get(note) ?? []) if (!urls.includes(url)) urls.push(url);
  const grounds = await Promise.all(urls.map((url) => groundOf(ctx, url)));
  const resolutions: Record<string, Resolution> = {};
  for (const match of found.paragraph.matchAll(/madarch:[^\s)\]>"']+/g)) {
    const target = match[0].replace(/[.,;:]+$/, '');
    if (!(target in resolutions)) resolutions[target] = await ctx.resolver.resolve(target);
  }
  // The other statements that rely on the same grounds, from the index of the Markdown.
  const relying: RelyingRef[] = [];
  const pathTwice = (entity: string): boolean => {
    const doc = ctx.docEntities.get(entity);
    return doc !== undefined && [...ctx.docEntities.values()].some((other) => other.path === doc.path && other.anchor === doc.anchor && other.repo !== doc.repo);
  };
  if (ctx.index !== undefined) {
    const seen = new Set<string>();
    for (const ground of grounds) {
      if (ground.resolution.state !== 'ok' || ground.resolution.entity === undefined) continue;
      const entity = ground.resolution.entity;
      // The index names a document section by its path alone: a path held by two repositories cannot be told apart.
      if (pathTwice(entity)) continue;
      const key = entity.startsWith('doc:') ? entity.replace(/^doc:@[^/]+\//, 'doc:') : entity;
      for (const other of await ctx.index.relyingOn(key)) {
        const id = `${other.page}\0${other.line}\0${other.statement}`;
        if (seen.has(id) || (other.page === pageId && other.line === found.line && squash(other.text) === wanted)) continue;
        seen.add(id);
        // The index keeps the sentence without its markup; the statement is found again on its page by line and letters.
        const there = ctx.markdown.get(other.page);
        const letters = (text: string): string => text.replace(/[^\p{L}\p{N}]/gu, '').toLowerCase();
        let sentence: string | undefined;
        let turn = 0;
        if (there !== undefined) {
          const all = readStatements(there.body, there.bodyLine).statements;
          const at = all.findIndex((candidate) => candidate.line === other.line && letters(candidate.text) === letters(other.text));
          if (at >= 0) {
            sentence = all[at]!.text;
            turn = all.slice(0, at).filter((candidate) => squash(candidate.text) === squash(sentence!)).length;
          }
        }
        relying.push({ page: other.page, pageTitle: other.pageTitle, text: other.text, line: other.line, file: other.file, how: other.how, ground: ground.resolution.label, ...(sentence === undefined ? {} : { sentence, turn }) });
      }
    }
  }
  return {
    ok: true,
    statement: {
      relying: relying.slice(0, 20),
      page: refOfMarkdown(ctx, page),
      sentence: found.text,
      paragraph: found.paragraph,
      file: page.file,
      line: found.line,
      grounded: found.notes.length > 0,
      grounds,
      resolutions: Object.fromEntries(Object.entries(resolutions).sort(([a], [b]) => byCodePoint(a, b))),
    },
  };
}
