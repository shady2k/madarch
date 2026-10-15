import { createLadybugEngine, type LadybugEngineOptions } from './ladybug-engine.js';
import { adaptSynchronousQueryEngine } from '../query/async-compatibility.js';
import type { AsyncQueryEngine } from '../query/types.js';

/** Transitional asynchronous port over the synchronous Ladybug implementation. */
export function createAsyncLadybugEngine(options: LadybugEngineOptions = {}): AsyncQueryEngine {
  return adaptSynchronousQueryEngine(createLadybugEngine(options));
}
