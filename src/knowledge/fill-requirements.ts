import { planManifestFill } from '../plugin/fill-declarations.js';
import type { KindsManifest } from '../product/manifest/kinds.js';

import { prerequisiteClosure } from './fill-selection.js';

/** Preview prerequisite-expanded plans once per catalogue, without starting an agent. */
export function fillRequirementsOf(manifest: KindsManifest, folder: string): (requested: readonly string[]) => { requiresAgent?: true; fillPlanRefusal?: string } {
  try {
    const plan = planManifestFill(manifest, folder);
    const kinds = [...manifest.kinds.values()].map((kind) => ({ kind: kind.name, derivesFrom: kind.derivesFrom }));
    const agentOutputs = new Set([...(manifest.plugins?.values() ?? [])]
      .filter((plugin) => plugin.declaration?.agent !== undefined && plan.order.includes(plugin.declaration.name))
      .flatMap((plugin) => [...(plan.outputs.get(plugin.declaration!.name)?.keys() ?? [])]));
    return (requested) => {
      const selected = prerequisiteClosure(kinds, requested);
      for (const kind of selected) if (![...plan.outputs.values()].some((outputs) => outputs.has(kind))) {
        const declaration = manifest.kinds.get(kind)!;
        return { fillPlanRefusal: `${manifest.file}:${declaration.line}: selected kind ${kind} has no enabled producer; enable its producer` };
      }
      return selected.some((kind) => agentOutputs.has(kind)) ? { requiresAgent: true } : {};
    };
  } catch (error) {
    const fillPlanRefusal = error instanceof Error ? error.message : String(error);
    return () => ({ fillPlanRefusal });
  }
}

