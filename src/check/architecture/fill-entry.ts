/**
 * One entry point per job (decision 0033, items 1 and 4): a fill is started by the
 * orchestrator host and by nothing else.
 *
 * Read from the code, the one surface beside the orchestrator is the extract
 * driver's `fillGraph` (the whole-tree reader the contracts stages still fill
 * through, and decision 0033 deletes once they are merged). The knowledge fill
 * worker's own loop and the product CLI's `startFill` are deleted: the wiki's fill
 * and `madarch fill` start the fill through the orchestrator host. The stage registry's runner is the orchestrator's
 * `driveRun`, which plans a registry's stages and drives them to their end; the host
 * that owns an orchestrator for a process is src/fill/orchestrator-host.ts, and
 * every other module that starts one of these is a second entry point for a job that
 * has one.
 *
 * The rule is about names, not about modules: src/extract/driver/index.ts also
 * exports a producer's name that a page reads, and that is not a fill entry. So the
 * rule reads what each module imports from a runner module and reports the names
 * that are runners.
 */
import { importStatementsOf } from './imports.js';
import { moduleSet, resolveModuleSpecifier, type ModuleSet } from './sources.js';
import { orderedViolations, type ArchitectureViolation } from './violation.js';

/** A runner module and the names in it that start a fill. */
interface FillRunner {
  readonly module: string;
  readonly runners: readonly string[];
}

/** The modules whose exported names start a fill, and the names. */
const FILL_RUNNERS: readonly FillRunner[] = [
  { module: 'src/extract/driver/index.ts', runners: ['fillGraph'] },
  { module: 'src/fill/orchestrator.ts', runners: ['driveRun'] },
];

/** The one module that starts a fill: the orchestrator host of a process. */
const FILL_HOST = 'src/fill/orchestrator-host.ts';

/** The symbol an entry carries when a module takes a runner module as a whole. */
const WHOLE_RUNNER_MODULE = '*';

/**
 * Every module of the rules' scope that imports a fill runner from beside the
 * orchestrator host, one violation per runner name (or one per runner module, where
 * it is taken as a whole).
 */
export function fillEntryViolations(root: string, modules: ModuleSet = moduleSet(root)): ArchitectureViolation[] {
  const violations: ArchitectureViolation[] = [];
  for (const file of modules.modules) {
    if (file === FILL_HOST) continue;
    for (const statement of importStatementsOf(root, file)) {
      const target = resolveModuleSpecifier(modules, file, statement.specifier);
      if (target === null) continue;
      const runner = FILL_RUNNERS.find((candidate) => candidate.module === target);
      if (runner === undefined) continue;
      const names = statement.wholeModule ? [WHOLE_RUNNER_MODULE] : statement.names.filter((name) => runner.runners.includes(name));
      for (const name of names) violations.push({ rule: 'one-fill-entry', file, line: statement.line, symbol: `${target}:${name}` });
    }
  }
  return unique(orderedViolations(violations));
}

/** The same violation found twice in one module is one violation, on the first line it is written on. */
function unique(violations: readonly ArchitectureViolation[]): ArchitectureViolation[] {
  const byIdentity = new Map<string, ArchitectureViolation>();
  for (const violation of violations) {
    const identity = `${violation.file}\u0000${violation.symbol ?? ''}`;
    const held = byIdentity.get(identity);
    if (held === undefined || violation.line < held.line) byIdentity.set(identity, violation);
  }
  return orderedViolations([...byIdentity.values()]);
}
