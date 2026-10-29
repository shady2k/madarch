/**
 * Writes JSON exactly as `JSON.stringify(value, null, 2)` does, but in chunks,
 * so a 232 MB accumulated extraction is never one string in memory. The
 * indentation, key order, escaping and omission of undefined object members
 * are the built-in serializer's; only the allocation changes.
 */
import { closeSync, openSync, writeSync } from 'node:fs';

const jsonIndent = (level: number): string => ' '.repeat(level * 2);

export function writeJsonFile(path: string, value: unknown): void {
  const fd = openSync(path, 'w');
  try {
    writeJsonValue(fd, value);
    writeSync(fd, '\n');
  } finally {
    closeSync(fd);
  }
}

export function writeJsonValue(fd: number, value: unknown, pretty = true): void {
  let buffer = '';
  const emit = (text: string): void => {
    buffer += text;
    if (buffer.length >= 64 * 1024) {
      writeSync(fd, buffer);
      buffer = '';
    }
  };
  const put = (item: unknown, level: number, inArray = false): void => {
    if (item === null || typeof item === 'boolean' || typeof item === 'number' || typeof item === 'string') {
      emit(JSON.stringify(item));
      return;
    }
    if (typeof item === 'bigint') throw new TypeError('Do not know how to serialize a BigInt');
    if (typeof item !== 'object') {
      // An array element has no key to omit: undefined, a function or a symbol
      // is written as null, and a sparse hole reads as undefined. Object
      // members with those values are filtered out above (madarch-alzf review,
      // RARE: the audit serializer).
      if (inArray || !pretty) emit('null');
      return;
    }
    if (Array.isArray(item)) {
      if (item.length === 0) {
        emit('[]');
        return;
      }
      emit(pretty ? '[\n' : '[');
      for (let index = 0; index < item.length; index += 1) {
        if (pretty) emit(jsonIndent(level + 1));
        put(item[index], level + 1, true);
        emit(index + 1 < item.length ? (pretty ? ',\n' : ',') : (pretty ? '\n' : ''));
      }
      emit(pretty ? jsonIndent(level) + ']' : ']');
      return;
    }
    const record = item as Record<string, unknown>;
    const keys = Object.keys(record).filter((key) => record[key] !== undefined && typeof record[key] !== 'function' && typeof record[key] !== 'symbol');
    if (keys.length === 0) {
      emit('{}');
      return;
    }
    emit(pretty ? '{\n' : '{');
    for (let index = 0; index < keys.length; index += 1) {
      emit((pretty ? jsonIndent(level + 1) : '') + JSON.stringify(keys[index]!) + (pretty ? ': ' : ':'));
      put(record[keys[index]!], level + 1);
      emit(index + 1 < keys.length ? (pretty ? ',\n' : ',') : (pretty ? '\n' : ''));
    }
    emit(pretty ? jsonIndent(level) + '}' : '}');
  };
  put(value, 0);
  if (buffer.length > 0) writeSync(fd, buffer);
}
