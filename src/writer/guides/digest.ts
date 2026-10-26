import { createHash } from 'node:crypto';
import type { GuideContext, GuideDocument, GuideStep } from './model.js';
import { byCodePoint } from '../../model/order.js';

/** Canonical plain data; object keys never depend on insertion order or locale. */
export function guideCanonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(guideCanonical).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort(byCodePoint).map((key) => `${JSON.stringify(key)}:${guideCanonical(object[key])}`).join(',')}}`;
}
export function guideDigest(value: unknown): string {
  return createHash('sha256').update(guideCanonical(value)).digest('hex');
}
export function sameGuideContext(left: GuideContext, right: GuideContext): boolean {
  const normalized = (context: GuideContext): unknown => ({ ...context, repositories: [...context.repositories].sort((a, b) => byCodePoint(a.name, b.name)) });
  return guideCanonical(normalized(left)) === guideCanonical(normalized(right));
}
/** Bind every input that can change the meaning of a command, not only its displayed text. */
export function guideStepDigest(guide: GuideDocument, procedure: string, step: GuideStep): string {
  return guideDigest({ guide: guide.id, procedure, context: guide.context, unitVersion: guide.unitVersion,
    inputDigest: guide.inputDigest, step });
}
