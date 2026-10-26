/**
 * A start-over plan removes agent pages, unanswered agent questions and rebuildable
 * stores. People's answers, questions and corrections stay in their repository.
 * Validate the complete plan again before applying it: an answer added after the
 * preview is never deleted using that old preview.
 */
import { lstatSync, readdirSync, readFileSync, realpathSync, rmSync, rmdirSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { parseDocument } from 'yaml';
import { parseCorrection, parseQuestion, CORRECTIONS_FOLDER, QUESTIONS_FOLDER } from '../loop/entities.js';
import { byCodePoint } from '../model/order.js';
import { splitFrontMatter } from './markdown.js';

export interface ResetPlan {
  /** Store folders and files that would be removed, absolute. */
  store: string[];
  /** Pages the writer produced, relative to the product repository. */
  agentPages: string[];
  /** Pages in the writer's places that a person wrote, kept. */
  keptPages: string[];
  /** Unanswered questions explicitly produced by the agent, removed on start over. */
  unansweredQuestions: string[];
  /** Answered question files, retained regardless of producer. */
  keptAnswers: string[];
}

interface Prepared {
  product: string;
  storeFolder: string;
  storeRoot?: string;
  files: Map<string, string>;
  edits: Map<string, string>;
  preview: string;
}
// Human text is not part of the transport: only the server holding this plan can apply it.
const prepared = new WeakMap<ResetPlan, Prepared>();
const failure = (file: string, message: string, line = 1): Error => new Error(`${resolve(file)}:${line}: ${message}`);

function present(path: string): boolean {
  try { lstatSync(path); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw failure(path, `cannot inspect the path: ${(error as Error).message}`);
  }
}

/** Whether the real place of a path stands inside a folder: a link out of it is not inside. */
export function realInside(folder: string, path: string): boolean {
  try {
    const root = realpathSync(folder);
    const real = realpathSync(path);
    return real === root || real.startsWith(`${root}${sep}`);
  } catch { return false; }
}

function contained(root: string, path: string): void {
  if (!realInside(root, path)) throw failure(path, `the path is a link to a place outside the product ${resolve(root)}, or cannot be resolved; nothing was removed`);
}

function names(root: string, directory: string): string[] {
  if (!present(directory)) return [];
  contained(root, directory);
  try { return readdirSync(directory).filter((name) => name.endsWith('.md')).sort(byCodePoint); }
  catch (error) { throw failure(directory, `the folder cannot be read: ${(error as Error).message}`); }
}

function read(root: string, path: string): string {
  contained(root, path);
  try { return readFileSync(path, 'utf8'); }
  catch (error) { throw failure(path, `the file cannot be read: ${(error as Error).message}`); }
}

/** Parse front matter without changing the body, author text, or custom fields. */
function frontOf(path: string, source: string, required: boolean): ReturnType<typeof parseDocument> | null {
  const { front } = splitFrontMatter(source);
  if (front === null) {
    if (required || source.replace(/^\uFEFF/, '').startsWith('---')) throw failure(path, 'the front matter is missing or not closed');
    return null;
  }
  const doc = parseDocument(front);
  if (doc.errors.length) throw failure(path, `malformed front matter: ${doc.errors[0]!.message}`, 1 + (doc.errors[0]!.linePos?.[0].line ?? 1));
  if (doc.contents === null || !doc.toJS() || typeof doc.toJS() !== 'object' || Array.isArray(doc.toJS())) throw failure(path, 'the front matter is a mapping', 2);
  const producer = doc.get('producer');
  if (producer !== undefined && (typeof producer !== 'string' || producer.trim() === '')) throw failure(path, '"producer" is a non-empty text', 2);
  return doc;
}

/** Replace only reset-owned metadata; keep the body and every human field as written. */
function resolutionEdit(source: string, resolvedBy: readonly string[], clearTime: boolean, pending: boolean): string {
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const normalized = source.replace(/\r\n/g, '\n');
  const { front } = splitFrontMatter(normalized);
  const doc = parseDocument(front!);
  if (resolvedBy.length) doc.set('resolved-by', [...resolvedBy]);
  else doc.delete('resolved-by');
  if (clearTime) doc.delete('resolved-at');
  if (pending) doc.set('status', 'open');
  const closing = source.indexOf(newline + '---', source.indexOf(newline) + newline.length);
  // Preserve the body bytes, including the person's quotation and its whitespace.
  return source.slice(0, source.indexOf(newline) + newline.length)
    + doc.toString({ lineWidth: 0 }).trimEnd().replace(/\n/g, newline)
    + source.slice(closing);
}

/** What a reset would remove and keep; nothing is changed. Unsafe input refuses the whole plan. */
export function planReset(productFolder: string, storeFolder: string, storeRoot?: string): ResetPlan {
  productFolder = resolve(productFolder); storeFolder = resolve(storeFolder);
  if (storeRoot !== undefined && !storeFolder.startsWith(`${resolve(storeRoot)}${sep}`)) throw failure(storeFolder, `not inside the knowledge root ${resolve(storeRoot)}: nothing was removed`);
  if (present(storeFolder) && storeRoot !== undefined && !realInside(storeRoot, storeFolder)) throw failure(storeFolder, `not inside the knowledge root ${resolve(storeRoot)}: nothing was removed`);
  const store = ['graph', 'read', 'last-fill.json', 'pages-language.json'].map((name) => join(storeFolder, name)).filter(present);
  for (const path of store) if (!realInside(storeFolder, path)) throw failure(path, 'the store path leaves its folder or cannot be resolved: nothing was removed');
  const plan: ResetPlan = { store, agentPages: [], keptPages: [], unansweredQuestions: [], keptAnswers: [] };
  const files = new Map<string, string>(); const edits = new Map<string, string>(); const removed = new Set<string>();
  const docs = join(productFolder, 'docs');
  if (present(docs)) contained(productFolder, docs);
  const candidates = ['docs/product.md', ...names(productFolder, join(docs, 'domains')).map((name) => `docs/domains/${name}`)];
  for (const relative of candidates) {
    const path = join(productFolder, relative);
    if (!present(path)) continue;
    const source = read(productFolder, path); files.set(relative, source);
    const front = frontOf(path, source, false);
    if (front?.get('producer') === 'agent') {
      const id = front.get('id');
      if (typeof id !== 'string' || !id.trim()) throw failure(path, 'an agent page needs a non-empty id', 2);
      plan.agentPages.push(relative); removed.add(id);
    } else plan.keptPages.push(relative);
  }
  for (const folder of [QUESTIONS_FOLDER, CORRECTIONS_FOLDER]) {
    for (const name of names(productFolder, join(productFolder, folder))) {
      const relative = `${folder}/${name}`; const path = join(productFolder, relative);
      const source = read(productFolder, path); files.set(relative, source);
      const front = frontOf(path, source, true)!;
      const item = folder === QUESTIONS_FOLDER ? parseQuestion(path, source) : parseCorrection(path, source);
      if (folder === QUESTIONS_FOLDER) {
        if (item.status === 'answered') plan.keptAnswers.push(relative);
        else if (item.status === 'open' && front.get('producer') === 'agent') plan.unansweredQuestions.push(relative);
      }
      const remaining = item.resolvedBy.filter((id) => !removed.has(id));
      if (remaining.length !== item.resolvedBy.length) {
        edits.set(relative, resolutionEdit(source, remaining, remaining.length === 0, folder === CORRECTIONS_FOLDER && item.status === 'applied'));
      }
    }
  }
  prepared.set(plan, { product: productFolder, storeFolder, storeRoot, files, edits, preview: JSON.stringify(plan) });
  return plan;
}

/** Validate all inputs before any write/removal. A newer human answer requires a new preview. */
export function applyReset(productFolder: string, plan: ResetPlan, options: { keepQuestions?: boolean; keepStore?: boolean } = {}): void {
  const original = prepared.get(plan);
  if (original === undefined || original.product !== resolve(productFolder) || original.preview !== JSON.stringify(plan)) throw failure(productFolder, 'reset plan is not a validated local plan; request a new preview: nothing was removed');
  const fresh = planReset(productFolder, original.storeFolder, original.storeRoot);
  const current = prepared.get(fresh)!;
  if (JSON.stringify(fresh) !== original.preview || original.files.size !== current.files.size) throw failure(productFolder, 'the reset inputs changed since the preview; request a new preview: nothing was removed');
  for (const [relative, source] of original.files) if (current.files.get(relative) !== source) throw failure(join(productFolder, relative), 'the file changed since the preview; request a new preview: nothing was removed');
  // All validation is complete. A write failure is explicit and happens before deletion.
  for (const [relative, source] of original.edits) {
    if (!options.keepQuestions && plan.unansweredQuestions.includes(relative)) continue;
    const path = join(productFolder, relative);
    try { writeFileSync(path, source, 'utf8'); }
    catch (error) { throw failure(path, `resolution metadata could not be updated: ${(error as Error).message}`); }
  }
  const paths = [...(options.keepStore ? [] : plan.store), ...plan.agentPages.map((relative) => join(productFolder, relative)), ...(options.keepQuestions ? [] : plan.unansweredQuestions.map((relative) => join(productFolder, relative)))];
  for (const path of paths) {
    try { rmSync(path, { recursive: plan.store.includes(path), force: true }); }
    catch (error) { throw failure(path, `could not be removed: ${(error as Error).message}`); }
  }
  try { rmdirSync(join(productFolder, 'docs', 'domains')); }
  catch { /* A person's page remains, or the folder is gone. */ }
}
