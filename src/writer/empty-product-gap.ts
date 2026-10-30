/**
 * The structural identity of a gap sentence the core writes on an empty product's page (madarch-ztyq.7). The format
 * must not recognise such a sentence by its rendered words: the core writes a marker beside the sentence, naming the
 * section it left empty and the digest of the sentence it wrote, and the check validates that marker from the parsed
 * page. A sentence a model writes, even one that copies a gap's words, carries no marker and stays ungrounded.
 */
import { sha256Hex } from '../graph/digest.js';
import { plainSentence } from './sentences.js';

const PREFIX = '<!-- madarch:empty-product-gap:';
const SUFFIX = ' -->';

export interface EmptyProductGap {
  /** The home section the core left empty, e.g. `what-it-is`. */
  readonly section: string;
  /** SHA-256 of the core's sentence, read as a reader reads it. */
  readonly digest: string;
}

/** The digest the marker carries for a sentence: its plain reading, in UTF-8. */
export function emptyProductGapDigest(sentence: string): string {
  return sha256Hex(new TextEncoder().encode(plainSentence(sentence)));
}

/** The marker line the core writes before a gap sentence. */
export function emptyProductGapMarker(section: string, sentence: string): string {
  return `${PREFIX}${section}:${emptyProductGapDigest(sentence)}${SUFFIX}`;
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
