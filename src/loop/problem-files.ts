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
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { byCodePoint } from '../model/order.js';
import { slugOf } from '../knowledge/anchors.js';
import { splitFrontMatter } from '../knowledge/markdown.js';
import { problemId } from '../problems/types.js';
import type { Author } from './entities.js';
import type { ProductFileSource } from '../knowledge/product-files.js';

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

export interface DismissalRead {
  readonly items: readonly ProblemDismissal[];
  readonly problems: readonly { file: string; line: number; message: string }[];
}

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): string | undefined => (typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined);

const authorOf = (value: unknown): Author | undefined => {
  if (!isRecord(value)) return undefined;
  const name = text(value['name']);
  const email = text(value['email']);
  if (name === undefined || email === undefined) return undefined;
  return { name, email, verified: text(value['verified']) ?? 'local, not verified' };
};

/**
 * Reads every dismissal as one source of the product's files holds it: the graph's stored files for a reader of a page.
 * Every file the folder lists is fetched before it is parsed (stage C).
 */
export async function readProblemDismissalsIn(files: ProductFileSource): Promise<DismissalRead> {
  const paths = files.filesIn(PROBLEMS_FOLDER).filter((path) => path.endsWith('.md')).sort(byCodePoint);
  await files.ensure(paths);
  const problems: { file: string; line: number; message: string }[] = [];
  const entries: { file: string; source: string }[] = [];
  for (const file of paths) {
    const source = files.text(file);
    if (source === undefined) { problems.push({ file, line: 1, message: `${file}:1: the file cannot be read: the source holds no text of it` }); continue; }
    entries.push({ file, source });
  }
  return parseDismissals(entries, problems);
}

/** Parses the dismissal files one read found; a file that cannot be read is a finding with its path and line. */
function parseDismissals(entries: readonly { file: string; source: string }[], problems: { file: string; line: number; message: string }[]): DismissalRead {
  const items: ProblemDismissal[] = [];
  for (const { file, source } of entries) {
    const { front } = splitFrontMatter(source.replace(/\r\n/g, '\n'));
    if (front === null) { problems.push({ file, line: 1, message: `${file}:1: a dismissal opens with front matter (--- ... ---)` }); continue; }
    let parsed: unknown;
    try {
      parsed = parseYaml(front);
    } catch (error) {
      problems.push({ file, line: 1, message: `${file}:1: the front matter is not YAML: ${(error as Error).message}` });
      continue;
    }
    if (!isRecord(parsed)) { problems.push({ file, line: 1, message: `${file}:1: the front matter is a mapping` }); continue; }
    if (parsed['kind'] !== DISMISSAL_KIND) { problems.push({ file, line: 1, message: `${file}:1: "kind" is "${DISMISSAL_KIND}", got ${JSON.stringify(parsed['kind'])}` }); continue; }
    const rule = text(parsed['rule']);
    const identity = text(parsed['identity']);
    const place = text(parsed['place']);
    const reason = text(parsed['reason']);
    const by = authorOf(parsed['by']);
    const at = text(parsed['at']);
    if (rule === undefined || identity === undefined || place === undefined || reason === undefined || by === undefined || at === undefined) {
      problems.push({ file, line: 1, message: `${file}:1: a dismissal names "rule", "identity", "place", "reason", "by" (name, email, verified) and "at"` });
      continue;
    }
    items.push({ id: problemId(rule, identity), rule, identity, place, reason, by, at, file });
  }
  return { items, problems };
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
