import { createHash } from 'node:crypto';
import { describe, expect, test } from 'bun:test';
import { canonicalJsonDigest } from '../src/model/canonical.js';

/**
 * The canonical texts the digests below are checked against, written by
 * hand from the frozen rule (change registry-integrity, 2026-10-01): keys
 * sorted by code point, no insignificant whitespace, numbers as
 * `JSON.stringify` writes them. No expected digest is copied from the
 * function under test; each is hashed straight over the text's UTF-8 bytes.
 */
const CANONICAL_OF_MIXED =
  '{"a":{"list":[1,"two",null,true],"nested":1.5},"big":1e+21,"minus":-0.5,"z":1,"Ümlaut-ключ":"значение 🚚"}';
const CANONICAL_OF_NUMBER_KEYS = '{"10":"a","2":"b","a":2,"z":1}';

describe('canonicalJsonDigest', () => {
  test('is the SHA-256 of the canonical text: keys sorted by code point, no insignificant whitespace, UTF-8', () => {
    const value = {
      z: 1,
      a: { list: [1, 'two', null, true], nested: 1.5 },
      'Ümlaut-ключ': 'значение 🚚',
      big: 1e21,
      minus: -0.5,
    };
    // Code-point order puts "a" and "z" (ASCII) before "Ümlaut-ключ" (Ü is U+00DC).
    expect(canonicalJsonDigest(value)).toBe(createHash('sha256').update(CANONICAL_OF_MIXED, 'utf8').digest('hex'));
  });

  test('key order alone changes nothing: the same keys in another insertion order digest the same', () => {
    // Integer-like keys come first in numeric order whatever the insertion
    // order; the canonical order is the code-point one, "10" before "2".
    const value = { z: 1, 10: 'a', a: 2, 2: 'b' };
    const sameKeysOtherOrder = { a: 2, z: 1, 2: 'b', 10: 'a' };

    expect(canonicalJsonDigest(value)).toBe(createHash('sha256').update(CANONICAL_OF_NUMBER_KEYS, 'utf8').digest('hex'));
    expect(canonicalJsonDigest(sameKeysOtherOrder)).toBe(canonicalJsonDigest(value));
  });

  test('the same value parsed and re-serialized again digests the same', () => {
    const value = { b: [1, { c: 'three' }], a: 1 };
    const reparsed = JSON.parse(JSON.stringify(value)) as unknown;
    expect(canonicalJsonDigest(reparsed)).toBe(canonicalJsonDigest(value));
  });

  test('the same input gives the same digest again: no clock, no randomness', () => {
    const value = { a: [1, 2, 3], b: 'x' };
    expect(canonicalJsonDigest(value)).toBe(canonicalJsonDigest(value));
  });

  test('any meaningful change changes the digest: a value, a key, an order, a nesting', () => {
    const digest = canonicalJsonDigest({ a: 1, b: [1, 2], c: { d: 'x' } });
    expect(canonicalJsonDigest({ a: 2, b: [1, 2], c: { d: 'x' } })).not.toBe(digest); // a value
    expect(canonicalJsonDigest({ a: 1, b: [1, 2], e: { d: 'x' } })).not.toBe(digest); // a key
    expect(canonicalJsonDigest({ a: 1, b: [2, 1], c: { d: 'x' } })).not.toBe(digest); // an order
    expect(canonicalJsonDigest({ a: 1, b: [1, 2], c: { d: 'x', e: 0 } })).not.toBe(digest); // a nesting
    expect(canonicalJsonDigest({ a: '1', b: [1, 2], c: { d: 'x' } })).not.toBe(digest); // a type
  });

  test('a value that is not JSON is refused, naming where it sits', () => {
    expect(() => canonicalJsonDigest({ a: [1, undefined] })).toThrow('/a/1');
    expect(() => canonicalJsonDigest({ b: 1n })).toThrow('/b');
    expect(() => canonicalJsonDigest(undefined)).toThrow('the value itself');
  });

  test('a number JSON cannot hold is refused, never silently written as null', () => {
    expect(() => canonicalJsonDigest({ a: Number.NaN })).toThrow('/a');
    expect(() => canonicalJsonDigest({ a: Number.POSITIVE_INFINITY })).toThrow('/a');
  });
});
