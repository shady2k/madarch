import { AsyncLocalStorage } from 'node:async_hooks';
import type { AssertionChange, AssertionRecord } from '../history/types.js';
import type { AsyncQueryEngine, QueryEngine, QuerySnapshot } from './types.js';

import { createOperationGate } from './operation-gate.js';

/**
 * Transitional bridge for a synchronous query engine. It preserves the old
 * implementation while async callers migrate; PGlite/PostgreSQL must implement
 * `AsyncQueryEngine` directly rather than use this adapter.
 */
export function adaptSynchronousQueryEngine(engine: QueryEngine): AsyncQueryEngine {
  const gate = createOperationGate({ allowConcurrentSnapshots: true });
  let closing = false;
  let closed = false;
  let closePromise: Promise<void> | undefined;
  const snapshotContext = new AsyncLocalStorage<boolean>();

  function ensureOutsideSnapshot(): void {
    if (snapshotContext.getStore()) {
      throw new Error('do not call the query engine from inside withSnapshot; use the supplied snapshot reader');
    }
  }

  function ensureOpen(): void {
    if (closing || closed) throw new Error('the query engine is closed');
  }

  const withSnapshot = <T>(work: (snapshot: QuerySnapshot) => Promise<T>): Promise<T> => {
    try {
      ensureOutsideSnapshot();
      ensureOpen();
    } catch (error) {
      return Promise.reject(error);
    }
    return gate.snapshot(async () => {
      let active = true;
      const ensureActive = (): void => {
        if (!active) throw new Error('the query snapshot has ended');
      };
      const snapshot: QuerySnapshot = {
        children: async (elementId, at) => { ensureActive(); return engine.children(elementId, at); },
        view: async (input, at) => { ensureActive(); return engine.view(input, at); },
        dependents: async (elementId, options, at) => { ensureActive(); return engine.dependents(elementId, options, at); },
        dependencies: async (elementId, options, at) => { ensureActive(); return engine.dependencies(elementId, options, at); },
      };
      try {
        return await snapshotContext.run(true, () => work(snapshot));
      } finally {
        active = false;
      }
    });
  };

  return {
    children: (elementId, at) => withSnapshot((snapshot) => snapshot.children(elementId, at)),
    view: (input, at) => withSnapshot((snapshot) => snapshot.view(input, at)),
    dependents: (elementId, options, at) => withSnapshot((snapshot) => snapshot.dependents(elementId, options, at)),
    dependencies: (elementId, options, at) => withSnapshot((snapshot) => snapshot.dependencies(elementId, options, at)),
    withSnapshot,
    rebuild: async (assertions: readonly AssertionRecord[]) => {
      ensureOutsideSnapshot();
      ensureOpen();
      await gate.write(() => engine.rebuild(assertions));
    },
    update: async (opened: readonly AssertionChange[], closed: readonly AssertionChange[]) => {
      ensureOutsideSnapshot();
      ensureOpen();
      await gate.write(() => engine.update(opened, closed));
    },
    close: () => {
      try {
        ensureOutsideSnapshot();
      } catch (error) {
        return Promise.reject(error);
      }
      if (closePromise !== undefined) return closePromise;
      if (closed) return Promise.resolve();
      closing = true;
      closePromise = gate.write(() => {
        closed = true;
        engine.close();
      });
      return closePromise;
    },
  };
}
