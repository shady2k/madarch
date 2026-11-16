/** A declared semantic role maps product vocabulary into evidence support proof. */
import type { SemanticBinding } from '../product/manifest/kinds.js';
import type { EvidenceSupportRoles } from './evidence-read.js';

export function evidenceSupportRoles(bindings: ReadonlyMap<string, SemanticBinding> | undefined): EvidenceSupportRoles | undefined {
  const about = bindings?.get('evidence-support')?.edges?.['about'];
  return about === undefined ? undefined : { edgeKind: about.kind, direction: about.direction };
}
