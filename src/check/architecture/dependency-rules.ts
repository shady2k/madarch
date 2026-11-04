/**
 * The dependency rules of .dependency-cruiser.mjs, run over the import graph.
 *
 * The rules are the repository's own committed configuration — the same file a
 * reader opens to learn what is enforced — and this module runs them through
 * dependency-cruiser's own API rather than its command line, so the violations come
 * back as data with the rule that found them.
 *
 * dependency-cruiser reports which module imported which, and not the line the
 * import is written on; the line comes from the module's own syntax tree
 * (imports.ts), matched by the specifier as written, which dependency-cruiser keeps
 * in the violation as `unresolvedTo`.
 */
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { cruise, type ICruiseOptions, type IForbiddenRuleType } from 'dependency-cruiser';
import { importStatementsOf } from './imports.js';
import { moduleSet, repositoryRoot, type ModuleSet } from './sources.js';
import { orderedViolations, type ArchitectureRule, type ArchitectureViolation } from './violation.js';

/** The committed dependency rules, as dependency-cruiser's configuration file holds them. */
interface DependencyRuleSet {
  readonly forbidden: readonly IForbiddenRuleType[];
  readonly options: ICruiseOptions;
}

/** The rules this check knows how to name. A rule of another name is a defect of the configuration. */
const RULE_NAMES: readonly ArchitectureRule[] = ['graph-single-writer', 'sql-only-in-storage-layer'];

/** Reads the committed configuration of the repository this check belongs to. */
async function readDependencyRuleSet(): Promise<DependencyRuleSet> {
  const file = resolve(repositoryRoot(), '.dependency-cruiser.mjs');
  const loaded = (await import(pathToFileURL(file).href)) as { readonly default?: DependencyRuleSet };
  const config = loaded.default;
  if (config === undefined || !Array.isArray(config.forbidden) || config.options === undefined) {
    throw new Error(`${file}:1: the dependency rules are a default export with forbidden rules and options, and this file has neither`);
  }
  for (const rule of config.forbidden) {
    if (rule.name === undefined || !RULE_NAMES.includes(rule.name as ArchitectureRule)) {
      throw new Error(`${file}:1: the rule ${JSON.stringify(rule.name)} is not one of ${RULE_NAMES.join(', ')}: the check names every rule it runs`);
    }
  }
  return config;
}

/**
 * The violations of the dependency rules over the modules under `root`, one per
 * imported module the rule forbids, located by the line of the import of it.
 */
export async function dependencyRuleViolations(
  root: string,
  rules: readonly ArchitectureRule[] = RULE_NAMES,
  modules: ModuleSet = moduleSet(root),
): Promise<ArchitectureViolation[]> {
  const config = await readDependencyRuleSet();
  const forbidden = config.forbidden.filter((rule) => rules.includes(rule.name as ArchitectureRule));
  if (forbidden.length === 0) return [];
  for (const rule of forbidden) {
    if (rule.severity !== 'error') {
      throw new Error(`.dependency-cruiser.mjs:1: the rule ${JSON.stringify(rule.name)} has the severity ${JSON.stringify(rule.severity)}: a rule this check runs fails the build, so it is an error`);
    }
  }
  const roots = [...new Set(modules.modules.map((file) => file.slice(0, file.indexOf('/'))))].filter((folder) => folder.length > 0);
  const result = await cruise(roots, {
    ...config.options,
    // dependency-cruiser runs no rule at all unless it is asked to validate: the
    // command line turns it on and the API does not.
    validate: true,
    baseDir: root,
    ruleSet: { forbidden },
  });
  const output = result.output;
  if (typeof output === 'string') {
    throw new Error(`${root}:1: dependency-cruiser answered ${JSON.stringify(output.slice(0, 80))} rather than a report; the check reads its report as data`);
  }
  const violations: ArchitectureViolation[] = [];
  const statements = new Map<string, ReturnType<typeof importStatementsOf>>();
  for (const violation of output.summary.violations) {
    const rule = violation.rule.name as ArchitectureRule;
    const file = toRepositoryPath(root, violation.from);
    const target = toRepositoryPath(root, violation.to);
    let held = statements.get(file);
    if (held === undefined) {
      held = importStatementsOf(root, file);
      statements.set(file, held);
    }
    const written = violation.unresolvedTo ?? null;
    const statement = held.find((candidate) => candidate.specifier === written);
    violations.push({ rule, file, line: statement?.line ?? 1, symbol: target });
  }
  return orderedViolations(violations);
}

/**
 * A path as the rules speak it: from the repository root. dependency-cruiser reports
 * the paths it was given, and a root given as an absolute path is reported as one.
 */
function toRepositoryPath(root: string, path: string): string {
  const absoluteRoot = resolve(root);
  if (path.startsWith(absoluteRoot)) {
    const cut = path.slice(absoluteRoot.length).replace(/^[/\\]/, '');
    return cut.split('\\').join('/');
  }
  return path.split('\\').join('/');
}
