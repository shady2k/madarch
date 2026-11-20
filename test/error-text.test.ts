import { describe, expect, test } from 'bun:test';
import { inspect } from 'node:util';
import { errorText } from '../src/model/error-text.js';

describe('errorText', () => {
  const cycle: { a: number; self?: unknown } = { a: 1 };
  cycle.self = cycle;
  const cases: [string, unknown, string][] = [
    ['string', 'refused', 'refused'],
    ['Error', new Error('boom'), 'boom'],
    ['code and message', { code: 'plugin-refused', message: 'm' }, 'plugin-refused: m'],
    ['message', { message: 'm' }, 'm'],
    ['empty object', {}, '{}'],
    ['null prototype', Object.create(null), '[Object: null prototype] {}'],
    ['Symbol key', { [Symbol('reason')]: 'refused' }, "{ Symbol(reason): 'refused' }"],
    ['Map', new Map([['x', 1]]), "Map(1) { 'x' => 1 }"],
    ['Set', new Set([1]), 'Set(1) { 1 }'],
    ['holes', [, , 1], '[ <2 empty items>, 1 ]'],
    ['cycle', cycle, '<ref *1> { a: 1, self: [Circular *1] }'],
    ['BigInt', 1n, '1n'],
    ['nested BigInt', { n: 1n }, '{ n: 1n }'],
    ['null', null, 'null'],
    ['undefined', undefined, 'undefined'],
    ['Symbol', Symbol('s'), 'Symbol(s)'],
    ['function', function named() {}, '[Function: named]'],
    ['throwing message getter', { get message() { throw new Error('getter failed'); } }, '{ message: [Getter] }'],
  ];
  test.each(cases)('%s', (_name, thrown, expected) => {
    expect(errorText(thrown)).toBe(expected);
  });

  test.each([false, true])('never calls custom inspect (throws: %s)', throws => {
    let called = false;
    const thrown = { x: 1, [inspect.custom]() { called = true; if (throws) throw new Error('inspect failed'); return 'hidden'; } };
    expect(errorText(thrown).includes('x: 1')).toBe(true);
    expect(called).toBe(false);
  });

  test('inspects a throwing Proxy without calling its traps', () => {
    const calls: PropertyKey[] = [];
    const thrown = new Proxy({}, new Proxy({}, { get(_target, trap) { return () => { calls.push(trap); throw new Error('trap failed'); }; } }));
    expect(errorText(thrown).startsWith('Proxy [')).toBe(true);
    expect(calls).toEqual([]);
  });

  test('an Error with a throwing message getter still answers a string', () => {
    const thrown = Object.defineProperty(new Error(), 'message', { get() { throw new Error('getter failed'); } });
    expect(typeof errorText(thrown)).toBe('string');
  });
});
