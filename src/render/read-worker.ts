/** Isolated read/layout workers: an idle worker may be reused, but an active request owns its deadline and worker. */
import { rmSync } from 'node:fs';
import type { PoolConfig } from 'pg';
import type { GraphqlAnswer, GraphqlOperation } from '../graph/graphql-execute.js';
import type { DiagramNeighbourhood } from '../graph/graphql-read.js';
import type { DiagramAnswer, DiagramRequest } from './diagram-render.js';
import { requestStage } from '../server/stage.js';
import { withSpan } from '../obs/trace.js';

export interface ReadDescriptor { readonly folder: string; readonly connection: PoolConfig }
export type ReadWork =
  | { readonly kind: 'graphql'; readonly descriptor: ReadDescriptor; readonly operation: GraphqlOperation; readonly deadlineMs?: number }
  | { readonly kind: 'diagram'; readonly descriptor?: ReadDescriptor; readonly neighbourhood?: DiagramNeighbourhood; readonly request: DiagramRequest; readonly deadlineMs?: number };
type ReadThread = Worker & { ref(): void; unref(): void };
let idle: ReadThread | undefined;

export function readWorker<T extends ReadWork>(work: Promise<T> | T, deadlineMs: number, workerUrl?: URL): Promise<T extends { kind: 'graphql' } ? GraphqlAnswer : DiagramAnswer> {
  const stage = requestStage.getStore();
  return new Promise((resolve, reject) => {
    let worker: ReadThread | undefined;
    let renderer: number | undefined;
    let folder: string | undefined;
    let finished = false;
    let finishStage: (() => void) | undefined;
    const markStage = (name: string): void => {
      finishStage?.();
      const spanName = name.startsWith('reading') ? 'diagram.read' : name.startsWith('folding') ? 'diagram.fold' : 'diagram.layout';
      void withSpan(spanName, {}, () => new Promise<void>((done) => { finishStage = done; }));
      stage?.stage(name);
    };
    const cleanRenderer = (): void => {
      if (renderer !== undefined) { try { process.kill(renderer, 'SIGKILL'); } catch { /* already exited */ } }
      if (folder !== undefined) rmSync(folder, { recursive: true, force: true });
    };
    const stop = (error: Error): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      finishStage?.();
      cleanRenderer();
      worker?.terminate();
      reject(error);
    };
    const timer = setTimeout(() => stop(new DOMException(`the read did not finish within ${String(deadlineMs)} ms`, 'TimeoutError')), deadlineMs);
    void Promise.resolve(work).then((asked) => {
      if (finished) return;
      worker = (workerUrl === undefined ? idle ?? new Worker(Bun.embeddedFiles.length > 0 ? new URL('./src/graph/read-worker.js', import.meta.url) : new URL('../graph/read-worker.ts', import.meta.url)) : new Worker(workerUrl.href)) as ReadThread;
      if (worker === idle) idle = undefined;
      const held = worker;
      held.onerror = (event) => { event.preventDefault(); stop(new Error(event.message)); };
      held.onmessage = (event: MessageEvent) => {
        const message = event.data as { kind: string; stage?: string; pid?: number; folder?: string; answer?: DiagramAnswer | GraphqlAnswer; message?: string };
        if (finished) {
          if (message.kind === 'renderer' && message.pid !== undefined) { try { process.kill(message.pid, 'SIGKILL'); } catch { /* already gone */ } }
          return;
        }
        if (message.kind === 'stage') { markStage(message.stage ?? 'rendering'); return; }
        if (message.kind === 'renderer') { renderer = message.pid; folder = message.folder; return; }
        if (finished) return;
        if (message.kind === 'error') { stop(new Error(message.message ?? 'the read worker failed')); return; }
        if (message.kind !== 'answer') return;
        finished = true;
        clearTimeout(timer);
        finishStage?.();
        renderer = undefined;
        folder = undefined;
        held.onmessage = null;
        held.onerror = null;
        if (idle === undefined && workerUrl === undefined) { idle = held; held.unref(); }
        else held.terminate();
        resolve(message.answer as T extends { kind: 'graphql' } ? GraphqlAnswer : DiagramAnswer);
      };
      held.ref();
      held.postMessage({ ...asked, deadlineMs });
    }).catch((error: unknown) => stop(error instanceof Error ? error : new Error(String(error))));
  });
}
