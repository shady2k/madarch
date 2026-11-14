/** How a value the graph answered is written for a reader: a number, a date, bytes, a link or plain text. */
import { valueAt } from '../../../../src/page-contract/index.js';

const BYTE_UNITS = ['B', 'kB', 'MB', 'GB', 'TB'];

export function formatValue(value: unknown, format: string, language: string): string {
  if (value === null || value === undefined) return '';
  if (format === 'number' && typeof value === 'number') return new Intl.NumberFormat(language).format(value);
  if (format === 'number' && typeof value === 'string' && /^-?\d+(?:\.\d+)?$/u.test(value)) return new Intl.NumberFormat(language).format(Number(value));
  if (format === 'bytes' && (typeof value === 'number' || typeof value === 'string')) {
    let bytes = Number(value);
    if (!Number.isFinite(bytes)) return String(value);
    let unit = 0;
    while (bytes >= 1000 && unit < BYTE_UNITS.length - 1) {
      bytes /= 1000;
      unit += 1;
    }
    return `${bytes.toFixed(unit === 0 ? 0 : 1)} ${BYTE_UNITS[unit]!}`;
  }
  if (format === 'date') {
    const date = new Date(String(value));
    return Number.isNaN(date.getTime()) ? String(value) : new Intl.DateTimeFormat(language, { dateStyle: 'medium' }).format(date);
  }
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/** The label a text states in the reader's language, else English, else the value itself. */
export function localized(value: unknown, language: string): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const held = value as Record<string, unknown>;
  const wanted = held[language] ?? held['en'] ?? Object.values(held).find((one) => typeof one === 'string');
  return typeof wanted === 'string' ? wanted : undefined;
}

/** The value at a dot path, as the section's parameters name it. */
export function at(data: unknown, path: unknown): unknown {
  return valueAt(data, typeof path === 'string' ? path : '');
}
