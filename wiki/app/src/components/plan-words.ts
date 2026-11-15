
/** The words the catalogue and the preparation panel use for a kind's plan: its deterministic plugins and the agent's fields. */
import type { FillPlanKind, FillPlanView } from './command.js';

export interface KindFilledBy {
  /** The deterministic plugins that fill a field of the kind, in plan order. */
  readonly plugins: readonly string[];
  /** The fields the agent fills, alone or beside a deterministic producer. */
  readonly agent: readonly string[];
}

/** What one kind of a plan is filled by. */
export function filledBy(planKind: FillPlanKind | undefined): KindFilledBy {
  if (planKind === undefined) return { plugins: [], agent: [] };
  const agentFields = new Set(planKind.agentFields);
  const plugins: string[] = [];
  for (const field of planKind.fields) {
    if (agentFields.has(field.field)) continue;
    for (const producer of field.producers) if (!plugins.includes(producer)) plugins.push(producer);
  }
  return { plugins, agent: [...planKind.agentFields] };
}

/** The field's reader-facing name: its declaration's label first, never the key itself. */
export function fieldLabel(plan: FillPlanView | undefined, kind: string, field: string, language: string): string {
  const labels = planKindOf(plan, kind)?.fields.find((one) => one.field === field)?.labels;
  const declared = labels?.[language] ?? labels?.['en'];
  if (declared !== undefined && declared !== '') return declared;
  const words = field.replaceAll('_', ' ').replace(/([a-z])([A-Z])/gu, '$1 $2').trim();
  return words === '' ? field : words.charAt(0).toLocaleUpperCase(language) + words.slice(1);
}

/** The plan kind by its id, or undefined when the plan does not hold it. */
export function planKindOf(plan: FillPlanView | undefined, kind: string): FillPlanKind | undefined {
  return plan?.kinds.find((one) => one.kind === kind);
}
