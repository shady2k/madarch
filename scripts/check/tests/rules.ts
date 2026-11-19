/**
 * The five rules of `check:tests` (docs/decisions/0041-test-layers-and-suites.md). Each rule reads the
 * import graph of values and the modules' syntax trees — never a pattern read from
 * source text — and answers violations with the file, the line and the chain of
 * imports that leads to the forbidden module.
 *
 * The rules govern only the layer folders (`test/unit`, `test/integration`,
 * `test/e2e`, `test/measure`). A file stands in a layer only when its rule already
 * passes on it, so on a tree with no layer folder every rule finds nothing.
 */
import { importStatementsOf, type ImportStatement } from '../architecture/imports.js';
import { moduleSet, resolveModuleSpecifier, type ModuleSet } from '../architecture/sources.js';
import { byCodePoint } from '../../../src/model/order.js';
import type { ImportGraph } from './graph.js';
import { moduleSyntaxOf, type ArgumentSyntax, type CallSyntax, type ModuleSyntax, type PropertySyntax } from './syntax.js';
import type { TestViolation } from './violation.js';

const UNIT = 'test/unit';
const INTEGRATION = 'test/integration';
const E2E = 'test/e2e';
const MEASURE = 'test/measure';
const GIT_HELPER = 'test/support/git.ts';
const DEADLINE = 'test/support/deadline.ts';
const DRAFT = 'src/product/draft.ts';
const LAYER_FOLDERS = [UNIT, INTEGRATION, E2E, MEASURE] as const;

const INTEGRATION_LIMIT = 30_000;
const E2E_LIMIT = 120_000;
const SMALLEST_BOUND = 10_000;

/** What the rules read from one repository or fixture root, each file parsed and walked once. */
export interface RuleContext {
  readonly root: string;
  readonly graph: ImportGraph;
  /** The modules imports resolve against: the product, the scripts and the tests. */
  readonly modules: ModuleSet;
  /** Every module under one folder, in code point order. */
  modulesIn(folder: string): readonly string[];
  syntaxOf(file: string): ModuleSyntax;
  importsOf(file: string): readonly ImportStatement[];
}

/** Builds the shared reader three rules ask their questions of. */
export function createRuleContext(root: string, graph: ImportGraph): RuleContext {
  const moduleSets = new Map<string, readonly string[]>();
  const syntax = new Map<string, ModuleSyntax>();
  const imports = new Map<string, readonly ImportStatement[]>();
  const modules = moduleSet(root, ['src', 'test', 'scripts']);
  return {
    root,
    graph,
    modules,
    modulesIn(folder: string): readonly string[] {
      let found = moduleSets.get(folder);
      if (found === undefined) {
        found = moduleSet(root, [folder]).modules;
        moduleSets.set(folder, found);
      }
      return found;
    },
    syntaxOf(file: string): ModuleSyntax {
      let found = syntax.get(file);
      if (found === undefined) {
        found = moduleSyntaxOf(root, file);
        syntax.set(file, found);
      }
      return found;
    },
    importsOf(file: string): readonly ImportStatement[] {
      let found = imports.get(file);
      if (found === undefined) {
        found = importStatementsOf(root, file);
        imports.set(file, found);
      }
      return found;
    },
  };
}

/**
 * Rule 1, `test-unit-reach`: the values a unit file reaches hold no database, child
 * process, socket or browser, and no module of that closure starts a process or a
 * server.
 */
export function unitReachViolations(context: RuleContext): TestViolation[] {
  const violations: TestViolation[] = [];
  for (const start of context.modulesIn(UNIT)) {
    const { found, paths } = reachSearch(context.graph, start, (target) => unitForbidden(target) || databaseModules(context).has(target));
    for (const reach of found) {
      violations.push({
        rule: 'test-unit-reach',
        file: reach.file,
        line: reach.line,
        message: `${start} reaches ${reach.target} through ${reach.chain.join(' > ')}; the unit layer reaches no database, child process, socket or browser`,
      });
    }
    for (const file of [...paths.keys()].sort(byCodePoint)) {
      for (const member of membersMatching(context, file, ['process', 'server'])) {
        violations.push({
          rule: 'test-unit-reach',
          file,
          line: member.line,
          message: `${reachedFrom(start, paths, file)}, whose ${member.name} starts a process or a server; the unit layer reaches neither`,
        });
      }
    }
  }
  return violations;
}

/**
 * Rule 2, `test-integration-reach`: the test side of an integration file — the file
 * and the helpers of `test/support` it reaches — starts no process except git
 * through `test/support/git.ts`, asks `createTestDatabaseOwner` for no store of its
 * own, and reaches no browser.
 */
export function integrationReachViolations(context: RuleContext): TestViolation[] {
  const violations: TestViolation[] = [];
  for (const start of context.modulesIn(INTEGRATION)) {
    const { found, paths } = reachSearch(context.graph, start, (target) => target.startsWith('puppeteer'));
    for (const reach of found) {
      violations.push({
        rule: 'test-integration-reach',
        file: reach.file,
        line: reach.line,
        message: `${start} reaches ${reach.target} through ${reach.chain.join(' > ')}; the integration layer reaches no browser, and a browser walk is an end-to-end case`,
      });
    }
    const closure = closureOf(context.graph, start);
    for (const file of closure) {
      if (!isTestSide(file)) continue;
      for (const edge of context.graph.edges.get(file) ?? []) {
        if (!isChildProcess(edge.to)) continue;
        if (file === GIT_HELPER && (edge.specifier === 'node:child_process' || edge.specifier === 'child_process')) continue;
        violations.push({ rule: 'test-integration-reach', file, line: edge.line, message: `${reachedFrom(start, paths, file)}, which starts a process through ${edge.specifier}; the integration layer starts no process, and git runs through test/support/git.ts` });
      }
      for (const member of membersMatching(context, file, ['spawn'])) {
        if (file === GIT_HELPER) continue;
        violations.push({ rule: 'test-integration-reach', file, line: member.line, message: `${reachedFrom(start, paths, file)}, whose ${member.name} starts a process; the integration layer starts no process, and git runs through test/support/git.ts` });
      }
      if (file === GIT_HELPER) {
        const commands = new Set(['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync']);
        const processImports = context.importsOf(file).filter((statement) => !statement.typeOnly && isChildProcess(statement.specifier));
        for (const statement of processImports) {
          if (statement.reExport) violations.push({ rule: 'test-integration-reach', file, line: statement.line,
            message: `${reachedFrom(start, paths, file)}, which re-exports ${statement.specifier}; process bindings must stay inside ${GIT_HELPER}` });
        }
        const syntax = context.syntaxOf(file);
        for (const reference of syntax.references) {
          const binding = resolveBinding(context, file, reference.name);
          if (binding === null || !isChildProcess(binding.module)) continue;
          const call = reference.call;
          const callee = call?.directName == null ? null : resolveBinding(context, file, call.directName);
          const processCall = callee !== null && commands.has(callee.name.startsWith('default.') ? callee.name.slice(8) : callee.name);
          const command = call?.arguments[0]?.literal;
          if (processCall && command?.kind === 'string' && command.value === 'git') continue;
          violations.push({ rule: 'test-integration-reach', file, line: reference.line,
            message: `${reachedFrom(start, paths, file)}, whose ${reference.name} ${processCall ? `executes ${command?.kind === 'string' ? JSON.stringify(command.value) : 'a nonliteral command'}` : 'is used outside a call with the literal git'}; process bindings must stay inside ${GIT_HELPER}` });
        }
        for (const call of syntax.calls) {
          if (call.directName === null) continue;
          const binding = resolveBinding(context, file, call.directName);
          if (binding === null || ![...commands].some((command) => binding.name === `Bun.${command}`)) continue;
          const command = call.arguments[0]?.elements[0]?.literal;
          if (command?.kind === 'string' && command.value === 'git') continue;
          violations.push({ rule: 'test-integration-reach', file, line: call.line,
            message: `${reachedFrom(start, paths, file)}, whose ${call.directName} executes ${command?.kind === 'string' ? JSON.stringify(command.value) : 'a nonliteral command'}; only the git command is allowed through ${GIT_HELPER}` });
        }
      }
      for (const call of context.syntaxOf(file).calls) {
        const binding = resolveBinding(context, file, call.name);
        if (binding === null || binding.module === file || binding.name !== 'createTestDatabaseOwner' || !databaseModules(context).has(binding.module)) continue;
        const argument = call.arguments[0];
        const unreadable = argument !== undefined && !argument.readableObject;
        if (!unreadable && (argument === undefined || !hasProperty(argument, 'store'))) continue;
        violations.push({
          rule: 'test-integration-reach',
          file,
          line: call.line,
          message: `${reachedFrom(start, paths, file)}, which asks createTestDatabaseOwner ${unreadable ? "with options that are not a readable object literal" : "for a store of its own"}; an integration case uses the pass's database, and a store folder belongs to an end-to-end case`,
        });
      }
    }
  }
  return violations;
}

/**
 * Rule 3, `test-case-bound`: a case bound is named only with
 * `bound(ms, { measured, on, at })` from `test/support/deadline.ts`, at least three
 * times its measurement, at least ten seconds, at most the layer's limit, and never
 * in the unit layer; a bare third argument of `test()` is no bound.
 */
export function caseBoundViolations(context: RuleContext): TestViolation[] {
  const violations: TestViolation[] = [];
  for (const folder of LAYER_FOLDERS) {
    for (const file of context.modulesIn(folder)) {
      const { paths } = reachSearch(context.graph, file, () => false);
      for (const helper of paths.keys()) {
        if (helper !== file && !helper.startsWith('test/support/')) continue;
        for (const call of context.syntaxOf(helper).calls) {
          if (caseApi(context, helper, call.name) !== 'setDefaultTimeout') continue;
          violations.push({ rule: 'test-case-bound', file: helper, line: call.line,
            message: `${reachedFrom(file, paths, helper)} calls setDefaultTimeout through ${call.name}; a case time is set only through bound(ms, { measured, on, at })` });
        }
      }
      for (const call of context.syntaxOf(file).calls) {
        if (caseApi(context, file, call.name) === 'bound' || call.name === 'bound') violations.push(...boundCallViolations(context, file, call));
        else if (isCaseCall(context, file, call) && call.arguments.length >= 3) {
          const third = call.arguments[2]!;
          if (third.call === 'bound' || (third.call !== null && caseApi(context, file, third.call) === 'bound')) continue;
          violations.push({
            rule: 'test-case-bound',
            file,
            line: third.line,
            message: third.literal?.kind === 'number'
              ? `a bare number, ${group(third.literal.value)}, is the third argument of ${call.name}(), and names no bound(); a case bound is bound(ms, { measured, on, at })`
              : `the third argument of ${call.name}() is not bound(), and a case bound is named bound(ms, { measured, on, at })`,
          });
        }
      }
    }
  }
  return violations;
}

/** The defining module and expression behind a static local value path. */
interface Binding { readonly module: string; readonly name: string; readonly chain?: readonly string[] }

/** One resolver for local initializers, imports, namespaces and public re-exports. */
function resolveBinding(context: RuleContext, file: string, name: string, seen = new Set<string>(), caseCalls = false): Binding | null {
  const key = `${file}:${name}`;
  if (seen.has(key)) return null;
  seen.add(key);
  const [root, ...members] = name.split('.');
  if (root === undefined) return null;
  const suffix = members.length === 0 ? '' : `.${members.join('.')}`;
  const local = context.syntaxOf(file).bindings.get(root);
  if (local !== undefined) {
    const binding = resolveBinding(context, file, `${local.name}${suffix}`, seen, caseCalls);
    if (local.kind === 'alias') return binding;
    return caseCalls && binding?.module === 'bun:test' && ['test', 'it'].includes(binding.name.split('.')[0] ?? '') ? binding : null;
  }
  for (const statement of context.importsOf(file)) {
    if (statement.typeOnly || statement.reExport) continue;
    const binding = statement.bindings.find((binding) => binding.local === root);
    if (binding === undefined) continue;
    const target = resolveModuleSpecifier(context.modules, file, statement.specifier) ?? statement.specifier;
    const selected = binding.imported === '*' ? members.join('.') : `${binding.imported}${suffix}`;
    const resolved = resolveExport(context, target, selected, seen, caseCalls);
    return resolved === null ? null : { ...resolved, chain: [target, ...(resolved.chain ?? [])] };
  }
  return { module: file, name };
}

function resolveExport(context: RuleContext, module: string, name: string, seen: Set<string>, caseCalls = false): Binding | null {
  if (!context.modules.modules.includes(module)) return { module, name };
  const key = `export:${module}:${name}`;
  if (seen.has(key)) return null;
  seen.add(key);
  const [root, ...members] = name.split('.');
  const suffix = members.length === 0 ? '' : `.${members.join('.')}`;
  const local = context.syntaxOf(module).exports.get(root ?? '');
  if (local !== undefined) return resolveBinding(context, module, `${local}${suffix}`, seen, caseCalls);
  for (const statement of context.importsOf(module)) {
    if (statement.typeOnly || !statement.reExport) continue;
    const binding = statement.bindings.find((binding) => binding.local === root);
    if (!statement.wholeModule && binding === undefined) continue;
    const target = resolveModuleSpecifier(context.modules, module, statement.specifier) ?? statement.specifier;
    const resolved = resolveExport(context, target, binding === undefined ? name : `${binding.imported}${suffix}`, new Set(seen), caseCalls);
    if (resolved !== null) return { ...resolved, chain: [target, ...(resolved.chain ?? [])] };
  }
  return null;
}

function caseApi(context: RuleContext, file: string, name: string): string | null {
  const binding = resolveBinding(context, file, name, new Set(), true);
  if (binding?.module === 'bun:test') {
    const root = binding.name.split('.')[0];
    if (root === 'test' || root === 'it') return 'case';
    if (binding.name === 'setDefaultTimeout') return 'setDefaultTimeout';
  }
  if (binding?.module === DEADLINE && binding.name === 'bound') return 'bound';
  return null;
}

function isCaseCall(context: RuleContext, file: string, call: CallSyntax): boolean {
  return call.finalCall && caseApi(context, file, call.name) === 'case';
}

const databaseModuleSets = new WeakMap<RuleContext, ReadonlySet<string>>();

/** Both reach rules use the same defining modules, computed once per context. */
function databaseModules(context: RuleContext): ReadonlySet<string> {
  const cached = databaseModuleSets.get(context);
  if (cached !== undefined) return cached;
  const found = new Set(context.modules.modules.filter((file) => {
    if (file === 'test/test-database.ts' || file === 'test/support/test-database.ts') return true;
    if (!file.startsWith('test/')) return false;
    const binding = resolveExport(context, file, 'createTestDatabaseOwner', new Set());
    return binding?.module === file && binding.name === 'createTestDatabaseOwner';
  }));
  databaseModuleSets.set(context, found);
  return found;
}

function boundCallViolations(context: RuleContext, file: string, call: CallSyntax): TestViolation[] {
  const violations: TestViolation[] = [];
  const layer = layerOf(file);
  const imported = caseApi(context, file, call.name) === 'bound';
  if (!imported) {
    violations.push({
      rule: 'test-case-bound',
      file,
      line: call.line,
      message: `bound() is called without being imported from ${DEADLINE}; the helper is the one way a case bound is named`,
    });
  }
  const ms = numberLiteral(call.arguments[0]);
  if (ms === null) {
    violations.push({
      rule: 'test-case-bound',
      file,
      line: call.arguments[0]?.line ?? call.line,
      message: `the first argument of bound() is not a number this check can read; a bound is a count of milliseconds written as a number`,
    });
    return violations;
  }
  if (layer === 'unit') {
    violations.push({
      rule: 'test-case-bound',
      file,
      line: call.line,
      message: `the unit layer names no bound, and this case names ${group(ms)} ms; a unit case runs in milliseconds and names none`,
    });
  }
  if (layer === 'integration' && ms > INTEGRATION_LIMIT) {
    violations.push({
      rule: 'test-case-bound',
      file,
      line: call.line,
      message: `${group(ms)} ms is above the integration layer's ${group(INTEGRATION_LIMIT)} ms; a case over it belongs in a higher layer or names its measurement and moves`,
    });
  }
  if (layer === 'e2e' && ms > E2E_LIMIT) {
    violations.push({
      rule: 'test-case-bound',
      file,
      line: call.line,
      message: `${group(ms)} ms is above the end-to-end layer's ${group(E2E_LIMIT)} ms, the most a case may take`,
    });
  }
  if (ms < SMALLEST_BOUND) {
    violations.push({
      rule: 'test-case-bound',
      file,
      line: call.line,
      message: `${group(ms)} ms is under ${group(SMALLEST_BOUND)} ms, the smallest a case bound may be`,
    });
  }
  const measurement = call.arguments[1];
  const measured = numberProperty(measurement, 'measured');
  if (measured === null) {
    violations.push({
      rule: 'test-case-bound',
      file,
      line: call.line,
      message: `bound() names no measured time; the bound is at least three times the measurement it records, and the measurement is what a reader checks it against`,
    });
  } else if (ms < 3 * measured) {
    violations.push({
      rule: 'test-case-bound',
      file,
      line: call.line,
      message: `${group(ms)} ms is under three times the measured ${group(measured)} ms (${group(3 * measured)} ms)`,
    });
  }
  if (!hasStringProperty(measurement, 'on')) {
    violations.push({
      rule: 'test-case-bound',
      file,
      line: call.line,
      message: `the measurement names no on; a bound records where its measurement was taken, so a reader can check it`,
    });
  }
  if (!hasStringProperty(measurement, 'at')) {
    violations.push({
      rule: 'test-case-bound',
      file,
      line: call.line,
      message: `the measurement names no at; a bound records the day its measurement was taken, so a reader can check it`,
    });
  }
  return violations;
}

/**
 * Rule 4, `test-timing-only-in-measure`: elapsed time is read only in `test/measure`,
 * where the measurement suite holds it against a baseline; `performance.now`,
 * `Bun.nanoseconds` and `process.hrtime` elsewhere are violations.
 */
export function timingViolations(context: RuleContext): TestViolation[] {
  const violations: TestViolation[] = [];
  for (const folder of [UNIT, INTEGRATION, E2E]) {
    for (const start of context.modulesIn(folder)) {
      const { paths } = reachSearch(context.graph, start, () => false);
      for (const file of new Set([start, ...paths.keys()])) {
        if (file !== start && (!file.startsWith('test/support/') || file === 'test/support/measure.ts')) continue;
        for (const member of timingMembers(context, file)) {
          violations.push({
            rule: 'test-timing-only-in-measure',
            file,
            line: member.line,
            message: `${reachedFrom(start, paths, file)}, whose ${member.name} reads elapsed time, and elapsed time is asserted only in test/measure against a recorded baseline`,
          });
        }
      }
    }
  }
  return violations;
}

/**
 * Rule 5, `test-full-catalogue`: only `test/<layer>/starter-set/` may make a product
 * from `createDraft` and the starter template `everything`; every other file takes
 * `testDraft({ kinds })`, whose `kinds` the type requires.
 */
export function fullCatalogueViolations(context: RuleContext): TestViolation[] {
  const violations: TestViolation[] = [];
  for (const folder of LAYER_FOLDERS) {
    for (const file of context.modulesIn(folder)) {
      if (isStarterSet(file)) continue;
      for (const statement of context.importsOf(file)) {
        if (statement.typeOnly) continue;
        const chain = draftExportChain(context, file, statement);
        if (chain === null) continue;
        violations.push({
          rule: 'test-full-catalogue',
          file,
          line: statement.line,
          message: `imports ${statement.wholeModule ? 'the draft module' : 'createDraft'} through ${[file, ...chain].join(' > ')} from ${DRAFT}; only test/<layer>/starter-set/ makes a product from the whole starter set, and every other file takes testDraft({ kinds }) from test/support/draft.ts`,
        });
      }
      const syntax = context.syntaxOf(file);
      for (const call of syntax.calls) {
        for (const argument of call.arguments) {
          for (const property of argument.properties) {
            if (property.key !== 'template' || property.literal?.kind !== 'string' || property.literal.value !== 'everything') continue;
            violations.push({
              rule: 'test-full-catalogue',
              file,
              line: property.line,
              message: `names the starter template everything; only test/<layer>/starter-set/ makes a product from that template, and every other file takes testDraft({ kinds }) from test/support/draft.ts`,
            });
          }
        }
      }
      for (const array of syntax.arrays) {
        for (let index = 0; index + 1 < array.length; index += 1) {
          const flag = array[index]!;
          const value = array[index + 1]!;
          if (flag.literal?.kind !== 'string' || flag.literal.value !== '--template') continue;
          if (value.literal?.kind !== 'string' || value.literal.value !== 'everything') continue;
          violations.push({
            rule: 'test-full-catalogue',
            file,
            line: value.line,
            message: `names the starter template everything; only test/<layer>/starter-set/ makes a product from that template, and every other file takes testDraft({ kinds }) from test/support/draft.ts`,
          });
        }
      }
    }
  }
  return violations;
}

/** Follow public bindings, not a minimal-catalogue factory's private imports. */
function draftExportChain(context: RuleContext, file: string, statement: ImportStatement): readonly string[] | null {
  const target = resolveModuleSpecifier(context.modules, file, statement.specifier);
  if (target === null || statement.typeOnly) return null;
  const names = statement.wholeModule ? ['createDraft'] : statement.names;
  for (const name of names) {
    const binding = resolveExport(context, target, name, new Set());
    if (binding?.module === DRAFT && binding.name === 'createDraft') return [target, ...(binding.chain ?? [])];
  }
  return null;
}

/** One module a rule reached, and the chain of imports from the layer file. */
interface Reach {
  readonly target: string;
  readonly chain: readonly string[];
  readonly file: string;
  readonly line: number;
}

/**
 * Walks the value graph from `start`, breadth first and in code point order, and
 * answers every target `isForbidden` accepts with the chain that reaches it and the
 * import that names it, together with every module path it walked.
 */
function reachSearch(graph: ImportGraph, start: string, isForbidden: (target: string) => boolean): { found: Reach[]; paths: ReadonlyMap<string, readonly string[]> } {
  const found = new Map<string, Reach>();
  const paths = new Map<string, readonly string[]>([[start, [start]]]);
  const queue = [start];
  while (queue.length > 0) {
    const file = queue.shift()!;
    const path = paths.get(file)!;
    for (const edge of graph.edges.get(file) ?? []) {
      if (isForbidden(edge.to)) {
        if (!found.has(edge.to)) found.set(edge.to, { target: edge.to, chain: [...path, edge.to], file, line: edge.line });
        continue;
      }
      if (graph.modules.has(edge.to) && !paths.has(edge.to)) {
        paths.set(edge.to, [...path, edge.to]);
        queue.push(edge.to);
      }
    }
  }
  return { found: [...found.values()], paths };
}

/** Every module the value graph reaches from `start`, in the order the walk found them. */
function closureOf(graph: ImportGraph, start: string): string[] {
  return [...reachSearch(graph, start, () => false).paths.keys()];
}

function pathOf(paths: ReadonlyMap<string, readonly string[]>, file: string): string {
  return (paths.get(file) ?? [file]).join(' > ');
}

/** The module as a reader finds it from the layer file: the file itself, or the chain of imports that reaches it. */
function reachedFrom(start: string, paths: ReadonlyMap<string, readonly string[]>, file: string): string {
  return file === start ? file : `${start} reaches ${pathOf(paths, file)}`;
}

/** What the unit layer's closure may not reach: a database, a child process, a socket, a browser, the run database's helpers. */
function unitForbidden(target: string): boolean {
  return (
    target === 'pg' ||
    target.startsWith('pg/') ||
    target === 'pg-boss' ||
    target.startsWith('pg-boss/') ||
    isChildProcess(target) ||
    target === 'net' ||
    target === 'node:net' ||
    target.startsWith('puppeteer') ||
    target === 'test/support/run-postgres.ts'
  );
}

function isChildProcess(target: string): boolean {
  return target === 'child_process' || target === 'node:child_process';
}

/** Whether a path is the test side of an integration file: the layer's own files and the helpers of `test/support`. */
function isTestSide(file: string): boolean {
  return file.startsWith(`${INTEGRATION}/`) || file.startsWith('test/support/');
}

function layerOf(file: string): 'unit' | 'integration' | 'e2e' | 'measure' | null {
  if (file.startsWith(`${UNIT}/`)) return 'unit';
  if (file.startsWith(`${INTEGRATION}/`)) return 'integration';
  if (file.startsWith(`${E2E}/`)) return 'e2e';
  if (file.startsWith(`${MEASURE}/`)) return 'measure';
  return null;
}

/** `test/<layer>/starter-set/`: the one place a product is made from the whole starter set. */
function isStarterSet(file: string): boolean {
  const segments = file.split('/');
  return segments[0] === 'test' && segments[1] !== undefined && segments[2] === 'starter-set';
}

const resolvedMemberSets = new WeakMap<RuleContext, Map<string, { segments: readonly string[]; line: number }[]>>();

/** Static value paths, resolved once per context and file, like the parsed syntax. */
function resolvedMembers(context: RuleContext, file: string): { segments: readonly string[]; line: number }[] {
  let files = resolvedMemberSets.get(context);
  if (files === undefined) { files = new Map(); resolvedMemberSets.set(context, files); }
  const cached = files.get(file);
  if (cached !== undefined) return cached;
  const syntax = context.syntaxOf(file);
  const paths = [...syntax.members.map((member) => ({ name: member.segments.join('.'), line: member.line })),
    ...syntax.references.map((reference) => ({ name: reference.call?.name ?? reference.name, line: reference.line }))];
  const found = paths.flatMap((path) => {
    const binding = resolveBinding(context, file, path.name);
    if (binding === null || binding.module !== file) return [];
    return [{ segments: binding.name.split('.'), line: path.line }];
  });
  files.set(file, found);
  return found;
}

/** Members that start a process, or a process and a server: `Bun.spawn*` and, when asked, `Bun.serve`. */
function membersMatching(context: RuleContext, file: string, kinds: readonly ('process' | 'server' | 'spawn')[]): { name: string; line: number }[] {
  const found = new Map<string, { name: string; line: number }>();
  for (const member of resolvedMembers(context, file)) {
    if (member.segments[0] !== 'Bun') continue;
    const second = member.segments[1];
    if (second === undefined) continue;
    const process = second.startsWith('spawn') && kinds.some((kind) => kind === 'process' || kind === 'spawn');
    const server = second === 'serve' && kinds.includes('server');
    if (!process && !server) continue;
    const name = `Bun.${second}`;
    found.set(`${name}:${String(member.line)}`, { name, line: member.line });
  }
  return [...found.values()].sort((left, right) => byCodePoint(left.name, right.name) || left.line - right.line);
}

/** The timing calls rule 4 refuses outside the measurement suite. */
function timingMembers(context: RuleContext, file: string): { name: string; line: number }[] {
  const prefixes: readonly (readonly string[])[] = [
    ['performance', 'now'],
    ['Bun', 'nanoseconds'],
    ['process', 'hrtime'],
  ];
  const found = new Map<string, { name: string; line: number }>();
  for (const member of resolvedMembers(context, file)) {
    const prefix = prefixes.find((candidate) => candidate.every((segment, index) => member.segments[index] === segment));
    if (prefix === undefined) continue;
    const name = prefix.join('.');
    found.set(`${name}:${String(member.line)}`, { name, line: member.line });
  }
  return [...found.values()].sort((left, right) => byCodePoint(left.name, right.name) || left.line - right.line);
}

function numberLiteral(argument: ArgumentSyntax | undefined): number | null {
  return argument?.literal?.kind === 'number' ? argument.literal.value : null;
}

function hasProperty(argument: ArgumentSyntax, key: string): boolean {
  return argument.properties.some((property) => property.key === key);
}

function propertyOf(argument: ArgumentSyntax | undefined, key: string): PropertySyntax | undefined {
  return argument?.properties.find((property) => property.key === key);
}

function numberProperty(argument: ArgumentSyntax | undefined, key: string): number | null {
  const property = propertyOf(argument, key);
  return property?.literal?.kind === 'number' ? property.literal.value : null;
}

function hasStringProperty(argument: ArgumentSyntax | undefined, key: string): boolean {
  const property = propertyOf(argument, key);
  return property?.literal?.kind === 'string' && property.literal.value.trim().length > 0;
}

/** A count with its thousands spaced, as a reader says it: `30 000`. */
function group(value: number): string {
  const text = String(value);
  let grouped = '';
  for (let index = 0; index < text.length; index += 1) {
    if (index > 0 && (text.length - index) % 3 === 0) grouped += ' ';
    grouped += text[index];
  }
  return grouped;
}
