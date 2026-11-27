/** A declared semantic role maps product vocabulary into evidence support proof. */
import type { SemanticBinding } from '../product/manifest/kinds.js';
import type { EvidenceSupportRoles } from './evidence-read.js';

export function evidenceSupportRoles(bindings: ReadonlyMap<string, SemanticBinding> | undefined): (EvidenceSupportRoles & { readonly kind: string }) | undefined {
  const binding = bindings?.get('evidence-support');
  const about = binding?.edges?.['about'];
  if (binding === undefined || about === undefined) return undefined;
  return { kind: binding.kind, edgeKind: about.kind, direction: about.direction };
}
