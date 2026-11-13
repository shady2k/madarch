/**
 * The ids of the loop's own files (madarch-ztyq.12): a new question, a
 * correction, a task or a question-file footnote is named by the first 12 hex
 * characters of SHA-256 over its canonical content. A person reads the title;
 * an id only has to be unique and stable. Existing files keep their names and
 * are found by the id stored in them or by their file name.
 */

/**
 * A question id as the wiki reads it back: an old lower-case name from a file
 * written before content hashes, or a content hash and its collision suffix.
 */

import { canonicalJsonDigest } from '../model/canonical.js';
import { byCodePoint } from '../model/order.js';

/** A question-file footnote names one side: its claim and the keys it stands on. */
export function questionFootnoteId(claim: string, grounds: readonly string[]): string {
  return shortDigest({ claim: normalize(claim), grounds: keys(grounds) });
}



/** The first 12 hex characters of the canonical content's SHA-256. */
function shortDigest(value: unknown): string {
  return canonicalJsonDigest(value).slice(0, 12);
}

/** Text is compared without its insignificant wrapping: NFC, one space between words, no ends. */
function normalize(text: string): string {
  let out = '';
  let separated = false;
  for (const character of text.normalize('NFC')) {
    if (character.trim() === '') {
      if (out !== '') separated = true;
      continue;
    }
    if (separated) out += ' ';
    out += character;
    separated = false;
  }
  return out;
}

/** Keys are a set in code-point order, so the order the caller sent them in never changes an id. */
function keys(values: readonly string[]): string[] {
  return [...new Set(values.map(normalize))].sort(byCodePoint);
}
