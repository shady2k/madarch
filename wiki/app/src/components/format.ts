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
  if (Array.isArray(value)) return value.map((one) => formatValue(one, 'text', language)).join(', ');
  if (typeof value === 'boolean') return value ? '✓' : '—';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/** The date a timestamp reads as, or nothing when the value is not one. */
export function dateOf(value: unknown, language: string): string | undefined {
  if (typeof value !== 'string' || value === '') return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : new Intl.DateTimeFormat(language, { dateStyle: 'medium' }).format(date);
}

/** The short form of a commit hash: the seven characters Git itself shows. */
export function shortHash(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return /^[0-9a-f]{7,64}$/u.test(trimmed) ? trimmed.slice(0, 7) : undefined;
}

/** The name a link is shown by: the address's host, or the address itself when it has none. */
export function hostOf(value: string): string {
  try {
    const url = new URL(value);
    return url.host === '' ? value : url.host;
  } catch {
    return value;
  }
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

/** A span of work as a person reads it: "3 min 34 sec", "1 hr 02 min", "12 sec" (madarch-64o5.83). */
export function durationWords(ms: number, language: string): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const unit = (value: number, name: 'hour' | 'minute' | 'second', digits = 1): string =>
    new Intl.NumberFormat(language, { style: 'unit', unit: name, unitDisplay: 'short', minimumIntegerDigits: digits }).format(value);
  if (hours > 0) return `${unit(hours, 'hour')} ${unit(minutes, 'minute', 2)}`;
  if (minutes > 0) return `${unit(minutes, 'minute')} ${unit(seconds, 'second')}`;
  return unit(seconds, 'second');
}

/**
 * A moment as a reader in a language reads it: the month's name and a 24-hour clock where the language uses one, never a
 * bare numeric date that means two things in two places (madarch-64o5.83). The language is the page's, so Russian keeps
 * Russian months and English its own.
 */
export function momentWords(iso: string, language: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  return new Intl.DateTimeFormat(language, { dateStyle: 'medium', timeStyle: 'short' }).format(at);
}
