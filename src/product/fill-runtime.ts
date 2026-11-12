/**
 * File-backed contracts and resume primitives for the self-filling pipeline.
 * Product kinds and extraction rules are deliberately supplied by the registry.
 */
import { createHash } from 'node:crypto';
import { readFile, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
type FillRunStatus = 'running' | 'paused' | 'stopped' | 'complete' | 'blocked';

/** Persisted manifest at .madarch/fill/run.json. */
export interface FillRun {
  schemaVersion: number;
  id: string;
  /** The one fill this run belongs to: a blocked run resumes under a new id but the same chain, and a completed fill ends its chain. */
  fillChainId?: string;
  productSnapshot: { repository: string; defaultBranch: string; commit: string; registryHash: string; targets?: { readonly kinds: readonly string[]; readonly vertex?: string } };
  agentBranch: string;
  status: FillRunStatus;
  controlOpen?: boolean;
  createdAt: string;
  updatedAt: string;
}
const digest = (bytes: string | Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/** Hash a pinned Git tree entry (or blob); callers include registry and upstream-output hashes as named inputs. */
export function hashFillInput(bytes: string | Uint8Array): string { return digest(bytes); }
export function hashFillInputs(inputs: Readonly<Record<string, string | Uint8Array>>): Record<string, string> {
  return Object.fromEntries(Object.keys(inputs).sort().map((key) => [key, digest(inputs[key]!) ]));
}
export function fillStatePaths(productRoot: string): { root: string; run: string; units: string; outputs: string; events: string } {
  const root = resolve(productRoot, '.madarch', 'fill');
  return { root, run: join(root, 'run.json'), units: join(root, 'units'), outputs: join(root, 'outputs'), events: join(root, 'events.jsonl') };
}
export type FillControl = 'running' | 'paused' | 'stopped';
/** Serialize coordinator transitions and control writers within the serving process. */
const fillControlQueues = new Map<string, Promise<void>>();
export async function withFillControlLock<T>(productRoot: string, action: () => Promise<T>): Promise<T> {
  const key = fillStatePaths(productRoot).root;
  const previous = fillControlQueues.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  fillControlQueues.set(key, current);
  await previous;
  try { return await action(); }
  finally {
    release();
    if (fillControlQueues.get(key) === current) fillControlQueues.delete(key);
  }
}


/** Read and consume a server-requested pause/stop control file. The orchestration caller maps it to its control callback. */
export async function consumeFillControl(productRoot: string, runId: string, locked = false): Promise<FillControl | undefined> {
  if (!locked) return withFillControlLock(productRoot, () => consumeFillControl(productRoot, runId, true));
  const file = join(fillStatePaths(productRoot).root, 'control.json');
  let request: { runId?: string; action?: string };
  try { request = JSON.parse(await readFile(file, 'utf8')) as { runId?: string; action?: string }; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; }
  if (request.runId !== runId) return undefined;
  await unlink(file);
  if (request.action === 'pause') return 'paused';
  if (request.action === 'stop') return 'stopped';
  return undefined;
}
