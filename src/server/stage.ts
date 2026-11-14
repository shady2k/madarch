import { AsyncLocalStorage } from 'node:async_hooks';
import type { ArmedRequest } from './watchdog.js';

/** Render stages belong to the request, including while other requests run. */
export const requestStage = new AsyncLocalStorage<ArmedRequest>();
