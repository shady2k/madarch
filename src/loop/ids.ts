/**
 * The ids of the loop's own files (madarch-ztyq.12): a new question, a
 * correction, a task or a question-file footnote is named by the first 12 hex
 * characters of SHA-256 over its canonical content. A person reads the title;
 * an id only has to be unique and stable. Existing files keep their names and
 * are found by the id stored in them or by their file name.
 */
import { canonicalJsonDigest } from '../model/canonical.js';
import { byCodePoint } from '../model/order.js';

/** The words of a question file that make up its identity. */
export interface QuestionContent {
  readonly type: string;
  readonly title: string;
  readonly question: string;
  readonly why: string;
  readonly sides: readonly { readonly claim: string; readonly grounds: readonly string[] }[];
}

/** A question-file footnote names one side: its claim and the keys it stands on. */
export function questionFootnoteId(claim: string, grounds: readonly string[]): string {
  return shortDigest({ claim: normalize(claim), grounds: keys(grounds) });
}

/** A question names its type, its readable text and every side's claim and grounds. */
export function questionId(question: QuestionContent): string {
  return shortDigest({
    type: question.type,
    title: normalize(question.title),
    question: normalize(question.question),
    why: normalize(question.why),
    sides: question.sides.map((side) => ({ claim: normalize(side.claim), grounds: keys(side.grounds) })),
  });
}

/** A correction names the sentence as it read, the person's reason and the statement key it corrects. */
export function correctionId(statement: string, reason: string, statementKey: string): string {
  return shortDigest({ statement: normalize(statement), reason: normalize(reason), statementKey: normalize(statementKey) });
}

/** A task names its title and the keys of its scopes, in code-point order. */
export function taskId(title: string, scopeKeys: readonly string[]): string {
  return shortDigest({ title: normalize(title), scopes: keys(scopeKeys) });
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

/** A content-hash slug, with the `-2`, `-3` a collision with a different file takes. */
export const CONTENT_SLUG = /^[0-9a-f]{12}(?:-[0-9]+)?$/;

/**
 * A question id as the wiki reads it back: an old lower-case name from a file
 * written before content hashes, or a content hash and its collision suffix.
 */
export const QUESTION_SLUG = /^(?:[a-z][a-z0-9]*(?:-[a-z0-9]+)*|[0-9a-f]{12}(?:-[0-9]+)?)$/;
