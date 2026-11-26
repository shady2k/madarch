import { describe, expect, test } from 'bun:test';
import { reconcileFacts, type EdgeResult, type VertexResult } from '../src/plugin-sdk.js';

const scope = { repository: 'fixture', commit: 'current', parent: { kind: 'code.repository', key: { name: 'fixture' } } };
const vertex = (name: string, value: unknown): VertexResult => ({ kind: 'item', key: { name }, keyEdges: { repository: { kind: 'code.repository', key: { name: 'fixture' } } }, values: { value }, evidence: { target: { kind: 'blob', key: { digest: 'retained' } } } });
const edge = (name: string, value: unknown): EdgeResult => ({ kind: 'link', from: { kind: 'item', key: { name }, keyEdges: { repository: scope.parent } }, to: { kind: 'item', key: { name: 'target' }, keyEdges: { repository: scope.parent } }, values: { value }, evidence: { target: { kind: 'blob', key: { digest: 'retained' } } } });

describe('shared plugin reconciliation (0039 items 18 and 26)', () => {
  test('emits exactly add, change and removal, without changing retained evidence', () => {
    const writes = reconcileFacts({ vertices: [vertex('added', 1), vertex('changed', 2), vertex('same', 1)], end: { state: 'complete' } },
      { vertices: [vertex('removed', 1), vertex('changed', 1), vertex('same', 1)], edges: [] }, scope);
    expect(writes.map(({ operation, vertex }) => [operation, vertex?.key['name']])).toEqual([['add', 'added'], ['update', 'changed'], ['remove', 'removed']]);
    expect(writes.every(({ evidence }) => evidence?.target.key['digest'] === 'retained' && evidence.commit === undefined)).toBe(true);
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
    const previous = { ...vertex('same', { a: 1, b: [1, 2], c: null }), evidence: { target: { kind: 'blob', key: { digest: 'old' } }, digest: 'old' } };
    const same = { ...vertex('same', { c: null, b: [1, 2], a: 1 }), evidence: { target: { kind: 'blob', key: { digest: 'current' } }, digest: 'current' } };
    expect(reconcileFacts({ vertices: [same], end: { state: 'complete' } }, { vertices: [previous], edges: [] }, scope)).toEqual([]);
    expect(reconcileFacts({ vertices: [vertex('same', { a: 1, b: [2, 1] })], end: { state: 'complete' } }, { vertices: [previous], edges: [] }, scope)[0]?.operation).toBe('update');
    expect(reconcileFacts({ vertices: [{ ...vertex('same', null), values: {} }], end: { state: 'complete' } }, { vertices: [vertex('same', null)], edges: [] }, scope).map(write => write.operation)).toEqual(['update']);
  });

  test('removal retains the immutable historical target and locator', () => {
    const removed = { ...vertex('removed', 1), evidence: { target: { kind: 'blob', key: { digest: 'old' } }, commit: 'old', path: 'src/removed.ts', lineStart: 3, lineEnd: 5 } };
    const source = { end: { state: 'complete' as const } };
    expect(reconcileFacts(source, { vertices: [removed], edges: [] }, scope)[0]?.evidence).toEqual({ target: { kind: 'blob', key: { digest: 'old' } }, commit: 'old', path: 'src/removed.ts', lineStart: 3, lineEnd: 5 });
    expect(reconcileFacts(source, { vertices: [removed], edges: [] }, {})[0]?.evidence).toEqual({ target: { kind: 'blob', key: { digest: 'old' } }, commit: 'old', path: 'src/removed.ts', lineStart: 3, lineEnd: 5 });
  });


  test('desired foreign parents are refused while existing foreign facts remain untouched', () => {
    const foreign = { ...vertex('foreign', 1), keyEdges: { repository: { kind: 'code.repository', key: { name: 'other' } } } };
    expect(() => reconcileFacts({ vertices: [foreign], end: { state: 'complete' } }, { vertices: [], edges: [] }, scope)).toThrow();
    expect(reconcileFacts({ end: { state: 'complete' } }, { vertices: [foreign], edges: [] }, scope)).toEqual([]);
  });

  test('nested parent roles match structurally without depending on object field order', () => {
    const nested = { ...vertex('nested', 1), keyEdges: { directory: { kind: 'directory', key: { path: 'src' }, keyEdges: { owner: { key: { name: 'fixture' }, kind: 'code.repository' } } } } };
    const writes = reconcileFacts({ vertices: [nested], end: { state: 'complete' } }, { vertices: [], edges: [] }, scope);
    expect(writes.map(write => write.operation)).toEqual(['add']);
    expect(writes[0]?.vertex).toEqual(nested);
  });

  test('duplicate identities fail rather than silently shrinking the source', () => {
    expect(() => reconcileFacts({ vertices: [vertex('same', 1), vertex('same', 2)], end: { state: 'complete' } }, { vertices: [], edges: [] }, scope)).toThrow('duplicate vertex identity');
  });
});
