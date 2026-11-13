import { CATALOG_FILES } from '../src/knowledge/catalog-assets.js';
import { CATALOG_GROUPS } from '../src/knowledge/catalog-starter.js';
import { parseCatalogYaml } from '../src/product/manifest/kinds.js';
import type { RuleSpec } from '../src/problems/types.js';

export const GROUPS = CATALOG_GROUPS;
const metadata = parseCatalogYaml(CATALOG_FILES['catalog.yaml']!) as { problems: { rules: Record<string, Omit<RuleSpec, 'id'>> } };
export const STARTER_PROBLEM_RULES: readonly RuleSpec[] = Object.entries(metadata.problems.rules)
  .map(([id, rule]) => ({ id, ...rule }));
