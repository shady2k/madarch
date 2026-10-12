/**
 * `madarch version` (madarch-lfhu): the release the binary answers with,
 * `dev` in a checkout; the command's one fact and the upgrade's first
 * refusal (a source checkout has nothing to replace).
 */
import { describe, expect, test } from 'bun:test';
import { runningVersion } from '../src/product/version.js';

describe('the version madarch answers with', () => {
  test('a source checkout answers dev', () => {
    // The test process is the checkout: no release version is embedded.
    expect(runningVersion()).toBe('dev');
  });
});
