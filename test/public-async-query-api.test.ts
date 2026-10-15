import { expect, test } from 'bun:test';
import * as api from '../src/index.js';

// @ts-expect-error The synchronous query port is no longer part of the public API.
import type { QueryEngine } from '../src/index.js';

void (null as QueryEngine | null);

test('the package exposes the asynchronous query and render interfaces only', () => {
  for (const retired of [
    'createLadybugEngine',
    'createAsyncLadybugEngine',
    'buildViewSet',
    'renderLikeC4Workspace',
    'renderOneViewMermaid',
    'renderOneViewLikeC4',
  ]) {
    expect(retired in api).toBe(false);
  }

  for (const available of [
    'createPGliteQueryDatabase',
    'createPostgresQueryDatabase',
    'buildAsyncViewSet',
    'renderAsyncLikeC4Workspace',
    'renderAsyncOneViewMermaid',
    'renderAsyncOneViewLikeC4',
  ]) {
    expect(available in api).toBe(true);
  }
});
