/**
 * Decision 0039 items 5, 6 and 29: a uid token in a written value is a `mentions` edge of the assertion that holds the
 * string, and a plain name is only a hint. This module turns one written value into the occurrences the writer records
 * and the hints a write answer carries; the grammar itself is `mention-text.ts`.
 */
import { matchMentionNames, mentionStrings, scanMentionText, type MentionFieldHint, type MentionName } from './mention-text.js';
import { holdsJson, type FieldType } from './contract.js';

/** Item 5: a mention stands in a text field or in a string inside a JSON value, and in no other field. */
export function holdsMentions(type: FieldType): boolean {
  return type === 'text' || holdsJson(type);
}

/** One token of one decoded string: the vertex it names, the RFC 6901 pointer to the string and its code-point span. */
export interface MentionOccurrence { readonly uid: string; readonly path: string; readonly start: number; readonly end: number }

/** Item 29: every token of every decoded string under one field, in path and offset order. */
export function mentionOccurrencesOf(value: unknown, fieldPath: string): MentionOccurrence[] {
  const occurrences: MentionOccurrence[] = [];
  for (const { text, path } of mentionStrings(value, fieldPath)) {
    for (const token of scanMentionText(text, path).tokens) occurrences.push({ uid: token.uid, path, start: token.start, end: token.end });
  }
  return occurrences;
}

/** Item 29's occurrence discriminator: the field or string's pointer and the token's place in the decoded string. */
export function mentionDiscriminator(occurrence: MentionOccurrence): string {
  return JSON.stringify({ path: occurrence.path, start: occurrence.start, end: occurrence.end });
}

/** Item 29: the unlinked names of one written value, each with every same-named candidate; none of them makes an edge. */
export function mentionHintsOf(value: unknown, fieldPath: string, dictionary: readonly MentionName[]): MentionFieldHint[] {
  const hints: MentionFieldHint[] = [];
  for (const { text, path } of mentionStrings(value, fieldPath)) {
    for (const hint of matchMentionNames(text, dictionary)) hints.push({ ...hint, path });
  }
  return hints;
}
