/**
 * The structural identity of a gap sentence the core writes on an empty product's page (madarch-ztyq.7). The format
 * must not recognise such a sentence by its rendered words: the core writes a marker beside the sentence, naming the
 * section it left empty and the digest of the sentence it wrote, and the check validates that marker from the parsed
 * page. A sentence a model writes, even one that copies a gap's words, carries no marker and stays ungrounded.
 */
import { plainSentence } from './sentences.js';
import { emptyProductGapMarkerFromPlain, emptyProductGapPlainDigest } from './gap-marker.js';

export type { EmptyProductGap } from './gap-marker.js';
export { readEmptyProductGapMarker } from './gap-marker.js';

/** The digest the marker carries for a sentence: its plain reading, in UTF-8. */
export function emptyProductGapDigest(sentence: string): string {
  return emptyProductGapPlainDigest(plainSentence(sentence));
}

/** The marker line the core writes before a gap sentence. */
export function emptyProductGapMarker(section: string, sentence: string): string {
  return emptyProductGapMarkerFromPlain(section, plainSentence(sentence));
}
