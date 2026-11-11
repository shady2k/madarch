/**
 * «Не проблема» is a file (madarch-m38l.19): a person who says a problem is
 * not one leaves a record in the product repository, and the page keeps
 * showing the finding as dismissed. The record names the rule and the stable
 * identity, never the position in a list, so a later refresh either matches
 * the same problem or does not. Its front matter is the summary; the body is
 * the person's reason, in their own words.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import { problemId } from '../problems/types.js';
import type { Author } from './entities.js';

const PROBLEMS_FOLDER = 'docs/problems';
const DISMISSAL_KIND = 'problem-dismissal';
const MAX_REASON = 2000;

/** A record that a problem is not one. */
export interface ProblemDismissal {
  readonly id: string;
  readonly rule: string;
  readonly identity: string;
  readonly place: string;
  readonly reason: string;
  readonly by: Author;
  readonly at: string;
  readonly file: string;
}

/** A display name reduced to a safe file-name component. */
const SEGMENTER = new Intl.Segmenter(undefined, { granularity: 'word' });
function isWordCharacter(char: string): boolean {
  for (const piece of SEGMENTER.segment(char)) if (piece.isWordLike) return true;
  return false;
}

/**
 * The slug GitHub gives a heading: its marks are not part of it, its spaces become hyphens, and a character that is no
 * word character, no `-` and no `_` is dropped.
 */
function slugOf(heading: string): string {
  let kept = '';
  for (const char of heading) {
    if (char === ' ' || char === '-' || char === '_') { kept += char; continue; }
    if (isWordCharacter(char)) kept += char;
  }
  let slug = '';
  for (const char of kept.trim().toLowerCase()) slug += char === ' ' ? '-' : char;
  return slug;
}


/** The file name of a dismissal: its rule and a short hash of the identity, so two dismissals never share a file. */
function problemSlug(rule: string, identity: string): string {
  const base = slugOf(rule).replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'problem';
  return `${base}-${createHash('sha1').update(identity).digest('hex').slice(0, 12)}`;
}

export function dismissalFile(rule: string, identity: string): string {
  return `${PROBLEMS_FOLDER}/${problemSlug(rule, identity)}.md`;
}

export interface DismissInput {
  readonly productFolder: string;
  readonly rule: string;
  readonly identity: string;
  readonly place: string;
  readonly reason: string;
  readonly by: Author;
  readonly at: string;
}

/** Writes a dismissal for the first time; refuses a second record for the same problem and a reason that says nothing. */
export function writeProblemDismissal(input: DismissInput): { file: string; dismissal: ProblemDismissal } {
  const reason = input.reason.trim();
  if (reason === '') throw new Error('docs/problems:1: a dismissal says why the problem is not one');
  if (reason.length > MAX_REASON) throw new Error(`docs/problems:1: the reason is ${reason.length} characters; it is at most ${MAX_REASON}`);
  const file = dismissalFile(input.rule, input.identity);
  if (existsSync(join(input.productFolder, file))) throw new Error(`${file}:1: this problem is already dismissed`);
  const dismissal: ProblemDismissal = { id: problemId(input.rule, input.identity), rule: input.rule, identity: input.identity, place: input.place, reason, by: input.by, at: input.at, file };
  const front = stringifyYaml({
    kind: DISMISSAL_KIND, rule: input.rule, identity: input.identity, place: input.place, reason,
    by: { name: input.by.name, email: input.by.email, verified: input.by.verified }, at: input.at,
  });
  const body = `## Why it is not a problem\n\n${reason}\n\nDismissed by ${input.by.name} <${input.by.email}> at ${input.at}.\n`;
  mkdirSync(join(input.productFolder, PROBLEMS_FOLDER), { recursive: true });
  writeFileSync(join(input.productFolder, file), `---\n${front}---\n\n${body}`, { encoding: 'utf8', flag: 'wx' });
  return { file, dismissal };
}
