/**
 * The graph's kind a unit publication names: a unit id is `<stage>/<plugin>:<kind>`, and a scoped unit adds
 * `#<hash>`, `@<scope>` or `:<scope>` after the kind. The stage prefix and every scope are dropped; the kind is the
 * part after the plugin's colon and before the scope, which is what the navigation and a page address use.
 */
export function kindOfUnit(unitId: string): string | undefined {
  const afterStage = unitId.includes('/') ? unitId.slice(unitId.indexOf('/') + 1) : unitId;
  const unit = afterStage.split(/[#@]/u)[0] ?? afterStage;
  const colon = unit.indexOf(':');
  const kind = colon < 0 ? unit : unit.slice(colon + 1);
  const base = kind.split(':')[0] ?? '';
  return base === '' ? undefined : base;
}
