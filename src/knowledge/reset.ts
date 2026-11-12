/**
 * A start-over plan removes agent pages, unanswered agent questions and rebuildable
 * stores. People's answers, questions and corrections stay in their repository.
 * Validate the complete plan again before applying it: an answer added after the
 * preview is never deleted using that old preview.
 */
import { lstatSync, realpathSync, rmSync, rmdirSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { renderCorrection, renderQuestion } from '../loop/entities.js';
import { graphQuestions, graphCorrections, type LoopGraph } from '../loop/graph.js';
import { graphKnowledgePages } from './index/index.js';
import type { KindsManifest } from '../product/manifest/kinds.js';
import { byCodePoint } from '../model/order.js';

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
  graph: LoopGraph;
  manifest: KindsManifest;
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
function realInside(folder: string, path: string): boolean {
  try {
    const root = realpathSync(folder);
    const real = realpathSync(path);
    return real === root || real.startsWith(`${root}${sep}`);
  } catch { return false; }
}

function contained(root: string, path: string): void {
  if (!realInside(root, path)) throw failure(path, `the path is a link to a place outside the product ${resolve(root)}, or cannot be resolved; nothing was removed`);
}

function fingerprint(root: string, path: string): string {
  contained(root, path);
  try {
    const stat = lstatSync(path, { bigint: true });
    return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
  } catch (error) { throw failure(path, `the file cannot be inspected: ${(error as Error).message}`); }
}

/** What a reset would remove and keep; nothing is changed. Unsafe input refuses the whole plan. */
export async function planReset(productFolder: string, storeFolder: string, graph: LoopGraph, manifest: KindsManifest, storeRoot?: string): Promise<ResetPlan> {
  productFolder = resolve(productFolder); storeFolder = resolve(storeFolder);
  if (storeRoot !== undefined && !storeFolder.startsWith(`${resolve(storeRoot)}${sep}`)) throw failure(storeFolder, `not inside the knowledge root ${resolve(storeRoot)}: nothing was removed`);
  if (present(storeFolder) && storeRoot !== undefined && !realInside(storeRoot, storeFolder)) throw failure(storeFolder, `not inside the knowledge root ${resolve(storeRoot)}: nothing was removed`);
  const store = ['graph', 'read', 'last-fill.json', 'pages-language.json', 'pause.json', 'fill-active.json', 'changed-pages.json'].map((name) => join(storeFolder, name)).filter(present);
  for (const path of store) if (!realInside(storeFolder, path)) throw failure(path, 'the store path leaves its folder or cannot be resolved: nothing was removed');
  const plan: ResetPlan = { store, agentPages: [], keptPages: [], unansweredQuestions: [], keptAnswers: [] };
  const files = new Map<string, string>(); const edits = new Map<string, string>(); const removed = new Set<string>();
  const { pages, findings } = await graphKnowledgePages(graph, manifest);
  if (findings.length) throw failure(productFolder, findings.map((finding) => `${finding.file}:${finding.line}: ${finding.message}`).join('\n'));
  for (const page of pages) {
    if (page.kind !== 'product' && page.kind !== 'domain') continue;
    const relative = page.file;
    const path = join(productFolder, relative);
    files.set(relative, fingerprint(productFolder, path));
    if (page.producer === 'agent') {
      plan.agentPages.push(relative); removed.add(page.id);
    } else plan.keptPages.push(relative);
  }
  const questions = await graphQuestions(graph);
  const corrections = await graphCorrections(graph);
  for (const item of [...questions, ...corrections]) {
    const relative = item.file;
    const path = join(productFolder, relative);
    files.set(relative, fingerprint(productFolder, path));
    const question = questions.includes(item as typeof questions[number]);
    if (question) {
      if (item.status === 'answered') plan.keptAnswers.push(relative);
      else if (item.status === 'open' && (item as unknown as { producer?: string }).producer === 'agent') plan.unansweredQuestions.push(relative);
    }
    const remaining = item.resolvedBy.filter((id) => !removed.has(id));
    if (remaining.length !== item.resolvedBy.length) {
      const updated = { ...item, resolvedBy: remaining, resolvedAt: remaining.length === 0 ? null : item.resolvedAt };
      edits.set(relative, question
        ? renderQuestion(updated as typeof questions[number])
        : renderCorrection({ ...updated, status: 'open' } as typeof corrections[number]));
    }
  }
  for (const paths of [plan.agentPages, plan.keptPages, plan.unansweredQuestions, plan.keptAnswers]) paths.sort(byCodePoint);
  prepared.set(plan, { graph, manifest, product: productFolder, storeFolder, storeRoot, files, edits, preview: JSON.stringify(plan) });
  return plan;
}

/** Validate all inputs before any write/removal. A newer human answer requires a new preview. */
export async function applyReset(productFolder: string, plan: ResetPlan, options: { keepQuestions?: boolean; keepStore?: boolean; resetStore?: () => Promise<void> } = {}): Promise<void> {
  const original = prepared.get(plan);
  if (original === undefined || original.product !== resolve(productFolder) || original.preview !== JSON.stringify(plan)) throw failure(productFolder, 'reset plan is not a validated local plan; request a new preview: nothing was removed');
  const fresh = await planReset(productFolder, original.storeFolder, original.graph, original.manifest, original.storeRoot);
  const current = prepared.get(fresh)!;
  if (JSON.stringify(fresh) !== original.preview || original.files.size !== current.files.size) throw failure(productFolder, 'the reset inputs changed since the preview; request a new preview: nothing was removed');
  for (const [relative, source] of original.files) if (current.files.get(relative) !== source) throw failure(join(productFolder, relative), 'the file changed since the preview; request a new preview: nothing was removed');
  // All validation is complete. The owner resets database contents without unlinking a live cluster.
  await options.resetStore?.();
  // The owner call yields: a person may have edited a file or replaced a store path meanwhile.
  for (const [relative, source] of original.files) {
    if (fingerprint(productFolder, join(productFolder, relative)) !== source) throw failure(join(productFolder, relative), 'the file changed during reset; nothing was removed from the product');
  }
  for (const path of plan.store) if (present(path) && !realInside(original.storeFolder, path)) throw failure(path, 'the store path leaves its folder: nothing was removed from the product');
  // A write failure is explicit and happens before deletion.
  for (const [relative, source] of original.edits) {
    if (!options.keepQuestions && plan.unansweredQuestions.includes(relative)) continue;
    const path = join(productFolder, relative);
    try { writeFileSync(path, source, 'utf8'); }
    catch (error) { throw failure(path, `resolution metadata could not be updated: ${(error as Error).message}`); }
  }
  const paths = [...(options.keepStore ? [] : plan.store.filter((path) => options.resetStore === undefined || path !== join(original.storeFolder, 'graph'))), ...plan.agentPages.map((relative) => join(productFolder, relative)), ...(options.keepQuestions ? [] : plan.unansweredQuestions.map((relative) => join(productFolder, relative)))];
  for (const path of paths) {
    try { rmSync(path, { recursive: plan.store.includes(path), force: true }); }
    catch (error) { throw failure(path, `could not be removed: ${(error as Error).message}`); }
  }
  try { rmdirSync(join(productFolder, 'docs', 'domains')); }
  catch { /* A person's page remains, or the folder is gone. */ }
}
