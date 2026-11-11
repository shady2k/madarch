/**
 * The starter set is madarch's copy, written into a product once by `madarch new`
 * and never read by the engine afterwards (decision 0034, item 14; the owner,
 * 2026-11-10: "our engine knows no entities"). After the copy, the product's own
 * repository is the only catalogue, set of templates and set of loop kinds the
 * engine reads: a product that lacks one shows a problem naming the file, never the
 * engine's copy.
 *
 * So `src/knowledge/starter-catalog.ts` and `src/knowledge/seed.ts` — the catalogue,
 * the templates, the loop kinds and the workflow a product is made with — are
 * imported by `src/product/draft.ts` (the module `madarch new` runs) and by the data
 * modules themselves, and by no other module of the engine. The starter set's own
 * checks and shots under `scripts/` copy it into a temporary product; they are not
 * the engine and the rule does not govern them.
 */
import { importStatementsOf } from './imports.js';
import { moduleSet, resolveModuleSpecifier, type ModuleSet } from './sources.js';
import { orderedViolations, type ArchitectureViolation } from './violation.js';

/** The starter set's data modules: the catalogue and the files a product is made with. */
const STARTER_DATA = ['src/knowledge/starter-catalog.ts', 'src/knowledge/seed.ts'] as const;

/** The one module of the engine that copies the starter set into a product: `madarch new`. */
const COPYING_MODULE = 'src/product/draft.ts';

/**
 * Every module of `src/` that imports the starter set's data without being the copy
 * `madarch new` makes, with the starter module it imports.
 */
export function starterDataViolations(root: string, modules: ModuleSet = moduleSet(root)): ArchitectureViolation[] {
  const violations: ArchitectureViolation[] = [];
  for (const file of modules.modules) {
    if (!file.startsWith('src/')) continue;
    if (file === COPYING_MODULE || (STARTER_DATA as readonly string[]).includes(file)) continue;
    for (const statement of importStatementsOf(root, file)) {
      const target = resolveModuleSpecifier(modules, file, statement.specifier);
      if (target === null || !(STARTER_DATA as readonly string[]).includes(target)) continue;
      violations.push({ rule: 'starter-data-when-copying', file, line: statement.line, symbol: target });
    }
  }
  return orderedViolations(violations);
}
