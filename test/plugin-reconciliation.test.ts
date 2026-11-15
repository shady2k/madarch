import { describe, expect, test } from 'bun:test';
import { reconcileFacts, type EdgeResult, type VertexResult } from '../src/plugin-sdk.js';

const scope = { repository: 'fixture', commit: 'current' };
const vertex = (name: string, value: unknown): VertexResult => ({ kind: 'item', key: { name }, values: { value } });
const edge = (name: string, value: unknown): EdgeResult => ({ kind: 'link', from: { kind: 'item', key: { name } }, to: { kind: 'item', key: { name: 'target' } }, values: { value } });

describe('shared plugin reconciliation (0039 items 18 and 26)', () => {
  test('emits exactly add, change and removal, with current absence evidence', () => {
    const writes = reconcileFacts({ vertices: [vertex('added', 1), vertex('changed', 2), vertex('same', 1)], end: { state: 'complete' } },
      { vertices: [vertex('removed', 1), vertex('changed', 1), vertex('same', 1)], edges: [] }, scope);
    expect(writes.map(({ operation, vertex }) => [operation, vertex?.key['name']])).toEqual([['add', 'added'], ['update', 'changed'], ['remove', 'removed']]);
    expect(writes.every(({ evidence }) => evidence.repository === 'fixture' && evidence.commitOrDigest === 'current')).toBe(true);
  });

  test('edges reconcile all three differences, preserving discriminator identity', () => {
    const writes = reconcileFacts({ edges: [edge('added', 1), edge('changed', 2), edge('same', 1)], end: { state: 'complete' } },
      { vertices: [], edges: [edge('removed', 1), edge('changed', 1), edge('same', 1)] }, scope);
    expect(writes.map(({ operation }) => operation)).toEqual(['add', 'update', 'remove']);
    const changedIdentity = reconcileFacts({ edges: [{ ...edge('same', 1), discriminator: 'new' }], end: { state: 'complete' } }, { vertices: [], edges: [edge('same', 1)] }, scope);
    expect(changedIdentity.map(({ operation }) => operation)).toEqual(['add', 'remove']);
  });

  test('partial or problematic reads never delete unseen facts', () => {
    for (const result of [
      { vertices: [vertex('added', 1)], end: { state: 'partial' as const, cause: '/fixture/unreadable.ts:1: denied' } },
      { vertices: [vertex('added', 1)], problems: [{ path: '/fixture/unreadable.ts', line: 1, message: 'denied' }], end: { state: 'complete' as const } },
    ]) {
      expect(reconcileFacts(result, { vertices: [vertex('removed', 1)], edges: [edge('removed', 1)] }, scope).map(({ operation }) => operation)).toEqual(['add']);
    }
  });

  test('canonical values ignore object order and evidence-only changes, not ordered arrays or nested nulls', () => {
    const previous = { ...vertex('same', { a: 1, b: [1, 2], c: null }), evidence: { commitOrDigest: 'old' } };
    const same = { ...vertex('same', { c: null, b: [1, 2], a: 1 }), evidence: { commitOrDigest: 'current' } };
    expect(reconcileFacts({ vertices: [same], end: { state: 'complete' } }, { vertices: [previous], edges: [] }, scope)).toEqual([]);
    expect(reconcileFacts({ vertices: [vertex('same', { a: 1, b: [2, 1] })], end: { state: 'complete' } }, { vertices: [previous], edges: [] }, scope)[0]?.operation).toBe('update');
    expect(reconcileFacts({ vertices: [{ kind: 'item', key: { name: 'same' } }], end: { state: 'complete' } }, { vertices: [vertex('same', null)], edges: [] }, scope)).toEqual([]);
  });

  test('removal retains the historical file locator but cites only the current scope commit', () => {
    const removed = { ...vertex('removed', 1), evidence: { repository: 'fixture', commitOrDigest: 'old', path: 'src/removed.ts', lineStart: 3, lineEnd: 5 } };
    const source = { end: { state: 'complete' as const } };
    expect(reconcileFacts(source, { vertices: [removed], edges: [] }, scope)[0]?.evidence).toEqual({ repository: 'fixture', commitOrDigest: 'current', path: 'src/removed.ts', lineStart: 3, lineEnd: 5 });
    expect(reconcileFacts(source, { vertices: [removed], edges: [] }, {})[0]?.evidence).toEqual({ repository: 'fixture', path: 'src/removed.ts', lineStart: 3, lineEnd: 5 });
  });

  test('duplicate identities fail rather than silently shrinking the source', () => {
    expect(() => reconcileFacts({ vertices: [vertex('same', 1), vertex('same', 2)], end: { state: 'complete' } }, { vertices: [], edges: [] }, scope)).toThrow('duplicate vertex identity');
  });
});
