/**
 * The syntax of the marker the core writes beside a gap sentence (madarch-ztyq.7). This module knows only the
 * marker's shape and digest: no prose, no page reader. The writer builds a marker from a plain sentence and the
 * parsed page reads it from the HTML node the core wrote, so no sentence is ever recognised by its words.
 */
import { sha256Hex } from '../graph/digest.js';

const PREFIX = '<!-- madarch:empty-product-gap:';
const SUFFIX = ' -->';

export interface EmptyProductGap {
  /** The home section the core left empty, e.g. `what-it-is`. */
  readonly section: string;
  /** SHA-256 of the core's sentence, read as a reader reads it. */
  readonly digest: string;
}

/** The digest a marker carries for an already plain sentence, in UTF-8. */
export function emptyProductGapPlainDigest(plain: string): string {
  return sha256Hex(new TextEncoder().encode(plain));
}

/** The marker line the core writes before a gap sentence, given the sentence's plain reading. */
export function emptyProductGapMarkerFromPlain(section: string, plain: string): string {
  return `${PREFIX}${section}:${emptyProductGapPlainDigest(plain)}${SUFFIX}`;
}

/** Reads the marker of a whole line, or `undefined` when the line is not a well-formed empty-product gap marker. */
export function readEmptyProductGapMarker(line: string): EmptyProductGap | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith(PREFIX) || !trimmed.endsWith(SUFFIX)) return undefined;
  const body = trimmed.slice(PREFIX.length, -SUFFIX.length);
  const colon = body.indexOf(':');
  if (colon <= 0) return undefined;
  const section = body.slice(0, colon);
  const digest = body.slice(colon + 1);
  if (!isSection(section) || digest.length !== 64 || !isHex(digest)) return undefined;
  return { section, digest };
}

function isSection(text: string): boolean {
  if (text.length === 0 || text[0]! < 'a' || text[0]! > 'z') return false;
  for (const character of text) {
    if ((character >= 'a' && character <= 'z') || (character >= '0' && character <= '9') || character === '-') continue;
    return false;
  }
  return true;
}

function isHex(text: string): boolean {
  for (const character of text) {
    if ((character >= '0' && character <= '9') || (character >= 'a' && character <= 'f')) continue;
    return false;
  }
  return true;
}
