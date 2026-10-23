/**
 * Rows of a database over a pipe as JSON: the three kinds of value JSON cannot
 * carry are tagged and read back as what they were (a big integer, a date, bytes).
 */
const TAG = '$madarch';

export function encodeWire(value: unknown): string {
  return JSON.stringify(value, function (this: unknown, key: string, held: unknown) {
    // `Date.prototype.toJSON` has already turned a date into a text by the time the replacer sees it.
    const original = (this as Record<string, unknown>)[key];
    if (original instanceof Date) return { [TAG]: 'date', value: original.toISOString() };
    if (typeof held === 'bigint') return { [TAG]: 'bigint', value: held.toString() };
    if (held instanceof Uint8Array) return { [TAG]: 'bytes', value: Buffer.from(held).toString('base64') };
    return held;
  });
}

export function decodeWire<T>(text: string): T {
  return JSON.parse(text, (_key, held: unknown) => {
    if (held !== null && typeof held === 'object' && TAG in held) {
      const tagged = held as { [TAG]: string; value: string };
      if (tagged[TAG] === 'bigint') return BigInt(tagged.value);
      if (tagged[TAG] === 'date') return new Date(tagged.value);
      if (tagged[TAG] === 'bytes') return new Uint8Array(Buffer.from(tagged.value, 'base64'));
    }
    return held;
  }) as T;
}
