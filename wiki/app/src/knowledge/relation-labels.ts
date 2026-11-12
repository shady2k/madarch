import { relationLabel as labelInLanguage } from '../../../../src/knowledge/relation-labels.js';

/** Known relation IDs use the interface vocabulary; custom names keep their established readable spelling. */
export function relationLabel(relation: string, t: (key: string, options?: Record<string, unknown>) => string): string {
  return t(`knowledge.relationLabels.${relation}`, { defaultValue: labelInLanguage(relation, 'en') });
}
