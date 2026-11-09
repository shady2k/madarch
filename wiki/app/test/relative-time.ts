/** The relative-time format the i18n test reads, kept test-side: no production page formats a timestamp this way. */
import { i18n, normalizeLanguage } from '../src/i18n.js';

export function relativeTime(isoTime: string, language: string = i18n.resolvedLanguage ?? 'en', now = Date.now()): string {
  const timestamp = Date.parse(isoTime);
  if (!Number.isFinite(timestamp)) return '';
  const elapsedSeconds = (timestamp - now) / 1000;
  const absolute = Math.abs(elapsedSeconds);
  let divisor: number;
  let unit: Intl.RelativeTimeFormatUnit;
  if (absolute < 60) [divisor, unit] = [1, 'second'];
  else if (absolute < 60 * 60) [divisor, unit] = [60, 'minute'];
  else if (absolute < 24 * 60 * 60) [divisor, unit] = [60 * 60, 'hour'];
  else if (absolute < 30 * 24 * 60 * 60) [divisor, unit] = [24 * 60 * 60, 'day'];
  else if (absolute < 365 * 24 * 60 * 60) [divisor, unit] = [30 * 24 * 60 * 60, 'month'];
  else [divisor, unit] = [365 * 24 * 60 * 60, 'year'];
  return new Intl.RelativeTimeFormat(normalizeLanguage(language), { numeric: 'auto', style: 'short' })
    .format(Math.round(elapsedSeconds / divisor), unit);
}
