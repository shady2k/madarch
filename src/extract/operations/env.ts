/**
 * The environment variables the code reads, and where they are defined. Every
 * read site carries whether the variable is required (startup fails without
 * it) and the default the code falls back to; every definition site (an
 * .env.example, a compose service's environment, a k8s env entry) carries the
 * value it sets. A variable read but defined nowhere is still a variable: the
 * missing definition is a fact about the repository, not a silence.
 *
 * A read comes from the shared code facts — a call fact or a member access the
 * parser copied — never from a pattern over a file's text: a comment, a string
 * or a line that mentions `process.env.NAME` is no read (madarch-mwhd.3).
 */
import { LineCounter, isMap, isScalar, isSeq, parseAllDocuments } from 'yaml';
import type { PropertyValue, SourceSpan } from '../records.js';
import { byCodePoint } from '../../model/order.js';
import type {
  CodeBindingFact, CodeCallFact, CodeExpressionFact, CodeFacts, CodeSymbolFact,
} from '../code/facts.js';
import type { LibraryEffect } from '../library-models/model.js';
import type { Records } from './accumulate.js';
import { CodeFactView } from './code-facts.js';
import { readComposeFile } from './compose.js';
import { TreeText } from './source.js';

/** Value-bearing graph declarations shared with readers of the emitted records. */
export const ENVIRONMENT_VALUE_RECORDS = {
  variable: { record: 'node', key: 'code.env-var', field: 'default' },
  definition: { record: 'node', key: 'code.env-definition', field: 'value' },
  read: { record: 'edge', key: 'code.reads-env', field: 'default' },
  defines: { record: 'edge', key: 'code.defines', field: 'value' },
} as const;

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

/** The name a variable may carry: an upper-case word, asked of the name the facts handed over, never of the file. */
const VARIABLE_NAME = /[A-Z][A-Z0-9_]+/;

/** The helpers that read one named variable for their caller, by the language that declares them. */
const HELPER_NAMES: Readonly<Record<'go' | 'typescript', readonly string[]>> = {
  typescript: ['required', 'require', 'must'],
  go: ['require', 'getenv', 'must'],
};

/** The wrappers a read is written in without changing what it reads. */
const TRANSPARENT_KINDS: ReadonlySet<string> = new Set([
  'parenthesized_expression', 'as_expression', 'satisfies_expression', 'non_null_expression', 'await_expression',
]);

/** The calls that stop a Go program: `os.Exit` and the log package's fatal family. */
const GO_STOP_MEMBERS: ReadonlySet<string> = new Set(['Exit', 'Fatal', 'Fatalf', 'Fatalln']);

/** The packages that own those calls. */
const GO_STOP_PACKAGES: ReadonlySet<string> = new Set(['os', 'log']);

/** The calls that state a Go helper's collected absence as a failure: the stop calls and fmt's error constructor. */
const GO_FAILURE_MEMBERS: ReadonlySet<string> = new Set(['Errorf', ...GO_STOP_MEMBERS]);

/** The suffixes of the code files this area reads: a code file the facts hold no entry for is still named. */
const CODE_SUFFIXES: readonly string[] = ['.ts', '.tsx', '.mts', '.cts', '.go'];

/** The declared type of the process environment, as `env: NodeJS.ProcessEnv` writes it. */
const PROCESS_ENV_TYPE = 'ProcessEnv';

/** Whether one span holds another, both in one file. */
function contains(outer: SourceSpan, inner: SourceSpan): boolean {
  return outer.path === inner.path && outer.byteStart <= inner.byteStart && inner.byteEnd <= outer.byteEnd;
}

/** Every environment read in every Go and TypeScript file of a declared unit. */
function readSites(t: TreeText, records: Records): EnvRead[] {
  const reads: EnvRead[] = [];
  if (t.facts === undefined) {
    records.gap('.', 'the environment reads require the shared resolved code facts');
    return reads;
  }
  const facts = t.facts;
  const read = new EnvironmentReads(t, facts);
  for (const path of t.tree.paths) {
    // A read counts where a declared unit governs the file: the repository's own
    // modules and packages, never a folder shape (madarch-mwhd.3).
    const service = t.serviceOf(path);
    if (service === undefined) continue;
    const file = t.filesByPath.all(path).at(-1);
    if (file === undefined) {
      // A code file the shared pass could not read has no fact at all: its reads are unknown, and the file is said.
      if (CODE_SUFFIXES.some((suffix) => path.endsWith(suffix))) {
        records.gap(path, 'the reads cannot be listed: the shared code facts hold no fact for the file');
      }
      continue;
    }
    const go = file.language === 'go';
    if (!go && file.language !== 'typescript' && file.language !== 'tsx') continue;
    if (file.parsed !== true) {
      // A file the parser did not read whole has no calls and no member accesses to read a variable off.
      records.gap(path, 'the reads cannot be listed: the file is not parsed');
      continue;
    }
    let found: EnvRead[];
    try {
      found = go ? read.goReads(path, service) : read.typescriptReads(path, service);
    } catch (error) {
      records.gap(path, `the reads cannot be listed: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    reads.push(...found.filter((entry) => VARIABLE_NAME.test(entry.name)));
  }
  return reads.sort((left, right) => byCodePoint(left.path, right.path) || left.line - right.line || byCodePoint(left.name, right.name));
}

/**
 * One tree's environment reads, answered from the shared code facts: a read is
 * a call fact or a member access the facts copied, so a comment, a string or a
 * line that merely spells `process.env.NAME` is no read (madarch-mwhd.3). Every
 * question an expression asks is an index built once for the run — expressions
 * and bindings by id, bindings by name, the Go reads the library evaluation
 * proved, call sites by callee and callables by file — and each file's own
 * expressions are walked once.
 */
class EnvironmentReads {
  private readonly view: CodeFactView;
  private readonly expressions: ReadonlyMap<string, CodeExpressionFact>;
  private readonly bindingsByName = new Map<string, readonly CodeBindingFact[]>();
  private readonly parameterDeclarations = new Map<string, readonly CodeExpressionFact[]>();
  private readonly goEffects = new Map<string, readonly LibraryEffect[]>();
  private readonly callSites = new Map<string, readonly SourceSpan[]>();
  private readonly parents = new Map<string, ReadonlyMap<string, CodeExpressionFact>>();
  private readonly callables = new Map<string, readonly CodeSymbolFact[]>();
  private readonly helperFatality = new Map<string, boolean>();
  private readonly stopCalls = new Map<string, readonly number[]>();

  constructor(private readonly t: TreeText, facts: CodeFacts) {
    this.view = new CodeFactView(facts);
    this.expressions = this.view.expressions;
    const byName = new Map<string, CodeBindingFact[]>();
    for (const binding of facts.bindings) {
      const held = byName.get(`${binding.path}\u0000${binding.name}`);
      if (held === undefined) byName.set(`${binding.path}\u0000${binding.name}`, [binding]);
      else held.push(binding);
    }
    this.bindingsByName = byName;
    // A parameter's declared default and its declared type are what an `env` argument is proved by.
    const declarations = new Map<string, CodeExpressionFact[]>();
    for (const expression of facts.expressions) {
      if (expression.syntaxKind !== 'required_parameter' && expression.syntaxKind !== 'optional_parameter') continue;
      for (const id of expression.fields.pattern ?? []) {
        const bindingId = this.expression(id)?.bindingId;
        if (bindingId === undefined) continue;
        const held = declarations.get(bindingId);
        if (held === undefined) declarations.set(bindingId, [expression]);
        else held.push(expression);
      }
    }
    this.parameterDeclarations = declarations;
    // The Go environment calls are the library evaluation's: the import that proves `os` is `os` is its proof.
    const effects = new Map<string, LibraryEffect[]>();
    for (const effect of t.libraryFacts()?.effects ?? []) {
      if (effect.kind !== 'env-read') continue;
      const held = effects.get(effect.span.path);
      if (held === undefined) effects.set(effect.span.path, [effect]);
      else held.push(effect);
    }
    this.goEffects = effects;
    const sites = new Map<string, SourceSpan[]>();
    for (const site of facts.sites) {
      if (site.use !== 'call') continue;
      const held = sites.get(`${site.path}\u0000${site.to}`);
      if (held === undefined) sites.set(`${site.path}\u0000${site.to}`, [site.span]);
      else held.push(site.span);
    }
    this.callSites = sites;
  }

  /** The reads of one TypeScript file: a direct read of the environment, and a helper call with a static name. */
  typescriptReads(path: string, service: string): EnvRead[] {
    const reads: EnvRead[] = [];
    let stops: boolean | undefined;
    for (const expression of this.t.expressionsByPath.all(path)) {
      if (expression.span.path !== path) continue;
      const direct = this.environmentRead(expression);
      if (direct !== undefined) {
        reads.push({ service, name: direct, path, line: expression.span.lineStart, symbol: this.typescriptSymbol(path, expression.span),
          required: false, default: this.fallbackOf(path, expression) });
        continue;
      }
      const helper = this.helperReadName(expression, HELPER_NAMES.typescript);
      if (helper === undefined) continue;
      // The file's helper is asked for its fatality only where a read goes through it.
      stops ??= this.helperStopsWithoutValue(path);
      reads.push({ service, name: helper, path, line: expression.span.lineStart, symbol: this.typescriptSymbol(path, expression.span),
        required: stops, default: null });
    }
    return reads;
  }

  /** The reads of one Go file: the standard library's environment calls, and a helper call with a static name. */
  goReads(path: string, service: string): EnvRead[] {
    const reads: EnvRead[] = [];
    for (const effect of this.goEffects.get(path) ?? []) {
      const expression = this.expression(effect.expression);
      const argument = effect.arguments.find((entry) => entry.name === 'name')?.expression;
      const name = argument === undefined ? undefined : this.staticText(argument);
      // A name the shared evaluation could not decode is a gap of that evaluation; this area invents no read from it.
      if (expression === undefined || name === undefined) continue;
      reads.push({ service, name, path, line: expression.span.lineStart, symbol: this.goSymbol(path, expression.span),
        required: this.goGuardFails(path, expression), default: null });
    }
    let stops: boolean | undefined;
    for (const expression of this.t.expressionsByPath.all(path)) {
      const helper = this.helperReadName(expression, HELPER_NAMES.go);
      if (helper === undefined) continue;
      stops ??= this.helperStopsWithoutValue(path);
      reads.push({ service, name: helper, path, line: expression.span.lineStart, symbol: this.goSymbol(path, expression.span),
        required: stops, default: null });
    }
    return reads;
  }

  // ---- the reads themselves ---------------------------------------------------

  /** The variable a member or index expression reads off the process environment, when that is what it does. */
  private environmentRead(expression: CodeExpressionFact): string | undefined {
    if (expression.syntaxKind !== 'member_expression' && expression.syntaxKind !== 'subscript_expression') return undefined;
    const selected = this.member(expression);
    return selected?.name !== undefined && this.isEnvironment(selected.receiver) ? selected.name : undefined;
  }

  /** The receiver a member reads off and the name it reads: `x.name`, `x['name']`, and Go's `x.name`. */
  private member(expression: CodeExpressionFact): { readonly receiver: CodeExpressionFact; readonly name?: string } | undefined {
    if (expression.syntaxKind === 'subscript_expression') {
      const receiver = this.field(expression, 'object');
      const index = this.field(expression, 'index');
      if (receiver === undefined || index === undefined) return undefined;
      if (!contains(expression.span, receiver.span) || !contains(expression.span, index.span)) return undefined;
      const value = this.staticText(index.id);
      return { receiver, ...(value === undefined ? {} : { name: value }) };
    }
    const go = expression.syntaxKind === 'selector_expression';
    if (!go && expression.syntaxKind !== 'member_expression') return undefined;
    const receiver = expression.receiver === undefined ? undefined : this.expression(expression.receiver);
    const object = this.field(expression, go ? 'operand' : 'object');
    const property = this.field(expression, go ? 'field' : 'property');
    if (receiver === undefined || expression.member === undefined) return undefined;
    if (receiver.id !== object?.id || expression.member !== property?.name || !contains(expression.span, receiver.span)) return undefined;
    return { receiver, name: expression.member };
  }

  /** Whether a value is the process environment: `process.env`, a local alias of it, or a `ProcessEnv` parameter. */
  private isEnvironment(expression: CodeExpressionFact, seen: Set<string> = new Set()): boolean {
    if (seen.has(expression.id)) return false;
    seen.add(expression.id);
    const selected = this.member(expression);
    if (selected?.name === 'env' && this.isProcessGlobal(selected.receiver)) return true;
    // A member read is only the environment where it reads `env` off the global process.
    if (selected !== undefined) return false;
    const binding = this.bindingOf(expression);
    if (binding === undefined) return false;
    if (binding.kind === 'local') {
      const initializer = binding.initializer === undefined ? undefined : this.expression(binding.initializer);
      return initializer !== undefined && this.isEnvironment(initializer, seen);
    }
    if (binding.kind !== 'parameter') return false;
    for (const declaration of this.parameterDeclarations.get(binding.id) ?? []) {
      const defaulted = this.field(declaration, 'value');
      if (defaulted !== undefined && this.isEnvironment(defaulted, seen)) return true;
      const annotation = this.field(declaration, 'type');
      if (annotation !== undefined && this.namesProcessEnvType(annotation)) return true;
    }
    return false;
  }

  /** The Node global `process`, never a value the repository bound to that name. */
  private isProcessGlobal(expression: CodeExpressionFact): boolean {
    if (expression.syntaxKind !== 'identifier' || expression.name !== 'process') return false;
    const binding = this.bindingOf(expression);
    if (binding === undefined) return !this.reserved(expression.path, 'process', expression.span);
    if (binding.kind !== 'import' || binding.importId === undefined) return false;
    const imported = this.t.importsByPath.all(expression.path).find((entry) => entry.id === binding.importId);
    return imported !== undefined && (imported.specifier === 'process' || imported.specifier === 'node:process');
  }

  /** Whether a binding of that name is in scope where the name stands, so the name is not the global. */
  private reserved(path: string, name: string, span: SourceSpan): boolean {
    return (this.bindingsByName.get(`${path}\u0000${name}`) ?? []).some((binding) => binding.kind !== 'type' && contains(binding.scope, span));
  }

  /** Whether a type annotation names the process environment, as `NodeJS.ProcessEnv` does. */
  private namesProcessEnvType(annotation: CodeExpressionFact, depth = 0): boolean {
    if (annotation.name === PROCESS_ENV_TYPE) return true;
    if (depth >= 8) return false;
    return annotation.children.some((id) => {
      const child = this.expression(id);
      return child !== undefined && this.namesProcessEnvType(child, depth + 1);
    });
  }

  /** The variable a helper call names, when the call fact's one argument is a static string. */
  private helperReadName(expression: CodeExpressionFact, names: readonly string[]): string | undefined {
    const call = this.callOf(expression);
    if (call === undefined || call.arguments.length !== 1) return undefined;
    const callee = this.expression(call.callee);
    if (callee?.syntaxKind !== 'identifier' || callee.name === undefined || !names.includes(callee.name)) return undefined;
    return this.staticText(call.arguments[0]!);
  }

  /** The default a read falls back to: the right side of `??` or `||` applied to it, when it is a static value. */
  private fallbackOf(path: string, expression: CodeExpressionFact): string | null {
    let held = expression;
    for (let round = 0; round < 8; round += 1) {
      const parent = this.parentOf(path, held.id);
      if (parent === undefined) return null;
      if (TRANSPARENT_KINDS.has(parent.syntaxKind)) {
        held = parent;
        continue;
      }
      if (parent.syntaxKind !== 'binary_expression' || (parent.operator !== '??' && parent.operator !== '||')) return null;
      const left = parent.fields.left ?? [];
      if (left.length !== 1 || left[0] !== held.id) return null;
      const right = this.field(parent, 'right');
      return right === undefined ? null : (this.staticText(right.id) ?? null);
    }
    return null;
  }

  // ---- the facts every read asks of ------------------------------------------

  private expression(id: string): CodeExpressionFact | undefined {
    return this.expressions.get(id);
  }

  /** The one child a field holds, when the fact holds exactly one. */
  private field(expression: CodeExpressionFact, name: string): CodeExpressionFact | undefined {
    const ids = expression.fields[name];
    const id = ids?.length === 1 ? ids[0] : undefined;
    return id === undefined ? undefined : this.expression(id);
  }

  /** The binding a name stands for, where the facts prove one in scope at that name. */
  private bindingOf(expression: CodeExpressionFact): CodeBindingFact | undefined {
    const id = expression.bindingId;
    if (id === undefined) return undefined;
    const binding = this.t.bindingsById.all(id).at(-1);
    return binding !== undefined && binding.path === expression.path && contains(binding.scope, expression.span) ? binding : undefined;
  }

  /** A call expression as its call fact records it, never as a second reading of the same syntax. */
  private callOf(expression: CodeExpressionFact): CodeCallFact | undefined {
    if (expression.syntaxKind !== 'call_expression') return undefined;
    const call = this.t.callsByExpression.all(expression.id).at(-1);
    return call !== undefined && call.path === expression.path && call.callee === expression.callee ? call : undefined;
  }

  /** The text a static value stands for: the string, number or boolean the facts decoded, however it is held. */
  private staticText(id: string): string | undefined {
    const value = this.view.value(id);
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    return undefined;
  }

  /** The expression one expression stands in, from the file's own pairs: built once per path. */
  private parentOf(path: string, id: string): CodeExpressionFact | undefined {
    let held = this.parents.get(path);
    if (held === undefined) {
      const pairs = new Map<string, CodeExpressionFact>();
      for (const expression of this.t.expressionsByPath.all(path)) {
        if (expression.span.path !== path) continue;
        for (const child of expression.children) if (!pairs.has(child)) pairs.set(child, expression);
      }
      held = pairs;
      this.parents.set(path, held);
    }
    return held.get(id);
  }

  /** The callable symbols one file declares, in the facts' own order. */
  private callablesOf(path: string): readonly CodeSymbolFact[] {
    const held = this.callables.get(path);
    if (held !== undefined) return held;
    const found = this.t.symbolsByPath.all(path).filter((symbol) => symbol.callable);
    this.callables.set(path, found);
    return found;
  }

  /** The innermost callable of the file a span stands in. */
  private innermost(path: string, span: SourceSpan): CodeSymbolFact | undefined {
    return this.callablesOf(path)
      .filter((symbol) => contains(symbol.span, span))
      .sort((left, right) => (left.span.byteEnd - left.span.byteStart) - (right.span.byteEnd - right.span.byteStart) || byCodePoint(left.key, right.key))[0];
  }

  /** The outermost callable of the file a nested one was written inside: the function a callback belongs to. */
  private outermost(path: string, symbol: CodeSymbolFact): CodeSymbolFact {
    let held = symbol;
    for (let round = 0; round < 8; round += 1) {
      const found = this.callablesOf(path)
        .filter((candidate) => candidate.key !== held.key && contains(candidate.span, held.span) &&
          (candidate.span.byteStart !== held.span.byteStart || candidate.span.byteEnd !== held.span.byteEnd))
        .sort((left, right) => (right.span.byteEnd - right.span.byteStart) - (left.span.byteEnd - left.span.byteStart))[0];
      if (found === undefined) return held;
      held = found;
    }
    return held;
  }

  /** The callable a TypeScript read sits in: the innermost function the facts declare, or none at the top level. */
  private typescriptSymbol(path: string, span: SourceSpan): string {
    return this.innermost(path, span)?.name ?? '';
  }

  /**
   * The symbol a Go read sits behind: its enclosing function, climbed to the
   * exported (or main) function of the file that calls it — the entry whose
   * failure stops the startup.
   */
  private goSymbol(path: string, span: SourceSpan): string {
    const enclosing = this.innermost(path, span);
    if (enclosing === undefined) return '';
    const entry = this.outermost(path, enclosing);
    if (!startsLower(entry.name) || entry.name === 'main') return entry.name;
    const climbers: string[] = [];
    for (const site of this.callSites.get(`${path}\u0000${entry.key}`) ?? []) {
      const owner = this.innermost(path, site);
      const caller = owner === undefined ? undefined : this.outermost(path, owner);
      if (caller === undefined || caller.key === entry.key) continue;
      if (startsLower(caller.name) && caller.name !== 'main') continue;
      climbers.push(caller.name);
    }
    climbers.sort(byCodePoint);
    return climbers[0] ?? entry.name;
  }

  /** Whether the Go read's own function stops the program after it reads an empty value. */
  private goGuardFails(path: string, expression: CodeExpressionFact): boolean {
    const body = this.innermost(path, expression.span)?.bodySpan;
    if (body === undefined) return false;
    return this.stopCallsOf(path).some((start) => expression.span.byteStart < start && start < body.byteEnd);
  }

  /** The byte offsets of the calls that stop a Go program, in one file. */
  private stopCallsOf(path: string): readonly number[] {
    const held = this.stopCalls.get(path);
    if (held !== undefined) return held;
    const found: number[] = [];
    for (const expression of this.t.expressionsByPath.all(path)) {
      const call = this.callOf(expression);
      const callee = call === undefined ? undefined : this.expression(call.callee);
      const selected = callee === undefined ? undefined : this.member(callee);
      if (selected?.name === undefined || !GO_STOP_MEMBERS.has(selected.name)) continue;
      if (!this.isPackage(selected.receiver, GO_STOP_PACKAGES)) continue;
      found.push(expression.span.byteStart);
    }
    const sorted = found.sort((left, right) => left - right);
    this.stopCalls.set(path, sorted);
    return sorted;
  }

  /** Whether a value names one of those standard packages, imported under that name. */
  private isPackage(expression: CodeExpressionFact, names: ReadonlySet<string>): boolean {
    const name = expression.syntaxKind === 'identifier' ? expression.name : undefined;
    if (name === undefined || !names.has(name)) return false;
    const binding = this.bindingOf(expression);
    if (binding === undefined) return true;
    if (binding.kind !== 'import' || binding.importId === undefined) return false;
    const imported = this.t.importsByPath.all(expression.path).find((entry) => entry.id === binding.importId);
    return imported !== undefined && imported.specifier === name;
  }

  /**
   * Whether the file's helper turns an absent variable into a stopped program:
   * it grows a list of the absent names, and the file itself throws (TypeScript)
   * or reports the failure (Go). The file's own calls and throw statements say
   * so, so a comment that spells `missing.push(...)` no longer does.
   */
  private helperStopsWithoutValue(path: string): boolean {
    const held = this.helperFatality.get(path);
    if (held !== undefined) return held;
    const go = this.t.filesByPath.all(path).at(-1)?.language === 'go';
    let collects = false;
    let fails = false;
    for (const expression of this.t.expressionsByPath.all(path)) {
      if (!go && expression.syntaxKind === 'throw_statement') fails = true;
      const call = this.callOf(expression);
      const callee = call === undefined ? undefined : this.expression(call.callee);
      if (callee === undefined) continue;
      const selected = this.member(callee);
      const name = selected?.name ?? (callee.syntaxKind === 'identifier' ? callee.name : undefined);
      if (name === undefined) continue;
      if (!go && name === 'push' && this.growsLocalList(selected?.receiver)) collects = true;
      if (!go) continue;
      if (name === 'append') collects = true;
      if (name === 'panic' || GO_FAILURE_MEMBERS.has(name)) fails = true;
    }
    const stops = collects && fails;
    this.helperFatality.set(path, stops);
    return stops;
  }

  /** Whether a value is the local list the absent names are collected in: a binding of an array literal. */
  private growsLocalList(expression: CodeExpressionFact | undefined): boolean {
    if (expression === undefined) return false;
    const binding = this.bindingOf(expression);
    const initializer = binding?.kind === 'local' && binding.initializer !== undefined ? this.expression(binding.initializer) : undefined;
    return initializer?.syntaxKind === 'array' || initializer?.syntaxKind === 'new_expression';
  }
}

/** Whether a name starts lower case: an unexported Go function. */
function startsLower(name: string): boolean {
  const first = name.charAt(0);
  return first !== '' && first !== first.toUpperCase();
}

// ---- the definition sites ---------------------------------------------------

/** One definition of one variable, with the value it sets and the service it scopes to. */
interface EnvDefinition {
  readonly key: string;
  readonly name: string;
  readonly scope: string | null;
  readonly value: string | null;
  /** True when the definition is explicitly a secret, not a setting that happens to look like one. */
  readonly secret?: boolean;
  readonly span: ReturnType<TreeText['spanOfLine']>;
}

/** The first place one character stands in a string: one comparison per character, never a search pattern. */
function firstCharacter(text: string, character: string): number {
  for (let at = 0; at < text.length; at += 1) if (text[at] === character) return at;
  return -1;
}

/** The definitions in the .env.example files, as NAME=value lines. */
function envExampleDefinitions(t: TreeText): EnvDefinition[] {
  const definitions: EnvDefinition[] = [];
  for (const path of t.pathsNamed(/^\.env\.example$/)) {
    t.lines(path).forEach((line, index) => {
      // A dotenv line is a name and a value around one `=`: no pattern reads the line, and a comment or a foreign
      // line has no name of that shape.
      const at = firstCharacter(line, '=');
      if (at < 0) return;
      const name = line.slice(0, at).trim();
      if (!isDotenvName(name)) return;
      const value = line.slice(at + 1).trim();
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

/** Whether a dotenv name is a word: letters, digits and underscores, not starting with a digit. */
function isDotenvName(name: string): boolean {
  for (const [index, character] of [...name].entries()) {
    const letter = (character >= 'a' && character <= 'z') || (character >= 'A' && character <= 'Z');
    const digit = character >= '0' && character <= '9';
    if (!letter && !digit && character !== '_') return false;
    if (index === 0 && digit) return false;
  }
  return name !== '';
}

/** The env: entries of YAML that set an explicit value, as in deploy/k8s. */
function yamlEnvDefinitions(t: TreeText, records: Records, path: string): EnvDefinition[] {
  const definitions: EnvDefinition[] = [];
  const lineCounter = new LineCounter();
  const documents = parseAllDocuments(t.text(path), { lineCounter, keepSourceTokens: true });
  const visit = (node: unknown): void => {
    if (!isMap(node)) return;
    // A Kubernetes Secret is an explicit secret fact: its values are secrets by what the file declares, not by
    // how often a value repeats. `stringData` holds plain text; `data` holds the same values in base64.
    const kind = node.items.find((pair) => isScalar(pair.key) && pair.key.value === 'kind')?.value;
    if (isScalar(kind) && kind.value === 'Secret') {
      const metadata = node.items.find((pair) => isScalar(pair.key) && pair.key.value === 'metadata')?.value;
      const secretName = isMap(metadata) ? metadata.items.find((pair) => isScalar(pair.key) && pair.key.value === 'name')?.value : undefined;
      const scope = isScalar(secretName) && typeof secretName.value === 'string' ? secretName.value : 'secret';
      for (const field of ['stringData', 'data']) {
        const held = node.items.find((pair) => isScalar(pair.key) && pair.key.value === field)?.value;
        if (!isMap(held)) continue;
        for (const pair of held.items) {
          if (!isScalar(pair.key) || typeof pair.key.value !== 'string' || !isScalar(pair.value) || pair.value.value === null) continue;
          const line = lineCounter.linePos(pair.key.range?.[0] ?? 0).line;
          definitions.push({
            key: `code.env-definition:${path}#${scope}/${pair.key.value}`,
            name: pair.key.value,
            scope: null,
            value: String(pair.value.value),
            secret: true,
            span: t.spanOfLine(path, line),
          });
        }
      }
    }
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
  for (const document of documents) {
    for (const error of document.errors) {
      records.gap(path, `line ${lineCounter.linePos(error.pos?.[0] ?? 0).line}: ${error.message}`);
    }
    visit(document.contents);
  }
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
    definitions.push(...yamlEnvDefinitions(t, records, path));
  }

  for (const [variable, sites] of [...byVariable].sort((left, right) => byCodePoint(left[0], right[0]))) {
    const required = sites.some((read) => read.required);
    const defaults = [...new Set(sites.map((read) => read.default).filter((value): value is string => value !== null))].sort(byCodePoint);
    const first = sites[0];
    if (first === undefined) continue;
    records.add({
      key: `code.env-var:${variable}`,
      kind: ENVIRONMENT_VALUE_RECORDS.variable.key,
      label: variable.slice(variable.indexOf('/') + 1),
      properties: { required, [ENVIRONMENT_VALUE_RECORDS.variable.field]: defaults[0] ?? null } satisfies { [key: string]: PropertyValue },
      span: t.spanOfLine(first.path, first.line),
    });
    for (const read of sites) {
      records.edge(
        ENVIRONMENT_VALUE_RECORDS.read.key,
        records.file(read.path),
        `code.env-var:${variable}`,
        { symbol: read.symbol, required: read.required, [ENVIRONMENT_VALUE_RECORDS.read.field]: read.default },
        t.spanOfLine(read.path, read.line),
      );
    }
  }
  for (const definition of definitions.sort((left, right) => byCodePoint(left.key, right.key))) {
    // A definition is labelled by the service it gives the variable to and by the file it stands in: `.env.example`
    // and the compose file define DATABASE_URL for orders, payments and promotions, and a list shows each row once
    // (madarch-m38l.16).
    const where = definition.span?.path;
    const label = [definition.name, definition.scope, where].filter((part): part is string => typeof part === 'string' && part !== '').join(' · ');
    records.add({
      key: definition.key,
      kind: ENVIRONMENT_VALUE_RECORDS.definition.key,
      label,
      properties: { [ENVIRONMENT_VALUE_RECORDS.definition.field]: definition.value, ...(definition.scope === null ? {} : {scope: definition.scope}), ...(definition.secret === true ? { secret: true } : {}) },
      span: definition.span,
    });
    // The file that gives the variable its value is the definition's own place in the code, whether or not the code
    // reads the variable: `.env.example` and a compose file connect through it (madarch-m38l.16).
    if (where !== undefined) records.edge('code.defined-in', definition.key, records.file(where), {}, definition.span);
    if (definition.scope === null) continue;
    const variable = `${definition.scope}/${definition.name}`;
    if (!byVariable.has(variable)) continue;
    records.edge(ENVIRONMENT_VALUE_RECORDS.defines.key, definition.key, `code.env-var:${variable}`, { [ENVIRONMENT_VALUE_RECORDS.defines.field]: definition.value }, definition.span);
  }
  return byVariable;
}