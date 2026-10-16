import { unified } from 'unified';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import type { Root, PhrasingContent, Text } from 'mdast';
import { decodeNamedCharacterReference } from 'decode-named-character-reference';

export type SourceRange = { start: number; end: number; quote: string; before: string; after: string };
export type SelectionMap = { ok: true; range: SourceRange } | { ok: false; reason: string };

type TextSpan = { node: Text; start: number; end: number; value: string; groupStart?: number; groupEnd?: number };
const parser = unified().use(remarkParse).use(remarkGfm);

/** Renders paragraph text in document order using the same Markdown AST rules as the source mapper. */
export function renderedMarkdownParagraphs(markdown: string): string[] {
  const tree = parser.parse(markdown) as Root;
  const paragraphs: Extract<Root['children'][number], { type: 'paragraph' }>[] = [];
  const walk = (node: { type: string; children?: unknown[] }): void => {
    if (node.type === 'paragraph') { paragraphs.push(node as Extract<Root['children'][number], { type: 'paragraph' }>); return; }
    if (Array.isArray(node.children)) for (const child of node.children) if (child !== null && typeof child === 'object') walk(child as { type: string; children?: unknown[] });
  };
  for (const child of tree.children) walk(child as { type: string; children?: unknown[] });
  const render = (node: PhrasingContent): string => {
    if (node.type === 'text') return node.value;
    if (node.type === 'inlineCode') return node.value;
    if (node.type === 'break') return '\n';
    if ('children' in node) return node.children.map((child) => render(child as PhrasingContent)).join('');
    return '';
  };
  return paragraphs.map((paragraph) => paragraph.children.map((child) => render(child as PhrasingContent)).join(''));
}

/**
 * Maps UTF-16 DOM text offsets in one rendered paragraph to UTF-16 Markdown
 * source offsets. Only plain text leaves are eligible; formatting boundaries
 * are expanded to their complete containing inline node. Any non-bijective
 * decoded entity/escape boundary is rejected rather than guessed.
 */
export function mapParagraphSelection(markdown: string, from: number, to: number, paragraphIndex = 0): SelectionMap {
  const tree = parser.parse(markdown) as Root;
  const spans: TextSpan[] = [];
  let rendered = '';
  const collect = (node: PhrasingContent, groupStart?: number, groupEnd?: number): void => {
    const ownStart = node.position?.start.offset;
    const ownEnd = node.position?.end.offset;
    const boundaryStart = groupStart;
    const boundaryEnd = groupEnd;
    if (node.type === 'break') {
      const start = rendered.length;
      rendered += '\n';
      const nodeStart = node.position?.start.offset;
      const nodeEnd = node.position?.end.offset;
      return;
    }
    if (node.type === 'text') {
      const start = rendered.length;
      rendered += node.value;
      const position = node.position;
      if (position?.start.offset === undefined || position.end.offset === undefined) return;
      const nodeStart = node.position?.start.offset;
      const nodeEnd = node.position?.end.offset;
      if (nodeStart !== undefined && nodeEnd !== undefined) spans.push({ node, start, end: rendered.length, value: node.value, ...(boundaryStart === undefined ? {} : { groupStart: boundaryStart }), ...(boundaryEnd === undefined ? {} : { groupEnd: boundaryEnd }) });
      return;
    }
    if ('children' in node) for (const child of node.children) collect(child as PhrasingContent, ownStart ?? boundaryStart, ownEnd ?? boundaryEnd);
    else if (node.type === 'inlineCode') {
      const start = rendered.length;
      rendered += node.value;
      const nodeStart = node.position?.start.offset;
      const nodeEnd = node.position?.end.offset;
      if (nodeStart !== undefined && nodeEnd !== undefined) {
        const raw = markdown.slice(nodeStart, nodeEnd);
        const delimiters = /^`+/.exec(raw)?.[0].length ?? 0;
        const content = delimiters > 0 && raw.endsWith('`'.repeat(delimiters))
          ? raw.slice(delimiters, -delimiters)
          : '';
        const normalized = content.replace(/\r\n?|\n/g, ' ');
        if (normalized === node.value) {
          const sourcePosition = {
            start: { line: node.position!.start.line, column: node.position!.start.column + delimiters, offset: nodeStart + delimiters },
            end: { line: node.position!.end.line, column: node.position!.end.column - delimiters, offset: nodeEnd - delimiters },
          };
          spans.push({ node: { type: 'text', value: node.value, position: sourcePosition } as Text, start, end: rendered.length, value: node.value, groupStart: boundaryStart ?? nodeStart, groupEnd: boundaryEnd ?? nodeEnd });
        }
      }
    }
  };
  const paragraphs: Extract<Root['children'][number], { type: 'paragraph' }>[] = [];
  const walk = (node: { type: string; children?: unknown[] }): void => {
    if (node.type === 'paragraph') { paragraphs.push(node as Extract<Root['children'][number], { type: 'paragraph' }>); return; }
    if (Array.isArray(node.children)) for (const child of node.children) if (child !== null && typeof child === 'object') walk(child as { type: string; children?: unknown[] });
  };
  for (const child of tree.children) walk(child as { type: string; children?: unknown[] });
  const paragraph = paragraphs[paragraphIndex];
  if (paragraph === undefined) return { ok: false, reason: 'the selection is not inside a Markdown paragraph' };
  for (const child of paragraph.children) collect(child as PhrasingContent);
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to <= from || to > rendered.length)
    return { ok: false, reason: 'the selection boundaries are outside the rendered paragraph' };

  const boundary = (offset: number): number | undefined => {
    for (const span of spans) {
      if (offset < span.start || offset > span.end) continue;
      const local = offset - span.start;
      const sourceStart = span.node.position?.start.offset;
      if (sourceStart === undefined) return undefined;
      const raw = markdown.slice(sourceStart, span.node.position!.end.offset);
      const decoded = decodeRawText(raw);
      if (decoded !== span.value) return undefined;
      if (local === 0) return sourceStart;
      if (local === span.value.length) return span.node.position!.end.offset;
      const sourceOffset = rawBoundary(raw, sourceStart, local);
      if (sourceOffset === undefined) return undefined;
      // UTF-16 boundaries inside surrogate pairs are never valid selection edges.
      const code = span.value.charCodeAt(local);
      const prior = span.value.charCodeAt(local - 1);
      if (code >= 0xdc00 && code <= 0xdfff && prior >= 0xd800 && prior <= 0xdbff) return undefined;
      return sourceOffset;
    }
    return undefined;
  };
  const sourceFrom = boundary(from);
  const sourceTo = boundary(to);
  if (sourceFrom === undefined || sourceTo === undefined)
    return { ok: false, reason: 'the selection cannot be mapped uniquely to Markdown source (for example, at a decoded entity or escape)' };
  if (!isGraphemeBoundary(rendered, from) || !isGraphemeBoundary(rendered, to))
    return { ok: false, reason: 'the selection splits a visible grapheme cluster' };
  const selected = rendered.slice(from, to);
  if (selected.length === 0) return { ok: false, reason: 'the selection is empty' };
  const words = wordBounds(rendered, from, to);
  const adjustedFrom = words.start;
  const adjustedTo = words.end;
  const mappedStart = boundary(adjustedFrom);
  const mappedEnd = boundary(adjustedTo);
  if (mappedStart === undefined || mappedEnd === undefined)
    return { ok: false, reason: 'the expanded selection cannot be mapped uniquely to Markdown source' };
  const quote = rendered.slice(adjustedFrom, adjustedTo);
  const selectedSpans = spans.filter((span) => span.start < adjustedTo && span.end > adjustedFrom);
  const sourceRangeStart = selectedSpans.reduce((start, span) => Math.min(start, span.groupStart ?? start), mappedStart);
  const sourceRangeEnd = selectedSpans.reduce((end, span) => Math.max(end, span.groupEnd ?? end), mappedEnd);
  return {
    ok: true,
    range: {
      start: sourceRangeStart,
      end: sourceRangeEnd,
      quote,
      before: [...rendered.slice(0, adjustedFrom)].slice(-32).join(''),
      after: [...rendered.slice(adjustedTo)].slice(0, 32).join(''),
    },
  };
}

/** Adds the v1 pair around exact source offsets; all other source bytes survive unchanged. */
export function insertDiscussionMarkers(source: string, range: { start: number; end: number }, id: string): string {
  if (!/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(id)) throw new Error('marker id must be a ULID');
  if (!Number.isInteger(range.start) || !Number.isInteger(range.end) || range.start < 0 || range.end <= range.start || range.end > source.length)
    throw new Error('source range is invalid');
  return `${source.slice(0, range.start)}<!--c:${id}-->${source.slice(range.start, range.end)}<!--/c:${id}-->${source.slice(range.end)}`;
}

function decodeRawText(raw: string): string {
  // CommonMark character references are the only supported non-identity text
  // transform here. Offset edges inside one are rejected by the length/value
  // comparison above; surrounding boundaries remain exact.
  return raw.replace(/&(#(?:x[\da-f]+|\d+)|[A-Za-z][A-Za-z\d]+);/gi, (whole, name: string) =>
    name.startsWith('#x') || name.startsWith('#X')
      ? decodeCodePoint(Number.parseInt(name.slice(2), 16))
      : name.startsWith('#')
        ? decodeCodePoint(Number.parseInt(name.slice(1), 10))
        : decodeNamedCharacterReference(name) || whole,
  ).replace(/\\([\\`*{}\[\]()#+\-.!_>~|])/g, '$1');
}

function wordBounds(text: string, from: number, to: number): { start: number; end: number } {
  let start = from;
  let end = to;
  const word = (c: string | undefined): boolean => c !== undefined && /[\p{L}\p{N}\p{M}_]/u.test(c);
  while (start > 0 && word(String.fromCodePoint(text.codePointAt(start - 1)!))) start--;
  while (end < text.length && word(String.fromCodePoint(text.codePointAt(end)!))) end++;
  return { start, end };
}

/** Maps a decoded rendered-text boundary to source, rejecting boundaries inside an entity or escape. */
function rawBoundary(raw: string, sourceStart: number, renderedOffset: number): number | undefined {
  let source = 0;
  let rendered = 0;
  while (source < raw.length) {
    if (rendered === renderedOffset) return sourceStart + source;
    let rawLength = 1;
    let decoded: string;
    if (raw[source] === '&') {
      const entity = /^&(#(?:x[\da-f]+|\d+)|[A-Za-z][A-Za-z\d]+);/i.exec(raw.slice(source));
      if (entity !== null) {
        rawLength = entity[0].length;
        const value = decodeRawText(entity[0]);
        if (value.length !== 1) return undefined;
        decoded = value;
      } else decoded = '&';
    } else if (raw[source] === '\\' && source + 1 < raw.length && /[\\`*{}\[\]()#+\-.!_>~|]/.test(raw[source + 1]!)) {
      rawLength = 2;
      decoded = raw[source + 1]!;
    } else {
      const cp = raw.codePointAt(source)!;
      decoded = String.fromCodePoint(cp);
      rawLength = decoded.length;
    }
    if (rendered < renderedOffset && renderedOffset < rendered + decoded.length) return undefined;
    source += rawLength;
    rendered += decoded.length;
    if (rendered === renderedOffset) return sourceStart + source;
  }
  return rendered === renderedOffset ? sourceStart + raw.length : undefined;
}

function isGraphemeBoundary(text: string, offset: number): boolean {
  if (offset === 0 || offset === text.length) return true;
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  for (const segment of segmenter.segment(text)) {
    if (segment.index === offset) return true;
    if (segment.index > offset) return false;
  }
  return false;
}

function decodeCodePoint(value: number): string {
  if (!Number.isInteger(value) || value <= 0 || value > 0x10ffff || (value >= 0xd800 && value <= 0xdfff)) return '\uFFFD';
  return String.fromCodePoint(value);
}
