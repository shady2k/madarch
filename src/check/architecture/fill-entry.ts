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
import { moduleNamesOf } from './imports.js';
import { moduleSet, resolveModuleSpecifier, type ModuleSet } from './sources.js';
import { posix } from 'node:path';
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
  // madarch-8bdc.2.5, item 6: a fill is started through `runFill` and by nothing else. These two are
  // what `runFill` builds on, so a module that reaches for either one is a second wiring or a second
  // runner — the same defect as a second call of the host.
  { module: 'src/fill/orchestrator-host.ts', runners: ['createFillOrchestratorService'] },
  { module: 'src/product/fill-stages.ts', runners: ['createStagesFill'] },
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
    // The host and the one runner may name a runner: everyone else goes through `runFill`.
    if (file === FILL_HOST || file === 'src/fill/run.ts') continue;
    const held = moduleNamesOf(root, file);
    for (const statement of held.imports) {
      const target = resolveModuleSpecifier(modules, file, statement.specifier);
      if (target === null) continue;
      const runner = FILL_RUNNERS.find((candidate) => candidate.module === target);
      if (runner === undefined) continue;
      const names = statement.wholeModule ? [WHOLE_RUNNER_MODULE] : statement.names.filter((name) => runner.runners.includes(name));
      for (const name of names) violations.push({ rule: 'one-fill-entry', file, line: statement.line, symbol: `${target}:${name}` });
    }
    // A call handed a module's name as a string literal — a local `load(path)` that imports what it names — takes
    // that module as a whole: the parse says which module the literal names, and a runner's name is a second entry.
    for (const call of held.literalCalls) {
      const target = moduleNamed(modules, file, call.value);
      if (target === null) continue;
      if (!FILL_RUNNERS.some((candidate) => candidate.module === target)) continue;
      violations.push({ rule: 'one-fill-entry', file, line: call.line, symbol: `${target}:${WHOLE_RUNNER_MODULE}` });
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

/**
 * The module one string literal names, as a path from the repository root: a relative specifier a module writes
 * (`'./fill-stages.js'`), or a path from the root itself (`'src/product/fill-stages.ts'`) — which is the form a
 * `load(path)` helper takes. Anything else names no module of this repository.
 */
function moduleNamed(modules: ModuleSet, file: string, value: string): string | null {
  const relative = resolveModuleSpecifier(modules, file, value);
  if (relative !== null) return relative;
  if (value.startsWith('.') || value.startsWith('/')) return null;
  const named = posix.normalize(value);
  if (named === '..' || named.startsWith('../')) return null;
  return modules.known.has(named) ? named : null;
}
