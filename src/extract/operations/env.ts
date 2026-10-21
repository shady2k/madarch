/**
 * The environment variables the code reads, and where they are defined. Every
 * read site carries whether the variable is required (startup fails without
 * it) and the default the code falls back to; every definition site (an
 * .env.example, a compose service's environment, a k8s env entry) carries the
 * value it sets. A variable read but defined nowhere is still a variable: the
 * missing definition is a fact about the repository, not a silence.
 */
import { LineCounter, isMap, isScalar, isSeq, parseDocument } from 'yaml';
import type { PropertyValue } from '../records.js';
import { byCodePoint } from '../../model/order.js';
import type { Records } from './accumulate.js';
import { readComposeFile } from './compose.js';
import { serviceOf, TreeText } from './source.js';

/** One read of one variable, as the source names it. */
export interface EnvRead {
  readonly service: string;
  readonly name: string;
  readonly path: string;
  readonly line: number;
  readonly symbol: string;
  readonly required: boolean;
  readonly default: string | null;
}

const VARIABLE_NAME = /[A-Z][A-Z0-9_]+/;

/** Every environment read in every Go and TypeScript file under services/. */
function readSites(t: TreeText, records: Records): EnvRead[] {
  const reads: EnvRead[] = [];
  for (const path of t.tree.paths) {
    if (!/^services\//.test(path)) continue;
    const service = serviceOf(path);
    if (service === undefined) continue;
    let found: EnvRead[];
    try {
      if (path.endsWith('.ts')) found = typescriptReads(t, path);
      else if (path.endsWith('.go')) found = goReads(t, path);
      else continue;
    } catch (error) {
      records.gap(path, `the reads cannot be listed: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    reads.push(...found.filter((read) => VARIABLE_NAME.test(read.name)));
  }
  return reads.sort((left, right) => byCodePoint(left.path, right.path) || left.line - right.line || byCodePoint(left.name, right.name));
}

/** The reads of one TypeScript file: helper calls with a literal, and direct reads with their fallback. */
function typescriptReads(t: TreeText, path: string): EnvRead[] {
  const lines = t.lines(path);
  const reads: EnvRead[] = [];
  const helperTreatsAbsenceAsFatal =
    lines.some((line) => /missing\.push\(|missing\s*=\s*\[/.test(line)) && lines.some((line) => /throw new Error|missing required/.test(line));
  lines.forEach((line, index) => {
    const number = index + 1;
    const symbol = enclosingTsSymbol(lines, index) ?? '';
    for (const call of line.matchAll(/\b(?:required|require|must)\(\s*['"]([A-Z][A-Z0-9_]*)['"]\s*\)/g)) {
      reads.push({ service: serviceOf(path) ?? '', name: call[1] ?? '', path, line: number, symbol, required: helperTreatsAbsenceAsFatal, default: null });
    }
    for (const direct of line.matchAll(/(?:process\.)?env\.([A-Z][A-Z0-9_]*)(?:\s*\?\?\s*([^,;)\n]+))?/g)) {
      const raw = direct[2]?.trim();
      reads.push({
        service: serviceOf(path) ?? '',
        name: direct[1] ?? '',
        path,
        line: number,
        symbol,
        required: false,
        default: raw === undefined || raw === '' ? null : tsFallback(t, path, raw),
      });
    }
  });
  return reads;
}

/** The value of a `?? ` fallback: a quoted literal, a number, or a constant of the same file. */
function tsFallback(t: TreeText, path: string, raw: string): string | null {
  const quoted = /^['"](.*)['"]$/.exec(raw);
  if (quoted !== null) return quoted[1] ?? null;
  if (/^-?\d+(\.\d+)?$/.test(raw)) return raw;
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(raw)) {
    const declared = new RegExp(`(?:const|let)\\s+${raw}\\s*=\\s*([^;]+);`);
    const constant = t.lines(path).map((line) => declared.exec(line)?.[1]?.trim()).find((value) => value !== undefined);
    if (constant !== undefined) {
      const stripped = constant.replace(/^['"]|['"]$/g, '');
      return stripped === constant ? constant : stripped;
    }
  }
  return raw;
}

/** The reads of one Go file: a require helper that collects what is missing, and os.Getenv with its guard. */
function goReads(t: TreeText, path: string): EnvRead[] {
  const lines = t.lines(path);
  const reads: EnvRead[] = [];
  const helperTreatsAbsenceAsFatal =
    lines.some((line) => /missing\s*=\s*append\(missing/.test(line)) && lines.some((line) => /missing required|fmt\.Errorf|return .*error/.test(line));
  lines.forEach((line, index) => {
    const number = index + 1;
    const symbol = goSymbol(t, path, index);
    for (const call of line.matchAll(/\b(?:require|getenv|must)\(\s*"([A-Z][A-Z0-9_]*)"\s*\)/g)) {
      reads.push({ service: serviceOf(path) ?? '', name: call[1] ?? '', path, line: number, symbol, required: helperTreatsAbsenceAsFatal, default: null });
    }
    for (const call of line.matchAll(/os\.Getenv\(\s*"([A-Z][A-Z0-9_]*)"\s*\)/g)) {
      reads.push({ service: serviceOf(path) ?? '', name: call[1] ?? '', path, line: number, symbol, required: goGuardFails(lines, index), default: null });
    }
  });
  return reads;
}

/** Whether the lines after a bare Getenv read exit when the value is empty. */
function goGuardFails(lines: readonly string[], index: number): boolean {
  for (let at = index; at < Math.min(index + 6, lines.length); at += 1) {
    if (at > index && /^func /.test(lines[at] ?? '')) return false;
    if (/os\.Exit\(|log\.Fatal/.test(lines[at] ?? '')) return true;
  }
  return false;
}

/**
 * The symbol a Go read sits behind: its enclosing function, climbed to the
 * exported (or main) function of the file that reaches it — the entry whose
 * failure stops the startup.
 */
function goSymbol(t: TreeText, path: string, index: number): string {
  const lines = t.lines(path);
  let enclosing: string | undefined;
  for (let at = index; at >= 0; at -= 1) {
    const declared = /^func\s+(?:\([^)]*\)\s+)?([A-Za-z0-9_]+)/.exec(lines[at] ?? '');
    if (declared !== null) {
      enclosing = declared[1];
      break;
    }
  }
  if (enclosing === undefined) return '';
  if (/^[a-z]/.test(enclosing) && enclosing !== 'main') {
    const mentions = new RegExp(`\\b${enclosing}\\b`);
    const ownDeclaration = new RegExp(`^func\\s+(?:\\([^)]*\\)\\s+)?${enclosing}\\b`);
    const climbers: string[] = [];
    lines.forEach((line, at) => {
      if (!mentions.test(line) || ownDeclaration.test(line)) return;
      for (let scan = at; scan >= 0; scan -= 1) {
        const declared = /^func\s+(?:\([^)]*\)\s+)?([A-Za-z0-9_]+)/.exec(lines[scan] ?? '');
        if (declared !== null) {
          const name = declared[1] ?? '';
          if (name !== enclosing && (/^[A-Z]/.test(name) || name === 'main')) climbers.push(name);
          return;
        }
      }
    });
    climbers.sort(byCodePoint);
    if (climbers[0] !== undefined) return climbers[0];
  }
  return enclosing;
}

/** The enclosing declaration a TypeScript read sits in: the nearest function or const arrow above, less indented. */
function enclosingTsSymbol(lines: readonly string[], index: number): string | undefined {
  const own = indentOf(lines[index] ?? '');
  for (let at = index; at >= 0; at -= 1) {
    const line = lines[at] ?? '';
    if (at !== index && indentOf(line) >= own) continue;
    const declared = /(?:function\s+([A-Za-z0-9_]+)|(?:const|let)\s+([A-Za-z0-9_]+)\s*=\s*(?:async\s*)?\()/.exec(line);
    if (declared !== null) return declared[1] ?? declared[2];
  }
  return undefined;
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

// ---- the definition sites ---------------------------------------------------

/** One definition of one variable, with the value it sets and the service it scopes to. */
interface EnvDefinition {
  readonly key: string;
  readonly name: string;
  readonly scope: string | null;
  readonly value: string | null;
  readonly span: ReturnType<TreeText['spanOfLine']>;
}

/** The definitions in the .env.example files, as NAME=value lines. */
function envExampleDefinitions(t: TreeText): EnvDefinition[] {
  const definitions: EnvDefinition[] = [];
  for (const path of t.pathsNamed(/^\.env\.example$/)) {
    t.lines(path).forEach((line, index) => {
      const declared = /^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
      if (declared === null) return;
      const name = declared[1] ?? '';
      const value = (declared[2] ?? '').trim();
      definitions.push({
        key: `code.env-definition:${path}#${name}`,
        name,
        scope: null,
        value: value === '' ? null : value,
        span: t.spanOfLine(path, index + 1),
      });
    });
  }
  return definitions;
}

/** The env: entries of YAML that set an explicit value, as in deploy/k8s. */
function yamlEnvDefinitions(t: TreeText, path: string): EnvDefinition[] {
  const definitions: EnvDefinition[] = [];
  const lineCounter = new LineCounter();
  const document = parseDocument(t.text(path), { lineCounter, keepSourceTokens: true });
  const visit = (node: unknown): void => {
    if (!isMap(node)) return;
    const env = node.items.find((pair) => isScalar(pair.key) && pair.key.value === 'env')?.value;
    if (!isSeq(env)) {
      for (const pair of node.items) {
        visit(pair.key);
        visit(pair.value);
      }
      return;
    }
    for (const entry of env.items) {
      if (!isMap(entry)) continue;
      const name = entry.items.find((pair) => isScalar(pair.key) && pair.key.value === 'name')?.value;
      const value = entry.items.find((pair) => isScalar(pair.key) && pair.key.value === 'value')?.value;
      if (!isScalar(name) || typeof name.value !== 'string') continue;
      if (!isScalar(value) || typeof value.value !== 'string') continue;
      const line = lineCounter.linePos(name.range?.[0] ?? 0).line;
      definitions.push({
        key: `code.env-definition:${path}#${name.value}`,
        name: name.value,
        scope: null,
        value: value.value,
        span: t.spanOfLine(path, line),
      });
    }
    for (const pair of node.items) {
      visit(pair.value);
    }
  };
  visit(document.contents);
  return definitions;
}

// ---- the area ----------------------------------------------------------------

/** The environment area: the variables with their reads, and the definitions that set them. */
export function extractEnv(t: TreeText, records: Records): Map<string, EnvRead[]> {
  const reads = readSites(t, records);
  const byVariable = new Map<string, EnvRead[]>();
  for (const read of reads) {
    const key = `${read.service}/${read.name}`;
    const held = byVariable.get(key);
    if (held === undefined) byVariable.set(key, [read]);
    else held.push(read);
  }

  const definitions: EnvDefinition[] = [...envExampleDefinitions(t)];
  for (const path of t.pathsNamed(/^(?:docker-)?compose(?:\.[A-Za-z0-9_-]+)*\.ya?ml$/)) {
    for (const service of readComposeFile(t, records, path)) {
      for (const variable of service.environment) {
        definitions.push({
          key: `code.env-definition:${path}#${service.name}/${variable.name}`,
          name: variable.name,
          scope: service.name,
          value: variable.value,
          span: variable.span,
        });
      }
    }
  }
  for (const path of t.pathsUnder('deploy', /\.ya?ml$/)) {
    definitions.push(...yamlEnvDefinitions(t, path));
  }

  for (const [variable, sites] of [...byVariable].sort((left, right) => byCodePoint(left[0], right[0]))) {
    const required = sites.some((read) => read.required);
    const defaults = [...new Set(sites.map((read) => read.default).filter((value): value is string => value !== null))].sort(byCodePoint);
    const first = sites[0];
    if (first === undefined) continue;
    records.add({
      key: `code.env-var:${variable}`,
      kind: 'code.env-var',
      label: variable.slice(variable.indexOf('/') + 1),
      properties: { required, default: defaults[0] ?? null } satisfies { [key: string]: PropertyValue },
      span: t.spanOfLine(first.path, first.line),
    });
    for (const read of sites) {
      records.edge(
        'code.reads-env',
        records.file(read.path),
        `code.env-var:${variable}`,
        { symbol: read.symbol, required: read.required, default: read.default },
        t.spanOfLine(read.path, read.line),
      );
    }
  }
  for (const definition of definitions.sort((left, right) => byCodePoint(left.key, right.key))) {
    records.add({
      key: definition.key,
      kind: 'code.env-definition',
      label: definition.name,
      properties: { value: definition.value },
      span: definition.span,
    });
    if (definition.scope === null) continue;
    const variable = `${definition.scope}/${definition.name}`;
    if (!byVariable.has(variable)) continue;
    records.edge('code.defines', definition.key, `code.env-var:${variable}`, { value: definition.value }, definition.span);
  }
  return byVariable;
}
