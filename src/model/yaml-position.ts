import type { LineCounter } from 'yaml';
import { isMap, isSeq } from 'yaml';

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
 * Falls back to the document's first line when the path cannot be
 * resolved exactly (for example a whole-file problem with no path).
 */
export function lineForPath(doc: { contents: unknown }, lineCounter: LineCounter, segments: PathSegment[]): number {
  let node: unknown = doc.contents;
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    if (node === null || node === undefined) break;
    if (typeof segment === 'number') {
      if (!isSeq(node)) break;
      const item: unknown = node.items[segment];
      if (i === segments.length - 1) {
        return lineAtRangeStart(item, lineCounter);
      }
      node = item;
    } else {
      if (!isMap(node)) break;
      const pair = node.items.find((p) => isScalarValue(p.key) === segment || (typeof p.key === 'object' && p.key !== null && 'value' in p.key && (p.key as { value: unknown }).value === segment));
      if (!pair) break;
      if (i === segments.length - 1) {
        return lineAtRangeStart(pair.key, lineCounter);
      }
      node = pair.value;
    }
  }
  return lineAtRangeStart(doc.contents, lineCounter);
}

function isScalarValue(key: unknown): unknown {
  if (typeof key === 'string' || typeof key === 'number') return key;
  return undefined;
}

function lineAtRangeStart(node: unknown, lineCounter: LineCounter): number {
  const range = (node as { range?: [number, number, number] } | null | undefined)?.range;
  if (!range) return 1;
  return lineCounter.linePos(range[0]).line;
}
