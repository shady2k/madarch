/**
 * Starting a product's knowledge over (madarch-m38l.4, remark 12): the same
 * for the wiki's "Start over" and `madarch reset <product>`.
 *
 * What goes: the product's graph store (the primary store and its snapshots,
 * rebuilt by the next fill) and the pages the writer produced, which are
 * `docs/product.md` and the files of `docs/domains/` whose front matter says
 * `producer: agent`. What stays: every other file of the product repository,
 * a page of those two places that a person wrote or edited into another
 * producer, the choice of the agent, and the code repositories under `repos/`,
 * which are never opened for writing here.
 */
import { existsSync, readdirSync, readFileSync, rmSync, rmdirSync } from 'node:fs';
import { join } from 'node:path';

export interface ResetPlan {
  /** Store folders and files that would be removed, absolute. */
  store: string[];
  /** Pages the writer produced, relative to the product repository. */
  agentPages: string[];
  /** Pages in the writer's places that a person wrote, kept. */
  keptPages: string[];
}

/** The front matter's `producer`, or null when the file has none. */
function producerOf(text: string): string | null {
  if (!text.startsWith('---\n')) return null;
  const end = text.indexOf('\n---', 4);
  if (end < 0) return null;
  const line = text.slice(4, end).split('\n').find((row) => /^producer:\s*/.test(row));
  return line === undefined ? null : line.replace(/^producer:\s*/, '').trim().replace(/^["']|["']$/g, '');
}

/** What a reset would remove and keep; nothing is changed. */
export function planReset(productFolder: string, storeFolder: string): ResetPlan {
  const store = ['graph', 'read', 'last-fill.json'].map((name) => join(storeFolder, name)).filter((path) => existsSync(path));
  const agentPages: string[] = [];
  const keptPages: string[] = [];
  const candidates = ['docs/product.md'];
  const domains = join(productFolder, 'docs', 'domains');
  if (existsSync(domains)) for (const name of readdirSync(domains).sort()) if (name.endsWith('.md')) candidates.push(`docs/domains/${name}`);
  for (const relative of candidates) {
    let text: string;
    try {
      text = readFileSync(join(productFolder, relative), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw new Error(`src/knowledge/reset.ts: ${join(productFolder, relative)} cannot be read to tell who wrote it: ${(error as Error).message}`);
    }
    (producerOf(text) === 'agent' ? agentPages : keptPages).push(relative);
  }
  return { store, agentPages, keptPages };
}

/** Removes what `planReset` names. An error names the path that could not be removed; what was removed before it stays removed. */
export function applyReset(productFolder: string, plan: ResetPlan): void {
  for (const path of plan.store) {
    try {
      rmSync(path, { recursive: true, force: true });
    } catch (error) {
      throw new Error(`src/knowledge/reset.ts: ${path} could not be removed: ${(error as Error).message}`);
    }
  }
  for (const relative of plan.agentPages) {
    const path = join(productFolder, relative);
    try {
      rmSync(path, { force: true });
    } catch (error) {
      throw new Error(`src/knowledge/reset.ts: ${path} could not be removed: ${(error as Error).message}`);
    }
  }
  try {
    rmdirSync(join(productFolder, 'docs', 'domains'));
  } catch {
    // the folder still holds a page of a person's, or is gone
  }
}
