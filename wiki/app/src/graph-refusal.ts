/** Coded graph refusals use the reader's language; uncoded server messages keep their existing fallback. */
import { i18n } from './i18n.js';

export function graphRefusalMessage(value: unknown): string | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const body = value as Record<string, unknown>;
  if (body['code'] !== 'SCHEMA_INVALID' || typeof body['path'] !== 'string' || typeof body.expected !== 'string' || !Object.hasOwn(body, 'actual') || body['retryable'] !== false) return undefined;
  return i18n.t('graphRefusal.schemaInvalid', { path: body['path'], expected: body.expected, actual: JSON.stringify(body.actual) });
}
