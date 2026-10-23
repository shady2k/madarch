/**
 * What a person writes in the wiki lands in the product repository
 * (decision 0029: "What people write cannot be rebuilt at all"; decision 0031:
 * identity is git locally). An answer is written into its question's file; a
 * correction is a new file. Each is committed in the product repository with
 * the person as the author (git's `user.name` and `user.email`) and carries
 * the mark "local, not verified": on a local install the author is whatever
 * the person set. A write that cannot be made is an error saying why; a write
 * that was made but not committed says so in `committed`.
 */
import { whoIsTheUser } from '../identity/identity.js';
import { execFile } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { byCodePoint } from '../model/order.js';
import { slugOf } from '../writer/names.js';
import { readKnowledgePages } from '../knowledge/index/index.js';
import {
  CORRECTIONS_FOLDER, CORRECTION_KIND, LOCAL_UNVERIFIED, LoopFileError, MAX_ANSWER, MAX_REASON, QUESTION_KIND,
  correctionPath, freeSlug, parseCorrection, parseQuestion, parseStatementRef, questionPath, renderCorrection, renderQuestion,
  type Author, type Correction, type Question,
} from './entities.js';

const run = promisify(execFile);

/** Why a request is refused: for the reader, in words; `status` is the HTTP status it maps to. */
export class LoopRefusal extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export interface Committed {
  readonly committed: boolean;
  /** The commit's id when committed. */
  readonly commit?: string;
  /** Why nothing was committed. */
  readonly note?: string;
}

async function git(folder: string, args: string[], env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const { stdout } = await run('git', ['-C', folder, ...args], { encoding: 'utf8', env: { ...env, LC_ALL: 'C' } });
  return stdout.trim();
}

/** The person writing: whoever the identity seam says the user is (decision 0031; git's name and email here, the author variables first). A missing one is refused with the fix. */
export async function localIdentity(productFolder: string, env: NodeJS.ProcessEnv = process.env): Promise<Author> {
  const who = whoIsTheUser(productFolder, undefined, env);
  if (!who.ok) throw new LoopRefusal(409, who.message);
  return { name: who.identity.name, email: who.identity.email, verified: who.identity.mark };
}

async function insideRepository(productFolder: string, env: NodeJS.ProcessEnv): Promise<string | undefined> {
  try {
    const top = await git(productFolder, ['rev-parse', '--show-toplevel'], env);
    return top === '' ? undefined : top;
  } catch {
    return undefined;
  }
}

/** Commits the files in the product repository with the person as author. Never throws: the result says what happened. */
export async function commitFiles(productFolder: string, files: readonly string[], message: string, by: Author, env: NodeJS.ProcessEnv = process.env): Promise<Committed> {
  const top = await insideRepository(productFolder, env);
  if (top === undefined) return { committed: false, note: `${productFolder} is not a git repository, so the file was written but not committed` };
  try {
    await git(productFolder, ['add', '--', ...files], env);
    await git(productFolder, ['-c', `user.name=${by.name}`, '-c', `user.email=${by.email}`, 'commit', '-q', '-m', message, `--author=${by.name} <${by.email}>`, '--', ...files], env);
    return { committed: true, commit: await git(productFolder, ['rev-parse', 'HEAD'], env) };
  } catch (error) {
    const stderr = String((error as { stderr?: unknown }).stderr ?? '').trim();
    return { committed: false, note: `the file was written but git could not commit it in ${productFolder}: ${stderr.split('\n')[0] || (error as Error).message}` };
  }
}

/** The file and its folder stand inside the product: a folder or file that is a link out of it is not the wiki's to write. */
function assertInside(productFolder: string, path: string): void {
  const root = realpathSync(productFolder);
  let probe = path;
  while (!existsSync(probe)) probe = dirname(probe);
  const real = realpathSync(probe);
  if (real !== root && !real.startsWith(`${root}/`)) throw new LoopRefusal(422, `${probe} is a link to ${real}, outside the product ${productFolder}, so nothing is written there`);
  if (existsSync(path)) {
    const file = realpathSync(path);
    if (!file.startsWith(`${root}/`)) throw new LoopRefusal(422, `${path} is a link to ${file}, outside the product ${productFolder}, so nothing is written there`);
  }
}

async function writeWhole(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.writing`;
  await writeFile(temporary, content, 'utf8');
  await rename(temporary, path);
}

/** One write per file at a time: two answers to one question never both pass the "still open" check. */
const writing = new Map<string, Promise<unknown>>();
async function alone<T>(key: string, work: () => Promise<T>): Promise<T> {
  const before = writing.get(key) ?? Promise.resolve();
  const turn = before.then(work, work);
  writing.set(key, turn.catch(() => undefined));
  return await turn;
}

export interface AnswerInput {
  readonly productFolder: string;
  readonly slug: string;
  readonly text: string;
  readonly now?: () => Date;
  readonly env?: NodeJS.ProcessEnv;
}

export interface Answered extends Committed {
  readonly question: Question;
}

export async function answerQuestion(input: AnswerInput): Promise<Answered> {
  const env = input.env ?? process.env;
  if (!/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(input.slug)) throw new LoopRefusal(400, `"${input.slug}" is no question id: a question's id is lower-case words joined by hyphens`);
  const text = input.text.replace(/\r\n/g, '\n').trim();
  if (text === '') throw new LoopRefusal(400, 'the answer is empty: write what is true, in your own words');
  if (text.length > MAX_ANSWER) throw new LoopRefusal(413, `the answer is ${text.length} characters, past the ${MAX_ANSWER} a question's file keeps`);
  const file = questionPath(input.slug);
  const path = join(input.productFolder, file);
  return await alone(path, async () => {
    let source: string;
    try {
      source = await readFile(path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new LoopRefusal(404, `there is no question ${input.slug}: ${file} is not in the product repository`);
      throw new LoopRefusal(500, `${file} cannot be read: ${(error as Error).message}`);
    }
    let question: Question;
    try {
      question = parseQuestion(file, source);
    } catch (error) {
      if (error instanceof LoopFileError) throw new LoopRefusal(422, error.message);
      throw error;
    }
    if (question.status === 'answered') throw new LoopRefusal(409, `the question ${input.slug} is already answered (by ${question.answer!.by.name} at ${question.answer!.at}); to change what the wiki says, record a correction on the page that used the answer`);
    assertInside(input.productFolder, path);
    const by = await localIdentity(input.productFolder, env);
    const at = (input.now?.() ?? new Date()).toISOString();
    const answered: Question = { ...question, status: 'answered', answer: { text, by, at } };
    await writeWhole(path, renderQuestion(answered));
    const committed = await commitFiles(input.productFolder, [file], `Answer the question ${input.slug}\n\nAnswered in the wiki by ${by.name} <${by.email}> (${by.verified}).`, by, env);
    return { question: answered, ...committed };
  });
}

export interface CorrectionInput {
  readonly productFolder: string;
  /** `<page id>#<statement name>`: the statement the correction is about. */
  readonly statement: string;
  readonly reason: string;
  readonly now?: () => Date;
  readonly env?: NodeJS.ProcessEnv;
}

export interface Corrected extends Committed {
  readonly correction: Correction;
}

/** Finds a statement of the product's pages: its page, its sentence and its file. */
export function findStatement(productFolder: string, ref: string): { page: string; file: string; text: string } | undefined {
  const parsed = parseStatementRef(ref);
  if (parsed === undefined) return undefined;
  const { pages } = readKnowledgePages(productFolder);
  const page = pages.find((candidate) => candidate.id === parsed.page);
  const statement = page?.statements.find((candidate) => candidate.id === parsed.statement);
  return page === undefined || statement === undefined ? undefined : { page: page.id, file: page.file, text: statement.text };
}

export async function recordCorrection(input: CorrectionInput): Promise<Corrected> {
  const env = input.env ?? process.env;
  const parsed = parseStatementRef(input.statement);
  if (parsed === undefined) throw new LoopRefusal(400, `"statement" is a page id, a hash and the statement's name, such as domain:payments#refund-check; got ${JSON.stringify(input.statement)}`);
  const reason = input.reason.replace(/\r\n/g, '\n').trim();
  if (reason === '') throw new LoopRefusal(400, 'the correction has no reason: say why the statement is wrong ("wrong, because ...")');
  if (reason.length > MAX_REASON) throw new LoopRefusal(413, `the reason is ${reason.length} characters, past the ${MAX_REASON} a correction keeps`);
  const found = findStatement(input.productFolder, input.statement);
  if (found === undefined) throw new LoopRefusal(404, `the product has no statement ${input.statement}: it may have been rewritten since the page was opened; open the page again and choose the sentence`);
  const by = await localIdentity(input.productFolder, env);
  const at = (input.now?.() ?? new Date()).toISOString();
  const first = reason.replace(/\s+/g, ' ');
  const title = first.length > 80 ? `${first.slice(0, 79)}…` : first;
  // The slug is chosen inside the turn: two corrections at once never pick the same file.
  return await alone(join(input.productFolder, CORRECTIONS_FOLDER), async () => {
    const slug = freeSlug(input.productFolder, CORRECTIONS_FOLDER, slugOf(`${parsed.statement} ${reason}`, parsed.statement));
    const file = correctionPath(slug);
    const correction: Correction = { slug, id: `${CORRECTION_KIND}:${slug}`, file, title, status: 'open', about: input.statement, statement: found.text, reason, by, at, resolvedBy: [], resolvedAt: null };
    assertInside(input.productFolder, join(input.productFolder, file));
    await writeWhole(join(input.productFolder, file), renderCorrection(correction));
    const committed = await commitFiles(input.productFolder, [file], `Record the correction ${slug}\n\nCorrected in the wiki by ${by.name} <${by.email}> (${by.verified}): ${input.statement}.`, by, env);
    return { correction, ...committed };
  });
}

/** A page's rewrite used an answer or a correction: the file says which page closed it. Not committed (a page the agent writes is not either). */
export async function markResolved(productFolder: string, resolved: { readonly kind: 'question' | 'correction'; readonly slug: string; readonly pages: readonly string[]; readonly now?: () => Date }): Promise<void> {
  const file = resolved.kind === QUESTION_KIND ? questionPath(resolved.slug) : correctionPath(resolved.slug);
  const path = join(productFolder, file);
  await alone(path, async () => {
    assertInside(productFolder, path);
    const source = await readFile(path, 'utf8');
    const at = (resolved.now?.() ?? new Date()).toISOString();
    if (resolved.kind === QUESTION_KIND) {
      const question = parseQuestion(file, source);
      await writeWhole(path, renderQuestion({ ...question, resolvedBy: [...new Set([...question.resolvedBy, ...resolved.pages])].sort(byCodePoint), resolvedAt: at }));
    } else {
      const correction = parseCorrection(file, source);
      await writeWhole(path, renderCorrection({ ...correction, status: 'applied', resolvedBy: [...new Set([...correction.resolvedBy, ...resolved.pages])].sort(byCodePoint), resolvedAt: at }));
    }
  });
}
