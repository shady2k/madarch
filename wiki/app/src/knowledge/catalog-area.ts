/**
 * The catalogue's section for one kind (madarch-47vw.5's answer trim): the kind's subgroup names a group, and the group
 * names the area above it. The answer no longer repeats `area` on every row; a row that still carries one (an older
 * answer, a fixture) keeps it.
 */
import type { CatalogKindView, GroupSummary } from './types.js';

export function areaOf(groups: readonly GroupSummary[], kind: CatalogKindView): string {
  if (kind.area !== undefined) return kind.area;
  const group = groups.find((held) => held.group === kind.subgroup);
  return group?.parent ?? kind.subgroup;
}
