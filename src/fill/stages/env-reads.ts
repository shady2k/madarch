/**
 * The environment reads of one file (madarch-8bdc.2.4; decision 0033, items 5,
 * 14 and 15): what a TypeScript or Go file reads from the process environment,
 * with the variable's name, the callable the read stands in, whether the program
 * stops without it, and the default the read falls back to.
 *
 * **Why this module exists.** The extract driver's environment area walks one
 * tree's `CodeFacts` (`src/extract/operations/env.ts`, `EnvironmentReads`): every
 * file's expressions, bindings, call sites, parameter declarations and library
 * effects, indexed once for the whole tree. A static unit may hold none of that
 * (item 5), so this module asks the same questions of one file's facts as the
 * graph publishes them — its expressions, its bindings, its calls and its
 * callables by property, and the library effects the library reader proves for
 * it — and answers the same reads.
 *
 * **What a read is.** A member read off the process environment
 * (`process.env.NAME`, `process.env['NAME']`, an `env` argument typed
 * `NodeJS.ProcessEnv` or defaulted to `process.env`), a helper call whose one
 * argument is a static name (`require("NAME")`, `required("NAME")`), and a Go
 * call the library evaluation proves reads the environment. A name that is not
 * upper case is no variable, and the callers filter that, as the driver does.
 */
import type { LibraryEffect } from '../../extract/library-models/model.js';

/** Where a fact stands: bytes and lines, as every fact of the fill carries them. */
interface EnvSpan {
  readonly path: string;
  readonly byteStart: number;
  readonly byteEnd: number;
  readonly lineStart: number;
  readonly lineEnd: number;
}

/** One expression a file's facts hold. */
export interface EnvExpression {
  readonly id: string;
  readonly syntaxKind: string;
  readonly span: EnvSpan;
  readonly children: readonly string[];
  readonly fields: Readonly<Record<string, readonly string[]>>;
  readonly operator?: string;
  readonly name?: string;
  readonly receiver?: string;
  readonly member?: string;
  readonly callee?: string;
  readonly arguments?: readonly string[];
  readonly bindingId?: string;
  readonly literal?: { readonly kind: string; readonly raw: string; readonly value?: string | number | boolean | null };
}

/** One binding a declaration makes. */
export interface EnvBinding {
  readonly id: string;
  readonly name: string;
  readonly kind: 'import' | 'parameter' | 'local' | 'receiver' | 'type';
  readonly span: EnvSpan;
  readonly scope: EnvSpan;
  readonly initializer?: string;
  readonly importId?: string;
  readonly specifier?: string;
  readonly form?: 'default' | 'namespace' | 'named';
  readonly importedName?: string;
  readonly targetPath?: string;
}

/** One call site. */
export interface EnvCall {
  readonly id: string;
  readonly expression: string;
  readonly span: EnvSpan;
  readonly callee?: string;
  readonly arguments: readonly string[];
  readonly construct: boolean;
}

/** One callable a file declares, as the code facts name it. */
interface EnvCallable {
  readonly key: string;
  readonly name: string;
  readonly qualifiedName: string;
  readonly span: EnvSpan;
  readonly bodySpan?: EnvSpan;
}

/** What one file's facts give the reader. */
export interface EnvFileFacts {
  readonly path: string;
  readonly language: 'go' | 'typescript';
  /** The unit the file belongs to: the service a read is scoped to. */
  readonly service: string;
  readonly expressions: readonly EnvExpression[];
  readonly bindings: readonly EnvBinding[];
  readonly calls: readonly EnvCall[];
  readonly callables: readonly EnvCallable[];
  readonly effects: readonly LibraryEffect[];
}

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

/**
 * The standard library's own environment calls, by the member the call reaches:
 * the two the library models name (`os.Getenv`, `os.LookupEnv`, `models.json`).
 */
const GO_ENVIRONMENT_MEMBERS: ReadonlySet<string> = new Set(['Getenv', 'LookupEnv']);

/** The package those calls belong to. */
const GO_ENVIRONMENT_PACKAGE = 'os';

/** The declared type of the process environment, as `env: NodeJS.ProcessEnv` writes it. */
const PROCESS_ENV_TYPE = 'ProcessEnv';

/** Whether one span holds another, both in one file. */
function holds(outer: EnvSpan, inner: EnvSpan): boolean {
  return outer.path === inner.path && outer.byteStart <= inner.byteStart && inner.byteEnd <= outer.byteEnd;
}

/** Whether a name starts lower case: an unexported Go function. */
function startsLower(name: string): boolean {
  const first = name.charAt(0);
  return first !== '' && first !== first.toUpperCase();
}

/**
 * One file's environment reads, answered from the facts the graph publishes:
 * the driver's `EnvironmentReads`, one file at a time, and never a tree.
 */
export function envReadsOf(facts: EnvFileFacts): readonly EnvRead[] {
  const reader = new FileEnvironmentReads(facts);
  const reads = facts.language === 'go' ? reader.goReads() : reader.typescriptReads();
  return [...reads].sort((left, right) => (left.line - right.line) || (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
}

/** One file's reads, and the questions they ask of its own facts. */
class FileEnvironmentReads {
  private readonly expressions: ReadonlyMap<string, EnvExpression>;
  private readonly bindingsById = new Map<string, EnvBinding>();
  private readonly bindingsByName = new Map<string, readonly EnvBinding[]>();
  private readonly parameterDeclarations = new Map<string, readonly EnvExpression[]>();
  private readonly callByExpression = new Map<string, EnvCall>();
  private readonly childrenOf = new Map<string, EnvExpression>();
  private helperFatality: boolean | undefined;
  private stopCalls: readonly number[] | undefined;

  constructor(private readonly facts: EnvFileFacts) {
    this.expressions = new Map(facts.expressions.map((expression) => [expression.id, expression]));
    const byName = new Map<string, EnvBinding[]>();
    for (const binding of facts.bindings) {
      this.bindingsById.set(binding.id, binding);
      const held = byName.get(binding.name);
      if (held === undefined) byName.set(binding.name, [binding]);
      else held.push(binding);
    }
    this.bindingsByName = byName;
    // A parameter's declared default and its declared type are what an `env` argument is proved by.
    const declarations = new Map<string, EnvExpression[]>();
    for (const expression of facts.expressions) {
      if (expression.syntaxKind !== 'required_parameter' && expression.syntaxKind !== 'optional_parameter') continue;
      for (const id of expression.fields['pattern'] ?? []) {
        const bindingId = this.expression(id)?.bindingId;
        if (bindingId === undefined) continue;
        const held = declarations.get(bindingId);
        if (held === undefined) declarations.set(bindingId, [expression]);
        else held.push(expression);
      }
    }
    this.parameterDeclarations = declarations;
    for (const call of facts.calls) this.callByExpression.set(call.expression, call);
    for (const expression of facts.expressions) {
      for (const child of expression.children) if (!this.childrenOf.has(child)) this.childrenOf.set(child, expression);
    }
  }

  /** The reads of one TypeScript file: a direct read of the environment, and a helper call with a static name. */
  typescriptReads(): EnvRead[] {
    const reads: EnvRead[] = [];
    const path = this.facts.path;
    const service = this.facts.service;
    for (const expression of this.facts.expressions) {
      if (expression.span.path !== path) continue;
      const direct = this.environmentRead(expression);
      if (direct !== undefined) {
        reads.push({ service, name: direct, path, line: expression.span.lineStart, symbol: this.typescriptSymbol(expression.span), required: false, default: this.fallbackOf(expression) });
        continue;
      }
      const helper = this.helperReadName(expression, HELPER_NAMES.typescript);
      if (helper === undefined) continue;
      reads.push({ service, name: helper, path, line: expression.span.lineStart, symbol: this.typescriptSymbol(expression.span), required: this.helperStopsWithoutValue(), default: null });
    }
    return reads;
  }

  /** The reads of one Go file: the standard library's environment calls, and a helper call with a static name. */
  goReads(): EnvRead[] {
    const reads: EnvRead[] = [];
    const path = this.facts.path;
    const service = this.facts.service;
    const proved = new Set<number>();
    for (const effect of this.facts.effects) {
      if (effect.kind !== 'env-read') continue;
      const expression = this.expression(effect.expression);
      const argument = effect.arguments.find((entry) => entry.name === 'name')?.expression;
      const name = argument === undefined ? undefined : this.staticText(argument);
      if (expression === undefined || name === undefined) continue;
      proved.add(expression.span.byteStart);
      reads.push({ service, name, path, line: expression.span.lineStart, symbol: this.goSymbol(expression.span), required: this.goGuardFails(expression), default: null });
    }
    // The standard library's own two calls, read from the file's facts where the library
    // evaluation proves none: `os.Getenv("NAME")` and `os.LookupEnv("NAME")`, whose `os` is
    // the package the file imports under that name — the rule the models name.
    for (const expression of this.facts.expressions) {
      if (proved.has(expression.span.byteStart)) continue;
      const call = this.callOf(expression);
      if (call === undefined || call.arguments.length !== 1) continue;
      const callee = call.callee === undefined ? undefined : this.expression(call.callee);
      const selected = callee === undefined ? undefined : this.member(callee);
      if (selected?.name === undefined || !GO_ENVIRONMENT_MEMBERS.has(selected.name)) continue;
      if (!this.isPackage(selected.receiver, new Set([GO_ENVIRONMENT_PACKAGE]))) continue;
      const name = this.staticText(call.arguments[0]!);
      if (name === undefined) continue;
      reads.push({ service, name, path, line: expression.span.lineStart, symbol: this.goSymbol(expression.span), required: this.goGuardFails(expression), default: null });
    }
    for (const expression of this.facts.expressions) {
      const helper = this.helperReadName(expression, HELPER_NAMES.go);
      if (helper === undefined) continue;
      reads.push({ service, name: helper, path, line: expression.span.lineStart, symbol: this.goSymbol(expression.span), required: this.helperStopsWithoutValue(), default: null });
    }
    return reads;
  }

  // ---- the reads themselves ---------------------------------------------------

  /** The variable a member or index expression reads off the process environment, when that is what it does. */
  private environmentRead(expression: EnvExpression): string | undefined {
    if (expression.syntaxKind !== 'member_expression' && expression.syntaxKind !== 'subscript_expression') return undefined;
    const selected = this.member(expression);
    return selected?.name !== undefined && this.isEnvironment(selected.receiver) ? selected.name : undefined;
  }

  /** The receiver a member reads off and the name it reads: `x.name`, `x['name']`, and Go's `x.name`. */
  private member(expression: EnvExpression): { readonly receiver: EnvExpression; readonly name?: string } | undefined {
    if (expression.syntaxKind === 'subscript_expression') {
      const receiver = this.field(expression, 'object');
      const index = this.field(expression, 'index');
      if (receiver === undefined || index === undefined) return undefined;
      if (!holds(expression.span, receiver.span) || !holds(expression.span, index.span)) return undefined;
      const value = this.staticText(index.id);
      return { receiver, ...(value === undefined ? {} : { name: value }) };
    }
    const go = expression.syntaxKind === 'selector_expression';
    if (!go && expression.syntaxKind !== 'member_expression') return undefined;
    const receiver = expression.receiver === undefined ? undefined : this.expression(expression.receiver);
    const object = this.field(expression, go ? 'operand' : 'object');
    const property = this.field(expression, go ? 'field' : 'property');
    if (receiver === undefined || expression.member === undefined) return undefined;
    if (receiver.id !== object?.id || expression.member !== property?.name || !holds(expression.span, receiver.span)) return undefined;
    return { receiver, name: expression.member };
  }

  /** Whether a value is the process environment: `process.env`, a local alias of it, or a `ProcessEnv` parameter. */
  private isEnvironment(expression: EnvExpression, seen: Set<string> = new Set()): boolean {
    if (seen.has(expression.id)) return false;
    seen.add(expression.id);
    const selected = this.member(expression);
    if (selected?.name === 'env' && this.isProcessGlobal(selected.receiver)) return true;
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
  private isProcessGlobal(expression: EnvExpression): boolean {
    if (expression.syntaxKind !== 'identifier' || expression.name !== 'process') return false;
    const binding = this.bindingOf(expression);
    if (binding === undefined) return !this.reserved('process', expression.span);
    if (binding.kind !== 'import') return false;
    return binding.specifier === 'process' || binding.specifier === 'node:process';
  }

  /** Whether a binding of that name is in scope where the name stands, so the name is not the global. */
  private reserved(name: string, span: EnvSpan): boolean {
    return (this.bindingsByName.get(name) ?? []).some((binding) => binding.kind !== 'type' && holds(binding.scope, span));
  }

  /** Whether a type annotation names the process environment, as `NodeJS.ProcessEnv` does. */
  private namesProcessEnvType(annotation: EnvExpression, depth = 0): boolean {
    if (annotation.name === PROCESS_ENV_TYPE) return true;
    if (depth >= 8) return false;
    return annotation.children.some((id) => {
      const child = this.expression(id);
      return child !== undefined && this.namesProcessEnvType(child, depth + 1);
    });
  }

  /** The variable a helper call names, when the call fact's one argument is a static string. */
  private helperReadName(expression: EnvExpression, names: readonly string[]): string | undefined {
    const call = this.callOf(expression);
    if (call === undefined || call.arguments.length !== 1) return undefined;
    const callee = call.callee === undefined ? undefined : this.expression(call.callee);
    if (callee?.syntaxKind !== 'identifier' || callee.name === undefined || !names.includes(callee.name)) return undefined;
    return this.staticText(call.arguments[0]!);
  }

  /** The default a read falls back to: the right side of `??` or `||` applied to it, when it is a static value. */
  private fallbackOf(expression: EnvExpression): string | null {
    let held = expression;
    for (let round = 0; round < 8; round += 1) {
      const parent = this.childrenOf.get(held.id);
      if (parent === undefined) return null;
      if (TRANSPARENT_KINDS.has(parent.syntaxKind)) {
        held = parent;
        continue;
      }
      if (parent.syntaxKind !== 'binary_expression' || (parent.operator !== '??' && parent.operator !== '||')) return null;
      const left = parent.fields['left'] ?? [];
      if (left.length !== 1 || left[0] !== held.id) return null;
      const right = this.field(parent, 'right');
      return right === undefined ? null : (this.staticText(right.id) ?? null);
    }
    return null;
  }

  // ---- the facts every read asks of ------------------------------------------

  private expression(id: string): EnvExpression | undefined {
    return this.expressions.get(id);
  }

  /** The one child a field holds, when the fact holds exactly one. */
  private field(expression: EnvExpression, name: string): EnvExpression | undefined {
    const ids = expression.fields[name];
    const id = ids?.length === 1 ? ids[0] : undefined;
    return id === undefined ? undefined : this.expression(id);
  }

  /** The binding a name stands for, where the facts prove one in scope at that name. */
  private bindingOf(expression: EnvExpression): EnvBinding | undefined {
    const id = expression.bindingId;
    if (id === undefined) return undefined;
    const binding = this.bindingsById.get(id);
    return binding !== undefined && holds(binding.scope, expression.span) ? binding : undefined;
  }

  /** A call expression as its call fact records it, never as a second reading of the same syntax. */
  private callOf(expression: EnvExpression): EnvCall | undefined {
    if (expression.syntaxKind !== 'call_expression') return undefined;
    const call = this.callByExpression.get(expression.id);
    return call !== undefined && call.callee === expression.callee ? call : undefined;
  }

  /** The text a static value stands for: the string, number or boolean the facts decoded, however it is held. */
  private staticText(id: string, seen: Set<string> = new Set()): string | undefined {
    const value = this.valueOf(id, seen);
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    return undefined;
  }

  /** The value one expression holds: its literal, or the initializer of the binding it names. */
  private valueOf(id: string, seen: Set<string>): unknown {
    if (seen.has(id)) return undefined;
    seen.add(id);
    const expression = this.expressions.get(id);
    if (expression === undefined) return undefined;
    if (expression.literal !== undefined) return expression.literal.value;
    if (expression.bindingId !== undefined) {
      const binding = this.bindingsById.get(expression.bindingId);
      return binding?.kind === 'local' && binding.initializer !== undefined ? this.valueOf(binding.initializer, seen) : undefined;
    }
    if (['parenthesized_expression', 'as_expression', 'satisfies_expression', 'non_null_expression', 'literal_element'].includes(expression.syntaxKind)) {
      return expression.children.length === 1 ? this.valueOf(expression.children[0]!, seen) : undefined;
    }
    return undefined;
  }

  /** The callable symbols one file declares, in the facts' own order. */
  private callablesOf(): readonly EnvCallable[] {
    return this.facts.callables;
  }

  /** The innermost callable of the file a span stands in. */
  private innermost(span: EnvSpan): EnvCallable | undefined {
    return this.callablesOf()
      .filter((callable) => holds(callable.span, span))
      .sort((left, right) => ((left.span.byteEnd - left.span.byteStart) - (right.span.byteEnd - right.span.byteStart)) || (left.key < right.key ? -1 : left.key > right.key ? 1 : 0))[0];
  }

  /** The outermost callable of the file a nested one was written inside: the function a callback belongs to. */
  private outermost(callable: EnvCallable): EnvCallable {
    let held = callable;
    for (let round = 0; round < 8; round += 1) {
      const found = this.callablesOf()
        .filter((candidate) => candidate.key !== held.key && holds(candidate.span, held.span) &&
          (candidate.span.byteStart !== held.span.byteStart || candidate.span.byteEnd !== held.span.byteEnd))
        .sort((left, right) => (right.span.byteEnd - right.span.byteStart) - (left.span.byteEnd - left.span.byteStart))[0];
      if (found === undefined) return held;
      held = found;
    }
    return held;
  }

  /** The callable a TypeScript read sits in: the innermost function the facts declare, or none at the top level. */
  private typescriptSymbol(span: EnvSpan): string {
    return this.innermost(span)?.name ?? '';
  }

  /**
   * The symbol a Go read sits behind: its enclosing function, climbed to the
   * exported (or main) function of the file that calls it — the entry whose
   * failure stops the startup.
   */
  private goSymbol(span: EnvSpan): string {
    const enclosing = this.innermost(span);
    if (enclosing === undefined) return '';
    const entry = this.outermost(enclosing);
    if (!startsLower(entry.name) || entry.name === 'main') return entry.name;
    const climbers: string[] = [];
    for (const site of this.callSitesOf(entry)) {
      const owner = this.innermost(site);
      const caller = owner === undefined ? undefined : this.outermost(owner);
      if (caller === undefined || caller.key === entry.key) continue;
      if (startsLower(caller.name) && caller.name !== 'main') continue;
      climbers.push(caller.name);
    }
    climbers.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
    return climbers[0] ?? entry.name;
  }

  /** The places one file's callables call a named function, by the callee's own name. */
  private callSitesOf(entry: EnvCallable): readonly EnvSpan[] {
    const sites: EnvSpan[] = [];
    for (const expression of this.facts.expressions) {
      const call = this.callOf(expression);
      if (call === undefined) continue;
      const callee = call.callee === undefined ? undefined : this.expression(call.callee);
      const name = callee?.syntaxKind === 'identifier' ? callee.name : undefined;
      if (name === undefined || name !== entry.name) continue;
      sites.push(expression.span);
    }
    return sites.sort((left, right) => left.byteStart - right.byteStart);
  }

  /** Whether the Go read's own function stops the program after it reads an empty value. */
  private goGuardFails(expression: EnvExpression): boolean {
    const body = this.innermost(expression.span)?.bodySpan;
    if (body === undefined) return false;
    return this.stopCallsOf().some((start) => expression.span.byteStart < start && start < body.byteEnd);
  }

  /** The byte offsets of the calls that stop a Go program, in one file. */
  private stopCallsOf(): readonly number[] {
    if (this.stopCalls !== undefined) return this.stopCalls;
    const found: number[] = [];
    for (const expression of this.facts.expressions) {
      const call = this.callOf(expression);
      const callee = call === undefined || call.callee === undefined ? undefined : this.expression(call.callee);
      const selected = callee === undefined ? undefined : this.member(callee);
      if (selected?.name === undefined || !GO_STOP_MEMBERS.has(selected.name)) continue;
      if (!this.isPackage(selected.receiver, GO_STOP_PACKAGES)) continue;
      found.push(expression.span.byteStart);
    }
    this.stopCalls = found.sort((left, right) => left - right);
    return this.stopCalls;
  }

  /** Whether a value names one of those standard packages, imported under that name. */
  private isPackage(expression: EnvExpression, names: ReadonlySet<string>): boolean {
    const name = expression.syntaxKind === 'identifier' ? expression.name : undefined;
    if (name === undefined || !names.has(name)) return false;
    const binding = this.bindingOf(expression);
    if (binding === undefined) return true;
    if (binding.kind !== 'import') return false;
    return binding.specifier === name;
  }

  /**
   * Whether the file's helper turns an absent variable into a stopped program:
   * it grows a list of the absent names, and the file itself throws (TypeScript)
   * or reports the failure (Go).
   */
  private helperStopsWithoutValue(): boolean {
    if (this.helperFatality !== undefined) return this.helperFatality;
    const go = this.facts.language === 'go';
    let collects = false;
    let fails = false;
    for (const expression of this.facts.expressions) {
      if (!go && expression.syntaxKind === 'throw_statement') fails = true;
      const call = this.callOf(expression);
      const callee = call === undefined || call.callee === undefined ? undefined : this.expression(call.callee);
      if (callee === undefined) continue;
      const selected = this.member(callee);
      const name = selected?.name ?? (callee.syntaxKind === 'identifier' ? callee.name : undefined);
      if (name === undefined) continue;
      if (!go && name === 'push' && this.growsLocalList(selected?.receiver)) collects = true;
      if (!go) continue;
      if (name === 'append') collects = true;
      if (name === 'panic' || GO_FAILURE_MEMBERS.has(name)) fails = true;
    }
    this.helperFatality = collects && fails;
    return this.helperFatality;
  }

  /** Whether a value is the local list the absent names are collected in: a binding of an array literal. */
  private growsLocalList(expression: EnvExpression | undefined): boolean {
    if (expression === undefined) return false;
    const binding = this.bindingOf(expression);
    const initializer = binding?.kind === 'local' && binding.initializer !== undefined ? this.expression(binding.initializer) : undefined;
    return initializer?.syntaxKind === 'array' || initializer?.syntaxKind === 'new_expression';
  }
}
