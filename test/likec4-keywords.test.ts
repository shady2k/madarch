/** The gate's pinned external vocabulary must reproduce the official installed grammar exactly. */
import { expect, test } from 'bun:test';
import { LikeC4 } from 'likec4';
import pinned from '../scripts/check/architecture/external-likec4-keywords.json';
import { installedLikeC4Keywords } from '../scripts/check/architecture/generate-likec4-keywords.js';

test('the pinned LikeC4 keyword authority matches the installed official grammar bundle', async () => {
  expect<unknown>(await installedLikeC4Keywords()).toEqual(pinned);
  const model = await LikeC4.fromSource('specification { element item } model { x = item }', { logger: false });
  try { expect(model.hasErrors()).toBe(false); }
  finally { await model.dispose(); }
}, 30_000);
