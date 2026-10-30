/**
 * The changed pages beside a product's store (madarch-u3vw2): a list belongs to the run whose start and end it names,
 * and a run under way when the server stopped leaves the earlier list behind, not restorable.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ACTIVE_FILL_FILE, CHANGED_PAGES_FILE, DOCUMENT_PAGES_FILE, invalidateInterruptedRun, readChangedPages, readDocumentPages } from '../src/knowledge/changed-pages.js';

let folder: string;
beforeEach(() => { folder = mkdtempSync(join(tmpdir(), 'madarch-changed-pages-')); });
afterEach(() => { rmSync(folder, { recursive: true, force: true }); });

const put = (name: string, value: unknown): void => writeFileSync(join(folder, name), `${JSON.stringify(value)}\n`, 'utf8');

describe('the result of a completed run', () => {
  test('is restored only for the run whose start and end it names', () => {
    put(CHANGED_PAGES_FILE, { startedAt: '2026-10-29T10:00:00.000Z', finishedAt: '2026-10-29T10:01:00.000Z', pages: [{ id: 'domain:payment', title: 'Payment' }] });
    expect(readChangedPages(folder, { startedAt: '2026-10-29T10:00:00.000Z', finishedAt: '2026-10-29T10:01:00.000Z' })).toEqual([{ id: 'domain:payment', title: 'Payment' }]);
    // A later run's boundary does not adopt an earlier run's list, even when the end is what an older record kept.
    expect(readChangedPages(folder, { startedAt: '2026-10-29T11:00:00.000Z', finishedAt: '2026-10-29T10:01:00.000Z' })).toBeUndefined();
    expect(readChangedPages(folder, { startedAt: null, finishedAt: '2026-10-29T10:01:00.000Z' })).toBeUndefined();
  });

  test('is not restored while a run is active: the completed run A list cannot come back during run B', () => {
    put(CHANGED_PAGES_FILE, { startedAt: '2026-10-29T10:00:00.000Z', finishedAt: '2026-10-29T10:01:00.000Z', pages: [{ id: 'domain:payment', title: 'Payment' }] });
    put(ACTIVE_FILL_FILE, { startedAt: '2026-10-29T11:00:00.000Z' });
    expect(readChangedPages(folder, { startedAt: '2026-10-29T10:00:00.000Z', finishedAt: '2026-10-29T10:01:00.000Z' })).toBeUndefined();
  });
});

describe('the launch after an interrupted run', () => {
  test('removes the previous run\'s list and the mark, so the recovered done status carries no old pages', () => {
    put(CHANGED_PAGES_FILE, { startedAt: '2026-10-29T10:00:00.000Z', finishedAt: '2026-10-29T10:01:00.000Z', pages: [{ id: 'domain:payment', title: 'Payment' }] });
    put(ACTIVE_FILL_FILE, { startedAt: '2026-10-29T11:00:00.000Z' });
    expect(invalidateInterruptedRun(folder)).toBe(true);
    expect(existsSync(join(folder, CHANGED_PAGES_FILE))).toBe(false);
    expect(existsSync(join(folder, ACTIVE_FILL_FILE))).toBe(false);
    expect(readChangedPages(folder, { startedAt: '2026-10-29T10:00:00.000Z', finishedAt: '2026-10-29T10:01:00.000Z' })).toBeUndefined();
  });

  test('leaves a completed run\'s list alone when no run was active', () => {
    put(CHANGED_PAGES_FILE, { startedAt: '2026-10-29T10:00:00.000Z', finishedAt: '2026-10-29T10:01:00.000Z', pages: [{ id: 'domain:payment', title: 'Payment' }] });
    expect(invalidateInterruptedRun(folder)).toBe(false);
    expect(readChangedPages(folder, { startedAt: '2026-10-29T10:00:00.000Z', finishedAt: '2026-10-29T10:01:00.000Z' })).toHaveLength(1);
  });
});

describe('the document entities of the last completed run', () => {
  test('are read by durable page id and refuse a value that is not a digest', () => {
    put(DOCUMENT_PAGES_FILE, { entities: { 'doc:docs/glossary.md#order': 'a'.repeat(64) } });
    expect(readDocumentPages(folder)).toEqual(new Map([['doc:docs/glossary.md#order', 'a'.repeat(64)]]));
    writeFileSync(join(folder, DOCUMENT_PAGES_FILE), JSON.stringify({ entities: { 'doc:docs/glossary.md#order': 3 } }), 'utf8');
    expect(readDocumentPages(folder)).toBeUndefined();
  });
});
