/**
 * The code section of the Problems page (madarch-m38l.19): deterministic
 * rules over the graph the code extractors filled, never a model's guess.
 * Every rule reads facts that already exist — a cycle node, an import edge, a
 * file's line and commit count, a symbol's dead-export flag, a comment's
 * marker, an environment variable's required flag and its definitions — and
 * says one plain reason and an evidence path. The rule data (id, Sonar kind,
 * severity) comes from `rules.ts`; the thresholds come from the product's
 * manifest, with the starter set's defaults.
 */
import { byCodePoint } from '../model/order.js';
import { entityAddress } from '../knowledge/resolve.js';
import type { GraphEntity, GraphReader, RelationEdge } from '../knowledge/graph-read.js';
import { PROBLEM_RULES, severityOf } from './rules.js';
import type { ProblemDraft, ProblemLink, ProblemScope, ProblemSettings, ProblemSeverity } from './types.js';

/** Everything the code rules read, loaded once so each rule is a function of facts alone. */
export interface CodeSnapshot {
  readonly files: readonly GraphEntity[];
  readonly symbols: readonly GraphEntity[];
  readonly cycles: readonly GraphEntity[];
  readonly routes: readonly GraphEntity[];
  readonly operations: readonly GraphEntity[];
  readonly dependencies: readonly GraphEntity[];
  readonly packages: readonly GraphEntity[];
  readonly envVars: readonly GraphEntity[];
  readonly envDefinitions: readonly GraphEntity[];
  readonly inputs: readonly GraphEntity[];
  readonly builds: readonly GraphEntity[];
  readonly sinks: readonly GraphEntity[];
  readonly debts: readonly GraphEntity[];
  readonly flows: readonly RelationEdge[];
  readonly serves: readonly RelationEdge[];
  readonly defines: readonly RelationEdge[];
  readonly usesDependency: readonly RelationEdge[];
  /** Facts the reader could not load whole: said in the listing, never hidden. */
  readonly notes: readonly string[];
}

const LIMIT = 200_000;

const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const number = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);
const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : []);

const pathOfKey = (key: string): string => {
  const rest = key.slice(key.indexOf(':') + 1);
  const hash = rest.indexOf('#');
  return hash < 0 ? rest : rest.slice(0, hash);
};
const baseName = (path: string): string => path.slice(path.lastIndexOf('/') + 1);
const fileKeyOf = (path: string): string => `code.file:${path}`;

export const entityLink = (key: string, label: string): ProblemLink => ({ label, href: entityAddress(key), key });

export const fileLink = (path: string, line?: number): ProblemLink => ({
  label: line === undefined ? path : `${path}:${line}`,
  href: entityAddress(fileKeyOf(path)),
  key: fileKeyOf(path),
});

const valueLink = (label: string): ProblemLink => ({ label, href: null, key: null });

/** Loads every fact the code rules read. A fact set read short is named in the notes. */
export async function readCodeSnapshot(graph: GraphReader): Promise<CodeSnapshot> {
  const notes: string[] = [];
  const read = async (kind: string, prefix = `${kind}:`): Promise<GraphEntity[]> => {
    const found = await graph.byPrefix(kind, prefix, LIMIT);
    if (found.total > found.rows.length) notes.push(`the code section reads the first ${found.rows.length} of ${found.total} ${kind} facts: the rest are not judged`);
    return found.rows;
  };
  const relation = async (name: string): Promise<RelationEdge[]> => {
    const found = await graph.relationEdges(name, LIMIT);
    if (found.total > found.rows.length) notes.push(`the code section reads the first ${found.rows.length} of ${found.total} ${name} edges: the rest are not judged`);
    return found.rows;
  };
  const [files, symbols, cycles, routes, operations, dependencies, packages, envVars, envDefinitions, inputs, builds, sinks, debts, flows, serves, defines, usesDependency] = await Promise.all([
    read('code.file'), read('code.symbol'), read('code.cycle'), read('code.route'), read('code.operation'),
    read('code.dependency'), read('code.package'), read('code.env-var'), read('code.env-definition'),
    read('code.input'), read('code.sql-build'), read('code.sql-sink'), read('code.debt'),
    relation('code.flows-into'), relation('code.serves'), relation('code.defines'), relation('code.uses-dependency'),
  ]);
  return { files, symbols, cycles, routes, operations, dependencies, packages, envVars, envDefinitions, inputs, builds, sinks, debts, flows, serves, defines, usesDependency, notes };
}

export interface CodeResult {
  readonly problems: readonly ProblemDraft[];
  readonly notes: readonly string[];
}

/** Runs the whole code section: each rule over the one snapshot, in the rule data's order. */
export function evaluateCode(snapshot: CodeSnapshot, settings: ProblemSettings): CodeResult {
  const drafts: ProblemDraft[] = [];
  const notes = [...snapshot.notes];
  const rules = new Map(PROBLEM_RULES.map((rule) => [rule.id, rule] as const));
  const run = (id: string, work: (rule: typeof PROBLEM_RULES[number], severity: ProblemSeverity) => ProblemDraft[]): void => {
    const rule = rules.get(id);
    if (rule === undefined) return;
    if (settings.rules[id]?.enabled === false) return;
    try {
      drafts.push(...work(rule, severityOf(rule, settings)));
    } catch (error) {
      notes.push(`the rule ${id} could not be run: ${(error as Error).message}`);
    }
  };
  run('dependency.cycle', (rule, severity) => dependencyCycles(snapshot, rule, severity));
  run('security.sql-input', (rule, severity) => sqlInputs(snapshot, rule, severity));
  run('security.export-route', (rule, severity) => routesOutsideAuth(snapshot, rule, severity));
  run('large-file', (rule, severity) => largeFiles(snapshot, rule, severity, settings.thresholds.largeFileLines));
  run('hotspot', (rule, severity) => hotspots(snapshot, rule, severity, settings.thresholds));
  run('dead-export', (rule, severity) => deadExports(snapshot, rule, severity));
  run('debt.todo', (rule, severity) => debtMarkers(snapshot, rule, severity, 'TODO'));
  run('debt.fixme', (rule, severity) => debtMarkers(snapshot, rule, severity, 'FIXME'));
  run('config.required-dev-value', (rule, severity) => requiredDevValues(snapshot, rule, severity));
  run('dependency.declared-unused', (rule, severity) => declaredUnused(snapshot, rule, severity));
  run('dependency.used-undeclared', (rule, severity) => usedUndeclared(snapshot, rule, severity));
  run('contract.operation-without-route', (rule, severity) => operationsWithoutRoutes(snapshot, rule, severity));
  run('contract.route-without-operation', (rule, severity) => routesWithoutOperations(snapshot, rule, severity));
  return { problems: drafts, notes };
}

type Rule = typeof PROBLEM_RULES[number];

/** A draft of the code section, with the fields every code finding shares. */
function draft(rule: Rule, severity: ProblemSeverity, fields: Omit<ProblemDraft, 'section' | 'rule' | 'kind' | 'sonar' | 'severity' | 'fixer' | 'closed' | 'by' | 'at'>): ProblemDraft {
  return {
    section: 'code', rule: rule.id, kind: rule.kind, sonar: rule.sonar, severity,
    fixer: 'person', closed: false,
    ...fields,
    by: null, at: null,
  };
}

// ---- dependency cycles -----------------------------------------------------------------------

/** Files and modules that import one another in a ring; the graph's own `code.cycle` nodes. */
export function dependencyCycles(snapshot: CodeSnapshot, rule: Rule, severity: ProblemSeverity): ProblemDraft[] {
  return [...snapshot.cycles].sort((a, b) => byCodePoint(a.key, b.key)).map((cycle) => {
    const level = text(cycle.properties['level']) ?? 'file';
    const members = strings(cycle.properties['members']);
    const edges = strings(cycle.properties['edges']);
    const names = members.map(pathOfKey);
    const path = cycle.span?.path ?? (names[0] ?? '');
    const what = level === 'file' ? 'files' : 'modules';
    const reason = `${names.map(baseName).join(' and ')} import one another in a cycle of ${members.length} ${what}: every change to one reaches the others.`;
    const scope: ProblemScope | undefined = path === '' ? undefined : { type: 'file', path };
    return draft(rule, severity, {
      reason, file: path, line: cycle.span?.lineStart ?? null,
      page: null, pageTitle: null, statement: null, sentence: null, target: cycle.key,
      place: fileLink(path, cycle.span?.lineStart),
      entity: entityLink(cycle.key, cycle.label),
      evidence: edges.map((edge) => {
        const [from, to] = edge.split(' -> ');
        return entityLink(from ?? edge, `${baseName(pathOfKey(from ?? edge))} → ${baseName(pathOfKey(to ?? ''))}`);
      }),
      identity: cycle.key,
      ...(scope === undefined ? {} : { scope }),
    });
  });
}

// ---- untrusted input reaching SQL ------------------------------------------------------------

/** An input whose value flows into a SQL string builder and from there into an execution sink. */
export function sqlInputs(snapshot: CodeSnapshot, rule: Rule, severity: ProblemSeverity): ProblemDraft[] {
  const byKey = new Map([...snapshot.inputs, ...snapshot.builds, ...snapshot.sinks].map((entity) => [entity.key, entity] as const));
  const intoBuild = new Map<string, string[]>();
  const intoSink = new Map<string, string[]>();
  for (const edge of snapshot.flows) {
    const map = edge.to.key.startsWith('code.sql-build:') ? intoBuild : intoSink;
    const held = map.get(edge.to.key) ?? [];
    held.push(edge.from.key);
    map.set(edge.to.key, held);
  }
  const problems: ProblemDraft[] = [];
  for (const sink of [...snapshot.sinks].sort((a, b) => byCodePoint(a.key, b.key))) {
    const builds = [...new Set(intoSink.get(sink.key) ?? [])].sort(byCodePoint);
    for (const buildKey of builds) {
      const inputKeys = [...new Set(intoBuild.get(buildKey) ?? [])].sort(byCodePoint);
      if (inputKeys.length === 0) continue;
      const build = byKey.get(buildKey);
      const inputs = inputKeys.map((key) => byKey.get(key)).filter((entity): entity is GraphEntity => entity !== undefined);
      if (build === undefined) continue;
      const path = sink.span?.path ?? build.span?.path ?? '';
      const names = inputs.map((input) => input.label).join(', ');
      const reason = `${names} reach ${build.label}, which builds SQL text by joining strings, and ${sink.label} runs that text as it is: the value is never a bound parameter.`;
      problems.push(draft(rule, severity, {
        reason, file: path, line: sink.span?.lineStart ?? build.span?.lineStart ?? null,
        page: null, pageTitle: null, statement: null, sentence: null, target: sink.key,
        place: fileLink(path, sink.span?.lineStart),
        entity: entityLink(sink.key, sink.label),
        evidence: [...inputs.map((input) => entityLink(input.key, input.label)), entityLink(build.key, build.label), entityLink(sink.key, sink.label)],
        identity: `${sink.key}\u0000${build.key}`,
        ...(path === '' ? {} : { scope: { type: 'file', path } }),
      }));
    }
  }
  return problems;
}

// ---- routes outside the auth group -----------------------------------------------------------

/** The first path segment of a route: `/orders/export` is `orders`. */
const routeRoot = (path: string): string => {
  const parts = path.split('/').filter((part) => part !== '');
  return parts[0] ?? '';
};

/**
 * A route registered outside the auth group while routes of the same service
 * and the same path root are inside it. A service with no auth route at all
 * is not judged: there is no group to stand outside of.
 */
export function routesOutsideAuth(snapshot: CodeSnapshot, rule: Rule, severity: ProblemSeverity): ProblemDraft[] {
  const byService = new Map<string, GraphEntity[]>();
  for (const route of snapshot.routes) {
    const service = text(route.properties['service']) ?? '';
    byService.set(service, [...(byService.get(service) ?? []), route]);
  }
  const problems: ProblemDraft[] = [];
  for (const [service, routes] of byService) {
    const protectedRoots = new Set(routes.filter((route) => route.properties['authGroup'] === true).map((route) => routeRoot(text(route.properties['path']) ?? '')));
    if (protectedRoots.size === 0) continue;
    for (const route of [...routes].sort((a, b) => byCodePoint(a.key, b.key))) {
      if (route.properties['authGroup'] === true) continue;
      const root = routeRoot(text(route.properties['path']) ?? '');
      if (!protectedRoots.has(root)) continue;
      const path = route.span?.path ?? pathOfKey(route.key);
      const handler = text(route.properties['handlerKey']);
      const handlerPath = text(route.properties['handlerPath']);
      const reason = `${route.label} is registered outside the auth group, while the other /${root} routes of ${service || 'this service'} are inside it: it answers without a token.`;
      const evidence: ProblemLink[] = [entityLink(route.key, route.label)];
      if (handler !== undefined) evidence.push(entityLink(handler, handlerPath === undefined ? handler : `${handlerPath} (handler)`));
      problems.push(draft(rule, severity, {
        reason, file: path, line: route.span?.lineStart ?? null,
        page: null, pageTitle: null, statement: null, sentence: null, target: route.key,
        place: fileLink(path, route.span?.lineStart),
        entity: entityLink(route.key, route.label),
        evidence,
        identity: route.key,
        ...(path === '' ? {} : { scope: { type: 'file', path } }),
      }));
    }
  }
  return problems;
}

// ---- large files and change hotspots ---------------------------------------------------------

/** A file over the product's line threshold. */
export function largeFiles(snapshot: CodeSnapshot, rule: Rule, severity: ProblemSeverity, threshold: number): ProblemDraft[] {
  return snapshot.files
    .filter((file) => file.properties['role'] !== 'test' && (number(file.properties['lines']) ?? 0) >= threshold)
    .map((file) => {
      const lines = number(file.properties['lines'])!;
      const path = text(file.properties['path']) ?? pathOfKey(file.key);
      return draft(rule, severity, {
        reason: `${path} is ${lines} lines long, over the product's ${threshold}-line threshold: one module holds too much to change safely.`,
        file: path, line: 1,
        page: null, pageTitle: null, statement: null, sentence: null, target: file.key,
        place: fileLink(path, 1),
        entity: entityLink(file.key, file.label),
        evidence: [entityLink(file.key, path), valueLink(`${lines} lines`)],
        identity: file.key,
        scope: { type: 'file', path },
      });
    })
    .sort((a, b) => byCodePoint(a.file, b.file));
}

/** A file that is both large and often changed: size × churn over the thresholds. */
export function hotspots(snapshot: CodeSnapshot, rule: Rule, severity: ProblemSeverity, thresholds: ProblemSettings['thresholds']): ProblemDraft[] {
  return snapshot.files
    .filter((file) => file.properties['role'] !== 'test')
    .map((file) => ({ file, lines: number(file.properties['lines']) ?? 0, commits: number(file.properties['commitCount']) ?? 0 }))
    .filter((entry) => entry.lines >= thresholds.hotspotLines && entry.commits >= thresholds.hotspotCommits && entry.lines * entry.commits >= thresholds.hotspotScore)
    .map(({ file, lines, commits }) => {
      const path = text(file.properties['path']) ?? pathOfKey(file.key);
      return draft(rule, severity, {
        reason: `${path} is ${lines} lines long and ${commits} commits changed it (size × churn = ${lines * commits}): most changes land where the code is largest.`,
        file: path, line: 1,
        page: null, pageTitle: null, statement: null, sentence: null, target: file.key,
        place: fileLink(path, 1),
        entity: entityLink(file.key, file.label),
        evidence: [entityLink(file.key, path), valueLink(`${commits} commits`)],
        identity: file.key,
        scope: { type: 'file', path },
      });
    })
    .sort((a, b) => byCodePoint(a.file, b.file));
}

// ---- dead exports ----------------------------------------------------------------------------

/** An exported symbol no code of the repository refers to. */
export function deadExports(snapshot: CodeSnapshot, rule: Rule, severity: ProblemSeverity): ProblemDraft[] {
  return snapshot.symbols
    .filter((symbol) => symbol.properties['deadExport'] === true)
    .map((symbol) => {
      const path = symbol.span?.path ?? pathOfKey(symbol.key);
      return draft(rule, severity, {
        reason: `${symbol.label} is exported by ${path} and no code in this repository refers to it: the export is dead.`,
        file: path, line: symbol.span?.lineStart ?? null,
        page: null, pageTitle: null, statement: null, sentence: null, target: symbol.key,
        place: fileLink(path, symbol.span?.lineStart),
        entity: entityLink(symbol.key, symbol.label),
        evidence: [entityLink(symbol.key, symbol.label), entityLink(fileKeyOf(path), path)],
        identity: symbol.key,
        scope: { type: 'symbol', key: symbol.key },
      });
    })
    .sort((a, b) => byCodePoint(a.file, b.file) || (a.line ?? 0) - (b.line ?? 0));
}

// ---- TODO and FIXME markers ------------------------------------------------------------------

/**
 * The marker at the start of a comment's text — `TODO: …`, `FIXME(team): …` —
 * read from the syntax tree's comment node, never from a search over the
 * file's text. The marker is a word of the comment's own first token.
 */
export function debtMarkers(snapshot: CodeSnapshot, rule: Rule, severity: ProblemSeverity, marker: string): ProblemDraft[] {
  return snapshot.debts
    .filter((debt) => debt.properties['marker'] === marker)
    .map((debt) => {
      const path = debt.span?.path ?? text(debt.properties['path']) ?? '';
      const body = text(debt.properties['text']) ?? '';
      return draft(rule, severity, {
        reason: `${marker} in ${path}: ${body}`,
        file: path, line: debt.span?.lineStart ?? number(debt.properties['line']) ?? null,
        page: null, pageTitle: null, statement: null, sentence: null, target: debt.key,
        place: fileLink(path, debt.span?.lineStart),
        entity: entityLink(debt.key, `${marker}: ${body}`),
        evidence: [entityLink(debt.key, `${marker} comment`), entityLink(fileKeyOf(path), path)],
        identity: debt.key,
        ...(path === '' ? {} : { scope: { type: 'file', path } }),
      });
    })
    .sort((a, b) => byCodePoint(a.file, b.file) || (a.line ?? 0) - (b.line ?? 0));
}

// ---- required settings with a checked-in value -----------------------------------------------

/** The default a `${NAME:-default}` compose expression would use; the expression itself is not a value. */
export function composeDefault(value: string): string {
  if (!value.startsWith('${') || !value.endsWith('}')) return value;
  const inside = value.slice(2, -1);
  const at = inside.indexOf(':-');
  return at < 0 ? '' : inside.slice(at + 2);
}

/**
 * A required variable whose checked-in configuration gives one and the same
 * literal value in at least two files: every copy of the product then starts
 * with the same secret, and the secret is in the repository. The rule reads
 * definitions the environment extractor already classified as definitions;
 * it never scans a file's text.
 */
export function requiredDevValues(snapshot: CodeSnapshot, rule: Rule, severity: ProblemSeverity): ProblemDraft[] {
  const byKey = new Map(snapshot.envDefinitions.map((definition) => [definition.key, definition] as const));
  const byVariable = new Map<string, GraphEntity[]>();
  for (const edge of snapshot.defines) {
    const definition = byKey.get(edge.from.key);
    if (definition === undefined) continue;
    byVariable.set(edge.to.key, [...(byVariable.get(edge.to.key) ?? []), definition]);
  }
  const problems: ProblemDraft[] = [];
  for (const variable of snapshot.envVars) {
    if (variable.properties['required'] !== true) continue;
    // The variable's label is its own name; the service and scope are not part of it.
    const name = text(variable.properties['name']) ?? variable.label;
    const definitions = (byVariable.get(variable.key) ?? []).filter((definition) => {
      const value = text(definition.properties['value']);
      return value !== undefined && value !== '' && composeDefault(value) !== '';
    });
    if (definitions.length < 2) continue;
    const values = definitions.map((definition) => composeDefault(text(definition.properties['value'])!));
    const shared = values[0];
    if (shared === undefined || values.some((value) => value !== shared)) continue;
    const files = [...new Set(definitions.map((definition) => definition.span?.path).filter((path): path is string => path !== undefined))];
    if (files.length < 2) continue;
    const first = definitions[0]!;
    const path = first.span?.path ?? '';
    problems.push(draft(rule, severity, {
      reason: `${name} is required, and the checked-in configuration gives it one literal value ("${shared}") in ${files.join(' and ')}: every copy of the product starts with the same secret.`,
      file: path, line: first.span?.lineStart ?? null,
      page: null, pageTitle: null, statement: null, sentence: null, target: variable.key,
      place: fileLink(path, first.span?.lineStart),
      entity: entityLink(variable.key, name),
      evidence: [
        entityLink(variable.key, `${name} (required)`),
        ...definitions.map((definition) => fileLink(definition.span?.path ?? path, definition.span?.lineStart)),
      ],
      identity: variable.key,
      ...(path === '' ? {} : { scope: { type: 'file', path } }),
    }));
  }
  return problems.sort((a, b) => byCodePoint(a.file, b.file) || (a.line ?? 0) - (b.line ?? 0));
}

// ---- declared and used dependencies ----------------------------------------------------------

const usedTargets = (snapshot: CodeSnapshot): Set<string> => new Set(snapshot.usesDependency.map((edge) => edge.to.key));

/** A direct dependency its own service never imports. */
export function declaredUnused(snapshot: CodeSnapshot, rule: Rule, severity: ProblemSeverity): ProblemDraft[] {
  const used = usedTargets(snapshot);
  return snapshot.dependencies
    .filter((dependency) => dependency.properties['scope'] === 'direct' && !used.has(dependency.key))
    .map((dependency) => {
      const path = dependency.span?.path ?? pathOfKey(dependency.key);
      const name = text(dependency.properties['name']) ?? dependency.label;
      const version = text(dependency.properties['version']);
      return draft(rule, severity, {
        reason: `${name}${version === undefined ? '' : ` (${version})`} is declared by ${path} and no source file of its service imports it: the declaration is dead weight.`,
        file: path, line: dependency.span?.lineStart ?? null,
        page: null, pageTitle: null, statement: null, sentence: null, target: dependency.key,
        place: fileLink(path, dependency.span?.lineStart),
        entity: entityLink(dependency.key, name),
        evidence: [entityLink(dependency.key, name), entityLink(fileKeyOf(path), path)],
        identity: dependency.key,
        ...(path === '' ? {} : { scope: { type: 'file', path } }),
      });
    })
    .sort((a, b) => byCodePoint(a.file, b.file));
}

/** An import of a third-party package that no manifest of its service declares. */
export function usedUndeclared(snapshot: CodeSnapshot, rule: Rule, severity: ProblemSeverity): ProblemDraft[] {
  return snapshot.packages
    .filter((pkg) => pkg.properties['external'] === true && pkg.properties['standardLibrary'] !== true && pkg.properties['versionStatus'] === 'not-declared')
    .map((pkg) => {
      const path = pkg.span?.path ?? '';
      const name = text(pkg.properties['name']) ?? pkg.label;
      return draft(rule, severity, {
        reason: `${name} is imported by ${path}, but no manifest of that service declares it: a fresh install resolves a different version or fails.`,
        file: path, line: pkg.span?.lineStart ?? null,
        page: null, pageTitle: null, statement: null, sentence: null, target: pkg.key,
        place: fileLink(path, pkg.span?.lineStart),
        entity: entityLink(pkg.key, name),
        evidence: [entityLink(fileKeyOf(path), path), entityLink(pkg.key, name)],
        identity: pkg.key,
        ...(path === '' ? {} : { scope: { type: 'file', path } }),
      });
    })
    .sort((a, b) => byCodePoint(a.file, b.file) || byCodePoint(a.target ?? '', b.target ?? ''));
}

// ---- contracts and routes --------------------------------------------------------------------

/** A contract operation no route implements. */
export function operationsWithoutRoutes(snapshot: CodeSnapshot, rule: Rule, severity: ProblemSeverity): ProblemDraft[] {
  const served = new Set(snapshot.serves.map((edge) => edge.to.key));
  return snapshot.operations
    .filter((operation) => !served.has(operation.key))
    .map((operation) => {
      const path = operation.span?.path ?? pathOfKey(operation.key);
      return draft(rule, severity, {
        reason: `${operation.label} is declared by ${path}, and no route implements it: a caller following the contract gets no answer.`,
        file: path, line: operation.span?.lineStart ?? null,
        page: null, pageTitle: null, statement: null, sentence: null, target: operation.key,
        place: fileLink(path, operation.span?.lineStart),
        entity: entityLink(operation.key, operation.label),
        evidence: [entityLink(operation.key, operation.label), entityLink(fileKeyOf(path), path)],
        identity: operation.key,
        ...(path === '' ? {} : { scope: { type: 'file', path } }),
      });
    })
    .sort((a, b) => byCodePoint(a.file, b.file));
}

/** A route of a service the contract covers that the contract does not declare. */
export function routesWithoutOperations(snapshot: CodeSnapshot, rule: Rule, severity: ProblemSeverity): ProblemDraft[] {
  const servedRoutes = new Set(snapshot.serves.map((edge) => edge.from.key));
  const covered = new Set(snapshot.routes.filter((route) => servedRoutes.has(route.key)).map((route) => text(route.properties['service']) ?? ''));
  return snapshot.routes
    .filter((route) => !servedRoutes.has(route.key) && covered.has(text(route.properties['service']) ?? ''))
    .map((route) => {
      const path = route.span?.path ?? pathOfKey(route.key);
      return draft(rule, severity, {
        reason: `${route.label} is served by ${path}, and the service's contract declares no such operation: the interface is wider than the document.`,
        file: path, line: route.span?.lineStart ?? null,
        page: null, pageTitle: null, statement: null, sentence: null, target: route.key,
        place: fileLink(path, route.span?.lineStart),
        entity: entityLink(route.key, route.label),
        evidence: [entityLink(route.key, route.label), entityLink(fileKeyOf(path), path)],
        identity: route.key,
        ...(path === '' ? {} : { scope: { type: 'file', path } }),
      });
    })
    .sort((a, b) => byCodePoint(a.file, b.file));
}
