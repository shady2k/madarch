/**
 * The lock one graph folder takes (madarch-ztyq.10 review): taken atomically, so
 * two processes that start together against an empty cache cannot both open the
 * same PGlite directory, and held until the database is closed.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, test } from 'bun:test';
import { acquireFolderLock, releaseFolderLock } from '../src/mcp/graph.js';

const FOLDER = mkdtempSync(path.join(tmpdir(), 'madarch-mcp-lock-'));

afterAll(() => { rmSync(FOLDER, { recursive: true, force: true }); });

describe('the folder lock', () => {
  test('two acquisitions of one folder: the first holds it, the second is refused by name', () => {
    const held = acquireFolderLock(FOLDER);
    expect(held.pid).toBe(process.pid);
    expect(() => acquireFolderLock(FOLDER)).toThrow(/server\.lock/);
    expect(() => acquireFolderLock(FOLDER)).toThrow(/already served/);
    releaseFolderLock(FOLDER, held);
    const again = acquireFolderLock(FOLDER);
    releaseFolderLock(FOLDER, again);
  });
});
