import { planManifestFill } from '../plugin/fill-declarations.js';
import type { KindsManifest } from '../product/manifest/kinds.js';

/** Preview exactly the requested declaration plan without starting an agent. */
export function fillRequirementsOf(manifest: KindsManifest, folder: string): (requested: readonly string[]) => { requiresAgent?: true; fillPlanRefusal?: string } {
  const previews = new Map<string, { requiresAgent?: true; fillPlanRefusal?: string }>();
  return (requested) => {
    const key = JSON.stringify([...new Set(requested)].sort());
    const cached = previews.get(key);
    if (cached !== undefined) return cached;
    let result: { requiresAgent?: true; fillPlanRefusal?: string };
    try { result = planManifestFill(manifest, folder, requested).requiresAgent ? { requiresAgent: true } : {}; }
    catch (error) { result = { fillPlanRefusal: error instanceof Error ? error.message : String(error) }; }
    previews.set(key, result);
    return result;
  };
}
