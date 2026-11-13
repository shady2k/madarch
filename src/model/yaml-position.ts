import type { LineCounter } from 'yaml';
import { isAlias, isMap, isSeq } from 'yaml';

/** A path segment: an object key or an array index. */
export type PathSegment = string | number;

/**
 * Parses a JSON-Pointer-style path (as produced by TypeBox, e.g.
 * `/elements/0/owner`) into segments, turning numeric segments into
 * numbers so they can index into a YAML sequence.
 */
export function jsonPointerToSegments(pointer: string): PathSegment[] {
  return pointer
    .split('/')
    .filter((segment) => segment.length > 0)
    .map((segment) => decodeJsonPointerSegment(segment))
    .map((segment) => (/^\d+$/.test(segment) ? Number(segment) : segment));
}

/** Decodes a JSON-Pointer segment's `~1` (`/`) and `~0` (`~`) escapes, in that order (RFC 6901). */
function decodeJsonPointerSegment(segment: string): string {
  return segment.replace(/~1/g, '/').replace(/~0/g, '~');
}

/** Renders path segments as `elements[0].owner`, the form errors are reported in. */
export function segmentsToPath(segments: PathSegment[]): string {
  let out = '';
  for (const segment of segments) {
    if (typeof segment === 'number') {
      out += `[${segment}]`;
    } else {
      out += out.length > 0 ? `.${segment}` : segment;
    }
  }
  return out;
}

/**
 * Walks a parsed YAML document following `segments` and returns the
 * 1-based line of the node found there (the key, for an object member).
 * A path that reaches an alias stops there and names the line the alias is
 * used on: the anchored node stands where the anchor is written, so a reading
 * of it would name a line of another part of the file, while a fault on the
 * alias's value is a fault of the line that uses it.
 * Falls back to the document's first line when the path cannot be
 * resolved exactly (for example a whole-file problem with no path).
 */
export function lineForPath(doc: { contents: unknown }, lineCounter: LineCounter, segments: PathSegment[]): number {
  return findLineForPath(doc, lineCounter, segments);
}

/** Index a document for one read. The caller must not mutate the document during that read. */
export function lineLocator(doc: { contents: unknown }, lineCounter: LineCounter): (segments: PathSegment[]) => number {
  const indexes = new WeakMap<object, Map<unknown, { key: unknown; value: unknown }>>();
  return (segments) => findLineForPath(doc, lineCounter, segments, indexes);
}

function findLineForPath(doc: { contents: unknown }, lineCounter: LineCounter, segments: PathSegment[], indexes?: WeakMap<object, Map<unknown, { key: unknown; value: unknown }>>): number {
  let node: unknown = doc.contents;
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    if (node === null || node === undefined) break;
    if (isAlias(node)) return lineAtRangeStart(node, lineCounter);
    if (typeof segment === 'number') {
      if (!isSeq(node)) break;
      const item: unknown = node.items[segment];
      if (i === segments.length - 1) {
        return lineAtRangeStart(item, lineCounter);
      }
      node = item;
    } else {
      if (!isMap(node)) break;
      let pair: { key: unknown; value: unknown } | undefined;
      if (indexes === undefined) {
        pair = node.items.find((p) => keyValue(p.key) === segment);
      } else {
        let index = indexes.get(node);
        if (index === undefined) {
          index = new Map();
          for (const item of node.items) {
            const key = keyValue(item.key);
            if (!index.has(key)) index.set(key, item);
          }
          indexes.set(node, index);
        }
        pair = index.get(segment);
      }
      if (!pair) break;
      if (i === segments.length - 1) {
        return lineAtRangeStart(pair.key, lineCounter);
      }
      node = pair.value;
    }
  }
  return lineAtRangeStart(doc.contents, lineCounter);
}

function keyValue(key: unknown): unknown {
  if (typeof key === 'string' || typeof key === 'number') return key;
  if (typeof key === 'object' && key !== null && 'value' in key) return (key as { value: unknown }).value;
  return undefined;
}

function lineAtRangeStart(node: unknown, lineCounter: LineCounter): number {
  const range = (node as { range?: [number, number, number] } | null | undefined)?.range;
  if (!range) return 1;
  return lineCounter.linePos(range[0]).line;
}
