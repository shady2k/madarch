/**
 * The manifest publication's binding is taken in one module (madarch-64o5.151): `startupBinding(…, 'manifest')` and
 * `bindStartupWriter(…, 'manifest')` name the source whose capability states the catalogue, and the one writer refuses
 * every other source a kind of the manifest's own capability. A module that took that binding would be a second
 * publication of the product's declarations — free to state, retire and re-state what every other source fills from —
 * so the call stands in src/graph/manifest-publication.ts and nowhere else.
 *
 * The rule is about names: a producer named by a string literal — `'manifest'` or a template with no substitution — is
 * what the parse says, and a producer carried in a variable is not a name this check can read; the module that would
 * hide it there is the reader's to refuse. A module that brings the binding in under another name calls it by that
 * name, so the imports are read as well: `import { startupBinding as bind }` makes `bind(tx, {}, 'manifest')` the
 * publication's call.
 */
import { moduleNamesOf } from './imports.js';
import { moduleSet, type ModuleSet } from './sources.js';
import { orderedViolations, type ArchitectureViolation } from './violation.js';

/** The one module that takes the manifest publication's binding. */
export const MANIFEST_BINDING_MODULE = 'src/graph/manifest-publication.ts';

/** The names a module calls to take a source binding. */
export const BINDING_NAMES = ['startupBinding', 'bindStartupWriter'] as const;

/** The producer that names the manifest publication. */
export const MANIFEST_PRODUCER = 'manifest';

/** Every module other than the publication that takes a binding for the manifest producer, with its line. */
export function manifestBindingViolations(root: string, modules: ModuleSet = moduleSet(root)): ArchitectureViolation[] {
  const violations: ArchitectureViolation[] = [];
  for (const file of modules.modules) {
    if (file === MANIFEST_BINDING_MODULE) continue;
    const names = moduleNamesOf(root, file);
    // The names this module calls the binding by: the imported name, and every local alias the statement binds it to.
    const local = new Map<string, string>();
    for (const statement of names.imports) for (const binding of statement.bindings) {
      if ((BINDING_NAMES as readonly string[]).includes(binding.imported)) local.set(binding.local, binding.imported);
    }
    for (const call of names.calls) {
      const symbol = local.get(call.name) ?? ((BINDING_NAMES as readonly string[]).includes(call.name) ? call.name : undefined);
      if (symbol === undefined || !call.literals.includes(MANIFEST_PRODUCER)) continue;
      violations.push({ rule: 'one-manifest-binding', file, line: call.line, symbol });
    }
  }
  return orderedViolations(violations);
}
