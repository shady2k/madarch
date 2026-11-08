
/**
 * The observability records of one code file — its loggers, its metrics, the
 * HTTP routes it registers and the health endpoints those serve — read from the
 * code facts the code-facts stage published (decision 0033, items 5, 14 and 15;
 * madarch-8bdc.2.4).
 *
 * **What the extract driver reads, and how this reads it.** The driver's
 * observability area runs three readers over one whole tree: `loggers()` over
 * the library effects of every file, `healthEndpoints()` over
 * `structuralHttpRegistrations(t)`, and `extractMetrics()` over the same
 * registrations and the effects of the metric models. Every record it makes
 * stands in one file's bytes, so every record can be read from that file's own
 * facts — which is what this module does. The library effects come from the one
 * evaluator both readings run (`evaluateLibraryModels`), fed one file's own
 * facts and the facts its imports reach, through `libraryEffectsOf`.
 *
 * **What a unit cannot answer on its own.** A route registered in one file may
 * serve a handler declared in another, and a service's metric endpoint is one
 * file's registration joined to another file's exposition. Those records name
 * two files at once, so this module answers the routes and expositions a file
 * declares, and the links stage joins them once every code file has published.
 */
import { byCodePoint } from '../../model/order.js';
import type { LibraryEffect } from '../../extract/library-models/model.js';
import { metricSemanticModels, type MetricSemanticModel } from '../../extract/library-models/metric-semantic-models.js';
import { httpModels, type HttpModel, type HttpRole } from '../../extract/library-models/http-models.js';
import { parsePrometheusText, type PrometheusTextResult } from '../../extract/library-models/prometheus-text.js';
import type { FileLibraryEffects } from './library-effects.js';
import {
  callableSymbolKeyOf, contains, fieldSymbolKeyOf, same, unique,
  type CallableNode, type CodeFactIndex, type ExpressionNode, type FactSpan,
} from './operations-code-facts.js';

/** The paths the reading claims as health endpoints, exactly as the driver's own set. */
export const HEALTH_PATHS: ReadonlySet<string> = new Set(['/health', '/healthz', '/ready', '/readyz', '/live', '/livez', '/startup', '/startupz']);

/** Where a record goes: one unit's record set. */
export interface ObservabilityWriter {
  add(key: string, kind: string, label: string, properties: Readonly<Record<string, unknown>>, span: FactSpan): void;
  edge(type: string, from: string, to: string, properties: Readonly<Record<string, unknown>>, span: FactSpan, discriminator?: string): void;
  gap(path: string, reason: string): void;
}

/** One route a file registers: the registration's own place, and the facts a later join needs. */
interface HttpRouteRecord {
  readonly span: FactSpan;
  readonly path: string;
  readonly method: string;
  readonly ports: readonly string[];
  /** The unit the registering file belongs to. */
  readonly service: string;
  /** The unit's whole declared identity (a `go.mod`'s module path, a `package.json`'s name). */
  readonly manifest: string;
  /** The handler the registration names, by the key the extract readings give it. */
  readonly handlerKey: string;
  /** The identity the endpoint's key carries: the handler's receiver type, or its qualified name. */
  readonly handlerIdentity: string;
  /** The file the handler is declared in, and where it stands there. */
  readonly handlerPath: string;
  readonly handlerSpan: FactSpan;
  readonly handlerExpression: string;
  readonly receiverExpression: string;
  /** Whether the handler answers with a literal `ok`, which is what a health endpoint's status says. */
  readonly statusOk: boolean;
}

/** One exposition a file writes: the metrics it exposes and the evidence of the effect that writes it. */
interface MetricExpositionRecord {
  readonly span: FactSpan;
  /** The callable whose body writes the exposition. */
  readonly holder: string;
  readonly writerBinding: string;
  /** The metric keys the exposition exposes, in code point order. */
  readonly metrics: readonly string[];
  readonly format: string;
  readonly evidence: Readonly<Record<string, unknown>>;
  readonly receiverExpression?: string;
}

/** The unit a file belongs to, as the code-facts stage proved it. */
export interface FileUnit {
  readonly name: string;
  /** The whole declared identity: a `go.mod`'s module path, a `package.json`'s name. */
  readonly declared: string;
  /** The ports the unit's code listens on, an ephemeral port aside. */
  readonly ports: readonly string[];
}

/** One handler a registration names. */
interface HandlerRef {
  readonly key: string;
  readonly qualifiedName: string;
  readonly receiverType?: string;
  readonly path: string;
  readonly span: FactSpan;
}

/** The evidence every library record carries, as the driver writes it (`libraryEvidence`). */
function evidenceOf(effect: LibraryEffect): Record<string, unknown> {
  return {
    model: effect.modelId,
    library: effect.package,
    invocationSpan: { ...effect.span },
    origin: {
      importId: effect.origin.importId,
      importSpan: { ...effect.origin.importSpan },
      exportedPath: [...effect.origin.exportedPath],
      chain: [...effect.origin.chain],
      ...(effect.roleOrigin === undefined ? {} : { roleOrigin: effect.roleOrigin }),
    },
  };
}

/** The span an effect's own call stands at, where the invocation prefix was proved (the driver's `effectSpan`). */
function effectSpanOf(effect: LibraryEffect): FactSpan {
  const prefix = effect.invocationSpan;
  return prefix !== undefined && prefix.path === effect.span.path && prefix.byteStart === effect.span.byteStart &&
    prefix.byteEnd > prefix.byteStart && prefix.byteEnd <= effect.span.byteEnd && prefix.lineStart === effect.span.lineStart &&
    prefix.lineEnd >= prefix.lineStart && prefix.lineEnd <= effect.span.lineEnd ? prefix : effect.span;
}

/** The paths a file's own registrations stand at, in the order the driver reads them. */
export type RouteLookup = (folder: string, typeName: string, member: string) => Promise<CallableNode | undefined>;

/** What one file's observability reading answers. */
export interface ObservabilityReading {
  readonly routes: readonly HttpRouteRecord[];
  readonly expositions: readonly MetricExpositionRecord[];
}

/**
 * The node kinds this module publishes as its own bookkeeping: the place a file
 * registers an HTTP route and the exposition it writes. The links stage reads
 * them, and no comparison counts them — they are the reading's own facts, as a
 * file's environment reads are.
 */
export const ROUTE_FACT_KIND = 'code.http-route';
export const EXPOSITION_FACT_KIND = 'code.metric-exposition';
export const LOGGER_USE_FACT_KIND = 'code.logger-use';

/** Every observability record one code file's own bytes hold. */
export async function observabilityRecordsOfFile(facts: CodeFactIndex, library: FileLibraryEffects, unit: FileUnit | undefined, lookup: RouteLookup, writer: ObservabilityWriter): Promise<ObservabilityReading> {
  const routes = await readRoutes(facts, unit, lookup);
  loggers(facts, library, unit, writer);
  const expositions = metrics(facts, library, unit, writer);
  for (const route of routes) {
    writer.add(`${ROUTE_FACT_KIND}:${route.span.path}#${String(route.span.byteStart)}`, ROUTE_FACT_KIND,
      `${route.method} ${route.path}`, {
        path: route.path, method: route.method, ports: [...route.ports], service: route.service, manifest: route.manifest,
        handlerKey: route.handlerKey, handlerIdentity: route.handlerIdentity, handlerPath: route.handlerPath,
        handlerSpan: { ...route.handlerSpan }, handlerExpression: route.handlerExpression, receiverExpression: route.receiverExpression,
        statusOk: route.statusOk,
      }, route.span);
    if (!HEALTH_PATHS.has(route.path)) continue;
    const key = `code.health-endpoint:${route.span.path}#${route.handlerIdentity}${route.path === '/healthz' ? '' : route.path}`;
    writer.add(key, 'code.health-endpoint', `${route.path} of ${route.service === '' ? route.span.path : route.service}`, {
      path: route.path, method: route.method, ports: [...route.ports], statusOk: route.statusOk, service: route.service,
    }, route.span);
  }
  return { routes, expositions };
}

// ---- routes ---------------------------------------------------------------

/** One call of the file, as a registration the model named. */
interface Registration {
  readonly call: { readonly id: string; readonly arguments: readonly string[] };
  readonly model: HttpModel;
  readonly member: string;
  readonly receiver: string;
}

/** The route model a member call of one receiver role answers. */
function routeModelOf(packageName: string, role: HttpRole | undefined, member: string): HttpModel | undefined {
  if (role === undefined) return undefined;
  return unique(httpModels.filter((model) => model.target.kind === 'member' && model.package === packageName &&
    model.target.roles.includes(role) && model.target.members.includes(member) && model.effect.kind === 'route'));
}

/** The role and package a receiver expression names: a factory's result, or an import's whole package. */
function originOf(facts: CodeFactIndex, id: string, seen: ReadonlySet<string> = new Set()): { readonly package: string; readonly role?: HttpRole } | undefined {
  if (seen.has(id) || seen.size > 20) return undefined;
  const next = new Set(seen); next.add(id);
  const node = facts.unwrap(id);
  if (node === undefined) return undefined;
  if (node.receiver !== undefined && node.member !== undefined) {
    const receiver = facts.expression(node.receiver);
    return receiver === undefined ? undefined : originOf(facts, receiver.id, next);
  }
  if (node.syntaxKind === 'call_expression' && node.callee !== undefined) {
    const callee = facts.expression(node.callee);
    if (callee !== undefined) {
      const model = exportModelOf(facts, callee);
      if (model?.effect.kind === 'factory') return { package: model.package, role: model.effect.role };
      const base = originOf(facts, callee.id, next);
      if (base !== undefined) return base;
    }
    return undefined;
  }
  const binding = facts.bindingOf(node);
  return binding?.kind === 'import' && binding.specifier !== undefined ? { package: binding.specifier } : undefined;
}

/** The export a callee names: the model the import chain proves it comes from. */
function exportModelOf(facts: CodeFactIndex, callee: ExpressionNode): HttpModel | undefined {
  if (callee.receiver !== undefined && callee.member !== undefined) {
    const receiver = facts.expression(callee.receiver);
    const origin = receiver === undefined ? undefined : originOf(facts, receiver.id);
    if (origin === undefined) return undefined;
    if (origin.role !== undefined) {
      const role = origin.role;
      const member = callee.member;
      return unique(httpModels.filter((model) => model.target.kind === 'member' && model.package === origin.package &&
        model.target.roles.includes(role) && model.target.members.includes(member)));
    }
    // A package's own export: the member names the last segment of the export's path.
    const member = callee.member;
    return unique(httpModels.filter((model) => model.target.kind === 'export' && model.package === origin.package &&
      model.target.paths.some((path) => path.length === 1 && path[0] === member)));
  }
  const binding = facts.bindingOf(callee);
  if (binding?.kind !== 'import' || binding.specifier === undefined) return undefined;
  const path = binding.form === 'default' ? ['default'] : binding.form === 'namespace' ? [] : [binding.importedName ?? binding.name];
  return unique(httpModels.filter((model) => model.target.kind === 'export' && model.package === binding.specifier &&
    model.target.paths.some((exported) => JSON.stringify(exported) === JSON.stringify(path))));
}

/** The callables of another file of the same folder that declare a type's member: the model's own member name. */
async function methodOf(facts: CodeFactIndex, lookup: RouteLookup, typeName: string, member: string): Promise<CallableNode | undefined> {
  const folder = facts.path.slice(0, facts.path.lastIndexOf('/'));
  return lookup(folder, typeName, member);
}

/** One registration's handler: the callable the expression names, where the file or its folder declares it. */
async function handlerOf(facts: CodeFactIndex, lookup: RouteLookup, id: string, seen: ReadonlySet<string> = new Set()): Promise<HandlerRef | undefined> {
  if (seen.has(id) || seen.size > 20) return undefined;
  const next = new Set(seen); next.add(id);
  const node = facts.unwrap(id);
  if (node === undefined) return undefined;
  const direct = facts.callables.find((callable) => same(callable.span, node.span));
  if (direct !== undefined) return { key: direct.key, qualifiedName: direct.qualifiedName, path: facts.path, span: direct.span };
  if (node.syntaxKind === 'identifier') {
    const named = facts.callables.filter((callable) => callable.name === node.name && callable.symbolKind !== 'method');
    const one = unique(named);
    if (one !== undefined) return { key: one.key, qualifiedName: one.qualifiedName, path: facts.path, span: one.span };
  }
  if (node.receiver !== undefined && node.member !== undefined) {
    const field = facts.fieldNamed(node);
    const receiverIndex = node.receiver;
    if (field !== undefined && field.typeExpression !== undefined) {
      const typeExpression = facts.expression(field.typeExpression);
      const plain = typeExpression?.syntaxKind === 'pointer_type' ? unique(facts.childrenOf(typeExpression) ?? []) : typeExpression;
      if (plain?.syntaxKind === 'type_identifier' && plain.name !== undefined) {
        // A struct field holding a handler: the member the HTTP model names on the declared type.
        const method = await methodOf(facts, lookup, plain.name, 'ServeHTTP');
        if (method !== undefined) return { key: method.key, qualifiedName: method.qualifiedName, receiverType: plain.name, path: method.span.path, span: method.span };
      }
    }
    void receiverIndex;
  }
  if (node.syntaxKind === 'call_expression' && node.callee !== undefined) {
    const callee = facts.expression(node.callee);
    const model = callee === undefined ? undefined : exportModelOf(facts, callee);
    if (model?.effect?.kind === 'handler-adapter') {
      const call = facts.callOf(node.id);
      const argument = call?.arguments[0];
      return argument === undefined ? undefined : handlerOf(facts, lookup, argument, next);
    }
    const call = facts.callOf(node.id);
    const argument = call?.arguments.at(-1);
    return argument === undefined ? undefined : handlerOf(facts, lookup, argument, next);
  }
  return undefined;
}

/** Whether the handler writes a literal `ok`, which is what a health endpoint's answer says. */
function statusOkOf(facts: CodeFactIndex, handler: HandlerRef): boolean {
  return facts.ordered.some((node) => {
    const literal = node.literal;
    return literal !== undefined && literal.value === 'ok' && contains(handler.span, node.span);
  });
}

/** The routes one file registers, in the order the driver reads them. */
async function readRoutes(facts: CodeFactIndex, unit: FileUnit | undefined, lookup: RouteLookup): Promise<readonly HttpRouteRecord[]> {
  const records: HttpRouteRecord[] = [];
  const ports = (unit?.ports ?? []).filter((port) => Number.parseInt(port, 10) > 0).sort(byCodePoint);
  const seen = new Set<string>();
  for (const call of [...facts.calls.values()].sort((left, right) => left.span.byteStart - right.span.byteStart)) {
    if (seen.has(call.expression)) continue;
    const callee = call.callee === undefined ? undefined : facts.expression(call.callee);
    if (callee?.receiver === undefined || callee.member === undefined) continue;
    const origin = originOf(facts, callee.receiver);
    if (origin === undefined) continue;
    const model = routeModelOf(origin.package, origin.role, callee.member);
    if (model?.effect?.kind !== 'route') continue;
    const first = call.arguments[model.effect.pathArgument];
    const literal = first === undefined ? undefined : facts.value(first);
    if (typeof literal !== 'string') continue;
    let path = literal;
    let method = callee.member.toUpperCase();
    if (model.effect.method === 'pattern') {
      const split = literal.indexOf(' ');
      method = split < 0 ? '' : literal.slice(0, split);
      path = split < 0 ? literal : literal.slice(split + 1);
    }
    if (!path.startsWith('/')) continue;
    const handlerId = model.effect.handlerArgument === -1 ? call.arguments.at(-1) : call.arguments[model.effect.handlerArgument];
    const handler = handlerId === undefined ? undefined : await handlerOf(facts, lookup, handlerId);
    seen.add(call.expression);
    if (handler === undefined) continue;
    records.push({
      span: call.span,
      path,
      method,
      ports,
      service: unit?.name ?? '',
      manifest: unit?.declared ?? '',
      handlerKey: handler.key,
      handlerIdentity: handler.receiverType ?? handler.qualifiedName,
      handlerPath: handler.path,
      handlerSpan: handler.span,
      handlerExpression: handlerId!,
      receiverExpression: callee.receiver,
      statusOk: statusOkOf(facts, handler),
    });
  }
  return records;
}


// ---- loggers --------------------------------------------------------------

/** The identity a logger declaration is named by: its binding, the callable that returns it, or its own place. */
function loggers(facts: CodeFactIndex, library: FileLibraryEffects, unit: FileUnit | undefined, writer: ObservabilityWriter): void {
  const path = facts.path;
  const all = library.allEffects;
  const declared = all.filter((effect) => effect.kind === 'logger-declare');
  const peers = new Map<string, number>();
  for (const effect of declared) peers.set(effect.holder, (peers.get(effect.holder) ?? 0) + 1);
  const keys = new Map<string, string>();
  for (const effect of declared) {
    const bindings = library.closure.bindings.filter((binding) => binding.initializer === effect.expression);
    const binding = bindings.length === 1 ? bindings[0] : undefined;
    const holders = library.closure.symbols.filter((symbol) => symbol.callable && symbol.key === effect.holder && symbol.path === effect.span.path &&
      symbol.span.byteStart <= effect.span.byteStart && effect.span.byteEnd <= symbol.span.byteEnd);
    const holder = holders.length === 1 ? holders[0] : undefined;
    const returned = holder !== undefined && library.closure.expressions.some((expression) => expression.syntaxKind === 'return_statement' &&
      contains(holder.span, expression.span) && contains(expression.span, effect.span) && descends(expression.id, effect.expression, library.closure));
    const identity = binding?.name ?? (returned && peers.get(effect.holder) === 1 && holder !== undefined
      ? holder.qualifiedName
      : `${effect.holder.slice(effect.holder.lastIndexOf('#') + 1)}@${String(effect.span.byteStart)}`);
    const key = `code.logger:${effect.span.path}#${identity}`;
    keys.set(effect.expression, key);
    if (effect.span.path !== path) continue;
    const span = binding?.declarationSpan ?? (returned && holder !== undefined ? holder.span : effect.span);
    const service = unit?.name ?? '';
    writer.add(key, 'code.logger', `logger ${identity} of ${service === '' ? effect.span.path : service}`, {
      service,
      ...evidenceOf(effect),
      ...(effect.presentation === undefined ? {} : { library: effect.presentation.library, ...(effect.presentation.json === undefined ? {} : { json: effect.presentation.json }) }),
    }, span);
  }
  for (const effect of all.filter((held) => held.kind === 'logger-use')) {
    if (effect.span.path !== path) continue;
    const logger = effect.roleOrigin === undefined ? undefined : keys.get(effect.roleOrigin);
    if (logger === undefined) {
      writer.gap(effect.span.path, `line ${String(effect.span.lineStart)}: logger use has no resolved declaration [${effect.modelId}]`);
      continue;
    }
    const owner = ownerOf(facts, effect.holder, effect.span);
    const span = effectSpanOf(effect);
    if (owner === undefined) writer.gap(effect.span.path, `line ${String(effect.span.lineStart)}: logger use is outside a callable [${effect.modelId}]`);
    // The use's edge stands at the using file and ends at the logger another file declares, so the
    // link waits for every code file's declaration: this unit publishes the use, and the links
    // stage joins it (madarch-8bdc.2.4).
    writer.add(`${LOGGER_USE_FACT_KIND}:${effect.span.path}#${String(effect.span.byteStart)}`, LOGGER_USE_FACT_KIND, effect.modelId, {
      path: effect.span.path,
      logger,
      owner: owner ?? '',
      discriminator: String(effect.span.byteStart),
      evidence: evidenceOf(effect),
    }, span);
  }
}

/** Whether the effect's expression stands inside the return statement a callable returns, by the driver's own children walk. */
function descends(id: string, target: string, closure: FileLibraryEffects['closure'], seen: ReadonlySet<string> = new Set()): boolean {
  if (id === target) return true;
  if (seen.has(id)) return false;
  const next = new Set(seen); next.add(id);
  const expression = closure.expressions.find((held) => held.id === id);
  return expression === undefined ? false : expression.children.some((child) => descends(child, target, closure, next));
}

/** The callable key an effect is owned by, where this file declares one under that key and holds the effect in its body. */
function ownerOf(facts: CodeFactIndex, holder: string, span: FactSpan): string | undefined {
  if (holder === `code.file:${span.path}`) return undefined;
  const sites = facts.callables.filter((callable) => callable.key === holder && callable.span.byteStart <= span.byteStart && span.byteEnd <= callable.span.byteEnd);
  return sites.length === 1 ? sites[0]!.key : undefined;
}

/** The callable key a place stands in, or the file's own key where no callable holds it. */
function holderAt(facts: CodeFactIndex, span: FactSpan): string {
  return facts.callableAt(span)?.key ?? `code.file:${span.path}`;
}

// ---- metrics --------------------------------------------------------------

/** One fragment of an exposition: the effect that writes it, the literal it writes and the arguments it fills. */
interface Fragment {
  readonly effect: LibraryEffect;
  readonly literal: ExpressionNode;
  readonly parsed: PrometheusTextResult;
  readonly arguments: readonly string[];
  readonly writer: string;
}

/** One field of a declared type, keyed as the extract readings key it. */
interface FieldAt {
  readonly key: string;
  readonly name: string;
  readonly ownerTypeName: string;
  /** Where the field's name is written, which is the span the extract readings give the field. */
  readonly span: FactSpan;
  readonly typeExpression?: string;
  readonly ownerDeclaration?: string;
}

/** One place a field is named, with the roles the use gives it. */
interface MemberSite {
  readonly span: FactSpan;
  readonly to: string;
  readonly roles: readonly string[];
  readonly holder: string;
}

/** The metric nodes, the update edges and the expositions one file's effects make. */
function metrics(facts: CodeFactIndex, library: FileLibraryEffects, unit: FileUnit | undefined, writer: ObservabilityWriter): readonly MetricExpositionRecord[] {
  const path = facts.path;
  const manifest = unit?.declared ?? '';
  const effects = library.effects;
  const fields = fieldView(facts);
  const sites = memberSites(facts);
  const declared = new Map<string, { readonly key: string; readonly effect: LibraryEffect }>();
  for (const effect of effects.filter((held) => held.kind === 'metric-declare')) {
    const name = metricArgument(facts, effect, 'name');
    if (typeof name !== 'string' || name === '') {
      writer.gap(effect.span.path, `line ${String(effect.span.lineStart)}: metric name has no resolved static string [${effect.modelId}]`);
      continue;
    }
    const namespace = metricArgument(facts, effect, 'namespace');
    const subsystem = metricArgument(facts, effect, 'subsystem');
    const fullName = [namespace, subsystem, name].filter((part): part is string => typeof part === 'string' && part !== '').join('_');
    const labels = metricArgument(facts, effect, 'labels');
    if (labels !== undefined && (!Array.isArray(labels) || labels.some((label) => typeof label !== 'string'))) {
      writer.gap(effect.span.path, `line ${String(effect.span.lineStart)}: metric label names are not a static string array [${effect.modelId}]`);
      continue;
    }
    const role = effect.returnRole;
    if (role === undefined || !role.startsWith('metric-')) {
      writer.gap(effect.span.path, `line ${String(effect.span.lineStart)}: metric model has no metric type role [${effect.modelId}]`);
      continue;
    }
    const metricType = role.slice('metric-'.length).split('-')[0]!;
    const bindings = [...facts.bindings.values()].filter((held) => held.initializer === effect.expression);
    const key = `code.metric:${effect.span.path}#${fullName}`;
    writer.add(key, 'code.metric', fullName, {
      name: fullName, metricType, labels: labels === undefined ? [] : [...labels as string[]].sort(byCodePoint),
      service: manifest, binding: bindings.length === 1 ? bindings[0]!.name : '', definitionFormat: 'constructor', ...evidenceOf(effect),
    }, bindings.length === 1 ? (bindings[0]!.declarationSpan ?? effect.span) : effect.span);
    declared.set(effect.expression, { key, effect });
  }
  for (const effect of effects.filter((held) => held.kind === 'metric-update')) {
    const metric = effect.roleOrigin === undefined ? undefined : declared.get(effect.roleOrigin);
    if (metric === undefined) {
      writer.gap(effect.span.path, `line ${String(effect.span.lineStart)}: metric update has no resolved declaration [${effect.modelId}]`);
      continue;
    }
    const owner = ownerOf(facts, effect.holder, effect.span);
    if (owner === undefined) continue;
    writer.edge('code.updates-metric', owner, metric.key, evidenceOf(effect), effectSpanOf(effect), String(effect.span.byteStart));
  }
  return textMetrics(facts, effects, manifest, fields, sites, writer);
}

/** One argument a metric model selected, as the value it names. */
function metricArgument(facts: CodeFactIndex, effect: LibraryEffect, name: string): unknown {
  const selected = effect.arguments.find((argument) => argument.name === name);
  return selected?.expression === undefined ? undefined : facts.value(selected.expression);
}

/** The fields of one file, keyed as the extract readings key them, with the type declaration each stands in. */
function fieldView(facts: CodeFactIndex): ReadonlyMap<string, FieldAt> {
  const fields = new Map<string, FieldAt>();
  for (const field of facts.fields) {
    if (field.typeExpression === undefined) continue;
    const owner = unique(facts.ordered.filter((node) => node.syntaxKind === 'type_spec' && contains(node.span, field.span) &&
      (node.fields['name'] ?? []).some((id) => facts.expression(id)?.name === field.ownerTypeName)));
    const key = fieldSymbolKeyOf(facts.path, field.ownerTypeName, field.name);
    if (fields.has(key)) continue;
    // The name is the field's identity and its place: the declaration's span covers the type too,
    // and the extract readings name the field where its name is written.
    const declaration = unique(facts.ordered.filter((node) => node.syntaxKind === 'field_declaration' && contains(node.span, field.span) &&
      (node.fields['name'] ?? []).some((id) => { const name = facts.expression(id); return name !== undefined && name.name === field.name; })));
    const nameNode = declaration === undefined ? undefined : (declaration.fields['name'] ?? []).map((id) => facts.expression(id)).find((node) => node?.name === field.name);
    fields.set(key, { key, name: field.name, ownerTypeName: field.ownerTypeName, span: nameNode?.span ?? field.span, typeExpression: field.typeExpression, ...(owner === undefined ? {} : { ownerDeclaration: owner.id }) });
  }
  return fields;
}

/** The places one file's expressions name a field of a declared type, with the roles the use gives them. */
function memberSites(facts: CodeFactIndex): readonly MemberSite[] {
  const sites: MemberSite[] = [];
  for (const node of facts.ordered) {
    if (node.syntaxKind !== 'selector_expression' && node.syntaxKind !== 'member_expression') continue;
    const field = facts.fieldNamed(node);
    if (field === undefined || field.typeExpression === undefined) continue;
    const name = facts.childIn(node, node.syntaxKind === 'selector_expression' ? 'field' : 'property');
    if (name === undefined) continue;
    sites.push({ span: name.span, to: fieldSymbolKeyOf(facts.path, field.ownerTypeName, field.name), roles: rolesOf(facts, node), holder: holderAt(facts, node.span) });
  }
  return sites;
}

/** The roles a field's use carries: it is read, and it is written where an assignment or a move targets it. */
function rolesOf(facts: CodeFactIndex, node: ExpressionNode): readonly string[] {
  let held = node;
  const seen = new Set<string>();
  for (;;) {
    if (seen.has(held.id)) break;
    seen.add(held.id);
    const parent = held.parent === undefined ? undefined : facts.expression(held.parent);
    if (parent === undefined) break;
    if (parent.syntaxKind === 'index_expression' || parent.syntaxKind === 'parenthesized_expression') { held = parent; continue; }
    if (parent.syntaxKind === 'inc_statement' || parent.syntaxKind === 'dec_statement' || parent.syntaxKind === 'update_expression') return ['read-access', 'write-access'];
    if (['assignment_expression', 'augmented_assignment_expression', 'assignment_statement'].includes(parent.syntaxKind)) {
      const targets = (parent.fields['left'] ?? []).some((id) => id === held.id || childOf(facts, id, held.id));
      return targets
        ? (parent.syntaxKind === 'augmented_assignment_expression' ? ['read-access', 'write-access'] : ['write-access'])
        : ['read-access'];
    }
    break;
  }
  return ['read-access'];
}

/** Whether one expression id holds another whole, by the parent chain the walk recorded. */
function childOf(facts: CodeFactIndex, outer: string, inner: string, seen: ReadonlySet<string> = new Set()): boolean {
  if (outer === inner) return true;
  if (seen.has(outer)) return false;
  const node = facts.expression(outer);
  if (node === undefined) return false;
  const next = new Set(seen); next.add(outer);
  return node.children.some((child) => childOf(facts, child, inner, next));
}

/** The Go type model an expression names: a qualified type of a package the models know. */
function typeModelAt(facts: CodeFactIndex, id: string): MetricSemanticModel | undefined {
  const type = facts.expression(id);
  if (type?.syntaxKind !== 'qualified_type') return undefined;
  // A qualified type names its package and its type by the grammar's own two fields; the walk
  // records them as children, and the type it names is the second one.
  const receiver = facts.childIn(type, 'package');
  const name = facts.childIn(type, 'name');
  if (receiver === undefined || name?.syntaxKind !== 'type_identifier' || name.name === undefined) return undefined;
  if (!type.children.includes(receiver.id) || !type.children.includes(name.id)) return undefined;
  // A Go package name is a `package_identifier`, which the walk resolves to no binding: the
  // import that binds it is the one whose scope holds the name and whose own name is this one.
  const binding = [...facts.bindings.values()].find((held) => held.kind === 'import' && held.name === receiver.name && contains(held.scope, receiver.span));
  if (binding?.kind !== 'import' || binding.specifier === undefined || binding.form !== 'namespace') return undefined;
  if (binding.span.path !== type.span.path || binding.name !== receiver.name) return undefined;
  if (binding.targetPath !== undefined) return undefined;
  return unique(metricSemanticModels.filter((model) => model.package === binding.specifier && model.exportedPath.length === 1 && model.exportedPath[0] === name.name));
}

/**
 * The text metric family: the Prometheus exposition a file writes, read the way
 * the driver reads it — the modeled write effect, its literal text, the
 * declarations and samples that text holds, and the backing declaration each
 * sample's value reads, with the writes that move it.
 */
function textMetrics(facts: CodeFactIndex, effects: readonly LibraryEffect[], manifest: string, fields: ReadonlyMap<string, FieldAt>, sites: readonly MemberSite[], writer: ObservabilityWriter): readonly MetricExpositionRecord[] {
  const expressionOf = (id: string): ExpressionNode | undefined => facts.expression(id);
  const typeModel = (id: string): MetricSemanticModel | undefined => typeModelAt(facts, id);
  const checkedCall = (id: string) => {
    const node = expressionOf(id);
    const call = facts.callOf(id);
    if (node === undefined || call === undefined || node.syntaxKind !== 'call_expression' || call.span.path !== node.span.path) return undefined;
    if (!contains(node.span, call.span) || !contains(call.span, node.span) || node.callee !== call.callee || !node.children.includes(call.callee ?? '')) return undefined;
    if (JSON.stringify(node.arguments ?? []) !== JSON.stringify(call.arguments)) return undefined;
    if (call.arguments.some((argument) => { const held = expressionOf(argument); return held === undefined || !contains(call.span, held.span); })) return undefined;
    const callee = expressionOf(call.callee ?? '');
    if (callee?.receiver === undefined || callee.member === undefined || !callee.children.includes(callee.receiver) || !contains(call.span, callee.span)) return undefined;
    const receiver = expressionOf(callee.receiver);
    return receiver !== undefined && contains(callee.span, receiver.span) ? { call, callee, receiver } : undefined;
  };
  const writerIsHttp = (id: string, holder: string): boolean => {
    const binding = [...facts.bindings.values()].find((entry) => entry.id === id && entry.kind === 'parameter');
    const owner = unique(facts.callables.filter((entry) => entry.key === holder));
    if (binding === undefined || owner?.bodySpan === undefined || !contains(owner.span, binding.span) || binding.span.byteEnd > owner.bodySpan.byteStart) return false;
    const parameter = unique(facts.ordered.filter((entry) => entry.syntaxKind === 'parameter_declaration' && contains(entry.span, binding.span) &&
      (entry.fields['name'] ?? []).some((nameId) => expressionOf(nameId)?.bindingId === binding.id)));
    const type = parameter === undefined ? undefined : facts.childIn(parameter, 'type');
    return type !== undefined && typeModel(type.id)?.role === 'http-response-writer';
  };
  const directBacking = (id: string, holder: string): FieldAt | undefined => {
    let node = expressionOf(id);
    const seen = new Set<string>();
    while (node?.syntaxKind === 'parenthesized_expression' && !seen.has(node.id)) {
      seen.add(node.id);
      const child = unique(facts.childrenOf(node) ?? []);
      node = child === undefined ? undefined : expressionOf(child.id);
    }
    if (node?.syntaxKind !== 'selector_expression' || node.receiver === undefined || node.member === undefined) return undefined;
    const member = facts.childIn(node, 'field');
    if (member === undefined) return undefined;
    const targets = [...new Set(sites.filter((site) => site.holder === holder && same(site.span, member.span)).map((site) => site.to))];
    const target = targets.length === 1 ? fields.get(targets[0]!) : undefined;
    return target === undefined || target.name !== node.member ? undefined : target;
  };
  const scalarBacking = (id: string, holder: string): { readonly field: FieldAt; readonly index?: ExpressionNode; readonly key?: ExpressionNode } | undefined => {
    const node = expressionOf(id);
    if (node?.syntaxKind !== 'index_expression') {
      const direct = directBacking(id, holder);
      return direct === undefined ? undefined : { field: direct };
    }
    const operand = facts.childIn(node, 'operand');
    const index = facts.childIn(node, 'index');
    const backing = operand === undefined ? undefined : directBacking(operand.id, holder);
    if (index === undefined || backing === undefined) return undefined;
    if (expressionOf(backing.typeExpression ?? '')?.syntaxKind !== 'map_type') return undefined;
    return { field: backing, index: node, key: index };
  };
  const cellAccess = (id: string, role: 'read' | 'write'): { readonly invocation: NonNullable<ReturnType<typeof checkedCall>>; readonly field: FieldAt } | undefined => {
    const invocation = checkedCall(id);
    if (invocation === undefined) { if (process.env.OPSDEBUG) console.error('cell: no checked call', id); return undefined; }
    const backing = directBacking(invocation.receiver.id, holderAt(facts, invocation.call.span));
    if (backing === undefined) { if (process.env.OPSDEBUG) console.error('cell: no backing', id, holderAt(facts, invocation.call.span), sites.filter((s) => s.holder === holderAt(facts, invocation.call.span)).length); return undefined; }
    const model = typeModel(backing.typeExpression ?? '');
    if (model?.role !== 'metric-cell') { if (process.env.OPSDEBUG) console.error('cell: no model', backing.typeExpression, model?.role); return undefined; }
    const operations = role === 'read' ? model.reads : model.writes;
    return operations.some((operation) => operation.member === invocation.callee.member && operation.arguments === invocation.call.arguments.length)
      ? { invocation, field: backing }
      : undefined;
  };
  const literalOf = (id: string, seen: ReadonlySet<string> = new Set()): ExpressionNode | undefined => {
    if (seen.has(id)) return undefined;
    const next = new Set(seen); next.add(id);
    const node = expressionOf(id);
    if (node === undefined) return undefined;
    if (node.literal?.kind === 'string') return node;
    if (node.bindingId !== undefined) {
      const binding = facts.bindings.get(node.bindingId);
      return binding?.kind === 'local' && binding.initializer !== undefined ? literalOf(binding.initializer, next) : undefined;
    }
    return ['parenthesized_expression', 'literal_element', 'as_expression', 'satisfies_expression', 'non_null_expression'].includes(node.syntaxKind) && node.children.length === 1
      ? literalOf(node.children[0]!, next)
      : undefined;
  };
  const writerIdentity = (id: string, seen: ReadonlySet<string> = new Set()): string | undefined => {
    if (seen.has(id)) return undefined;
    const next = new Set(seen); next.add(id);
    const node = expressionOf(id);
    if (node === undefined) return undefined;
    if (node.bindingId !== undefined) {
      const binding = facts.bindings.get(node.bindingId);
      if (binding === undefined || binding.span.path !== node.span.path || node.span.byteStart < binding.scope.byteStart || node.span.byteEnd > binding.scope.byteEnd) return undefined;
      if (binding.kind === 'parameter') return binding.id;
      if (binding.kind === 'local' && binding.initializer !== undefined && facts.value(id) !== undefined) return writerIdentity(binding.initializer, next);
      return undefined;
    }
    if (node.syntaxKind === 'parenthesized_expression' && node.children.length === 1) return writerIdentity(node.children[0]!, next);
    return undefined;
  };
  const groups = new Map<string, Fragment[]>();
  const rejected = new Set<string>();
  for (const effect of effects.filter((held) => held.kind === 'metric-text-write')) {
    const metadata = effect.textWrite;
    const writerId = effect.arguments.find((entry) => entry.name === 'writer')?.expression;
    const selected = effect.arguments.find((entry) => entry.name === 'text')?.expression;
    const call = effect.expression === undefined ? undefined : facts.callOf(effect.expression);
    const writerOrigin = writerId === undefined ? undefined : writerIdentity(writerId);
    if (metadata === undefined || writerOrigin === undefined || selected === undefined || call === undefined) continue;
    const key = JSON.stringify([effect.holder, writerOrigin]);
    const literal = literalOf(selected);
    const text = facts.value(selected);
    if (literal === undefined || typeof text !== 'string') { rejected.add(key); continue; }
    const args = call.arguments.slice(metadata.argumentsFrom);
    const parsed = parsePrometheusText(text, metadata.format === 'printf');
    if (parsed.errors.length > 0 || (metadata.format === 'plain' && args.length > 0) || (metadata.format === 'printf' && parsed.argumentCount !== args.length)) { rejected.add(key); continue; }
    const fragments = groups.get(key) ?? [];
    fragments.push({ effect, literal, parsed, arguments: args, writer: writerOrigin });
    groups.set(key, fragments);
  }
  const exposed = new Map<string, { readonly effect: LibraryEffect; readonly writer: string; readonly metrics: Set<string> }>();
  for (const [group, fragments] of groups) {
    if (rejected.has(group)) continue;
    const declarations = fragments.flatMap((fragment) => fragment.parsed.declarations.map((declaration) => ({ fragment, declaration })));
    const samples = fragments.flatMap((fragment) => fragment.parsed.samples.map((sample) => ({ fragment, sample })));
    for (const name of [...new Set([...declarations.map((entry) => entry.declaration.name), ...samples.map((entry) => entry.sample.name)])].sort(byCodePoint)) {
      const types = declarations.filter((entry) => entry.declaration.name === name && entry.declaration.kind === 'type');
      const helps = declarations.filter((entry) => entry.declaration.name === name && entry.declaration.kind === 'help');
      const selected = samples.filter((entry) => entry.sample.name === name);
      const evidence = types[0]?.fragment ?? selected[0]?.fragment ?? helps[0]?.fragment;
      if (evidence === undefined) continue;
      if (types.length !== 1 || helps.length > 1 || selected.length === 0) continue;
      const labels = [...new Set(selected.flatMap((entry) => entry.sample.labels))].sort(byCodePoint);
      if (selected.some((entry) => [...entry.sample.labels].sort(byCodePoint).join('\u0000') !== labels.join('\u0000'))) continue;
      const backing = selected.map((entry) => {
        const argument = entry.sample.valueArgument === undefined ? undefined : entry.fragment.arguments[entry.sample.valueArgument];
        if (argument === undefined) return undefined;
        const direct = scalarBacking(argument, entry.fragment.effect.holder);
        const read = cellAccess(argument, 'read');
        return direct !== undefined && typeModel(direct.field.typeExpression ?? '')?.role !== 'metric-cell'
          ? direct.field.key
          : read !== undefined && holderAt(facts, read.invocation.call.span) === entry.fragment.effect.holder ? read.field.key : undefined;
      });
      const backingKeys = [...new Set(backing)];
      const backingKey = backingKeys.length === 1 && backingKeys[0] !== undefined ? backingKeys[0] : undefined;
      const backingSymbol = backingKey === undefined ? undefined : fields.get(backingKey);
      const key = `code.metric:${evidence.effect.span.path}#${name}`;
      const observationModel = backingSymbol === undefined ? undefined : typeModel(backingSymbol.typeExpression ?? '');
      writer.add(key, 'code.metric', name, {
        name, metricType: types[0]!.declaration.value, labels, definitionFormat: 'prometheus-text',
        help: helps[0]?.declaration.value ?? '', writerBinding: evidence.writer,
        ...(observationModel?.role === 'metric-cell' ? { observationModel: observationModel.id, observationTypeReference: observationModel.reference } : {}),
        ...(backingSymbol === undefined ? {} : { backingDeclaration: backingSymbol.key, backingDeclarationSpan: { ...backingSymbol.span },
          backingOwnerDeclaration: backingSymbol.ownerDeclaration, backingTypeExpression: backingSymbol.typeExpression }),
        service: manifest, declarations: declarations.filter((entry) => entry.declaration.name === name).map((entry) => ({
          kind: entry.declaration.kind, literalExpression: entry.fragment.literal.id, literalSpan: { ...entry.fragment.literal.span },
          decodedStart: entry.declaration.start, decodedEnd: entry.declaration.end, decodedLine: entry.declaration.line,
          ...evidenceOf(entry.fragment.effect),
        })),
        samples: selected.map((entry) => {
          const argument = entry.sample.valueArgument === undefined ? undefined : entry.fragment.arguments[entry.sample.valueArgument];
          const value = argument === undefined ? undefined : expressionOf(argument);
          const scalar = argument === undefined ? undefined : scalarBacking(argument, entry.fragment.effect.holder);
          return { literalExpression: entry.fragment.literal.id, literalSpan: { ...entry.fragment.literal.span },
            decodedStart: entry.sample.start, decodedEnd: entry.sample.end, decodedLine: entry.sample.line,
            formatArguments: [...entry.fragment.arguments],
            ...(argument === undefined ? {} : { valueExpression: argument }),
            ...(value === undefined ? {} : { valueSpan: { ...value.span } }),
            ...(scalar?.index === undefined || scalar.key === undefined ? {} : {
              indexedBaseDeclaration: scalar.field.key, indexExpression: scalar.index.id, indexSpan: { ...scalar.index.span },
              indexKeyExpression: scalar.key.id, indexKeySpan: { ...scalar.key.span },
            }),
            labelExpressions: entry.sample.labelArguments.map((at) => entry.fragment.arguments[at]!),
            ...evidenceOf(entry.fragment.effect),
          };
        }), ...evidenceOf(evidence.effect),
      }, evidence.literal.span);
      if (backingSymbol === undefined) continue;
      const writes = sites.filter((site) => site.to === backingSymbol.key && site.roles.includes('write-access'));
      for (const site of writes) {
        const ownerEffect: LibraryEffect = { ...evidence.effect, holder: holderAt(facts, site.span), span: site.span, invocationSpan: undefined };
        const owner = ownerOf(facts, ownerEffect.holder, ownerEffect.span);
        if (owner === undefined) continue;
        writer.edge('code.updates-metric', owner, key, { backingDeclaration: backingSymbol.key,
          backingDeclarationSpan: { ...backingSymbol.span }, backingOwnerDeclaration: backingSymbol.ownerDeclaration,
          backingTypeExpression: backingSymbol.typeExpression, writeRoles: [...site.roles], ...evidenceOf(evidence.effect) }, site.span, String(site.span.byteStart));
      }
      const cellWrites = [...facts.calls.values()].flatMap((entry) => {
        const access = cellAccess(entry.expression, 'write');
        return access?.field.key === backingSymbol.key ? [access] : [];
      });
      for (const access of cellWrites) {
        const call = access.invocation.call;
        const ownerEffect: LibraryEffect = { ...evidence.effect, holder: holderAt(facts, call.span), span: call.span,
          ...(call.invocationSpan === undefined ? {} : { invocationSpan: call.invocationSpan }) };
        const owner = ownerOf(facts, ownerEffect.holder, ownerEffect.span);
        if (owner === undefined) continue;
        writer.edge('code.updates-metric', owner, key, { backingDeclaration: backingSymbol.key,
          backingDeclarationSpan: { ...backingSymbol.span }, backingOwnerDeclaration: backingSymbol.ownerDeclaration,
          backingTypeExpression: backingSymbol.typeExpression, receiverModel: typeModel(backingSymbol.typeExpression ?? '')?.id,
          receiverTypeReference: typeModel(backingSymbol.typeExpression ?? '')?.reference,
          receiverExpression: expressionOf(access.invocation.callee.receiver ?? '')?.id, ...evidenceOf(evidence.effect) }, effectSpanOf(ownerEffect), String(call.span.byteStart));
      }
      if (writes.length === 0 && cellWrites.length === 0) continue;
      // The exposition is this file's own record: the writer it stands in writes the response of
      // an HTTP handler. Which registration serves it is another file's record, so the links
      // stage joins the two (madarch-8bdc.2.4's second stage), never this unit's read of routes.
      if (!writerIsHttp(evidence.writer, evidence.effect.holder)) continue;
      const existing = exposed.get(evidence.effect.holder) ?? { effect: evidence.effect, writer: evidence.writer, metrics: new Set<string>() };
      existing.metrics.add(key);
      exposed.set(evidence.effect.holder, existing);
    }
  }
  const out: MetricExpositionRecord[] = [];
  for (const [holder, exposure] of exposed) {
    const record: MetricExpositionRecord = {
      span: effectSpanOf(exposure.effect),
      holder,
      writerBinding: exposure.writer,
      metrics: [...exposure.metrics].sort(byCodePoint),
      format: 'prometheus-text',
      evidence: evidenceOf(exposure.effect),
    };
    out.push(record);
    writer.add(`code.metric-exposition:${record.span.path}#${holder}`, 'code.metric-exposition', holder, {
      path: record.span.path,
      holder,
      writerBinding: record.writerBinding,
      metrics: [...record.metrics],
      format: record.format,
      service: manifest,
      evidence: record.evidence,
    }, record.span);
  }
  return out;
}
