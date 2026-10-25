/** Individual metrics from resolved library effects; no source scanning. */
import { byCodePoint } from '../../model/order.js';
import type { CodeExpressionFact } from '../code/facts.js';
import { structuralHttpRegistrations } from './route-facts.js';
import { parsePrometheusText, type PrometheusTextResult } from './prometheus-text.js';
import type { PropertyValue } from '../records.js';
import type { LibraryEffect } from '../library-models/model.js';
import type { Records } from './accumulate.js';
import { CodeFactView, effectOwner, effectSpan, libraryEvidence } from './code-facts.js';
import type { TreeText } from './source.js';

export function extractMetrics(t: TreeText, records: Records): void {
  if (t.facts === undefined) {
    records.gap('.', 'metric extraction requires the shared resolved code facts');
    return;
  }
  const facts = t.facts;
  const view = new CodeFactView(facts);
  const evaluated = t.libraryFacts()!;
  extractTextMetrics(t, records, view, evaluated.effects);
  const metrics = new Map<string, { readonly key: string; readonly effect: LibraryEffect }>();
  const registryIdentity = (packageName: string): string => JSON.stringify(['library-registry', packageName, 'default']);
  const value = (effect: LibraryEffect, name: string): unknown => {
    const selected = effect.arguments.find((argument) => argument.name === name);
    return selected?.expression === undefined ? undefined : view.value(selected.expression);
  };
  for (const effect of evaluated.effects.filter((effect) => effect.kind === 'metric-declare')) {
    const name = value(effect, 'name');
    if (typeof name !== 'string' || name === '') {
      records.gap(effect.span.path, `line ${effect.span.lineStart}: metric name has no resolved static string [${effect.modelId}]`);
      continue;
    }
    const namespace = value(effect, 'namespace');
    const subsystem = value(effect, 'subsystem');
    const fullName = [namespace, subsystem, name].filter((part): part is string => typeof part === 'string' && part !== '').join('_');
    const labels = value(effect, 'labels');
    if (labels !== undefined && (!Array.isArray(labels) || labels.some((label) => typeof label !== 'string'))) {
      records.gap(effect.span.path, `line ${effect.span.lineStart}: metric label names are not a static string array [${effect.modelId}]`);
      continue;
    }
    const role = effect.returnRole;
    if (role === undefined || !role.startsWith('metric-')) {
      records.gap(effect.span.path, `line ${effect.span.lineStart}: metric model has no metric type role [${effect.modelId}]`);
      continue;
    }
    const metricType = role.slice('metric-'.length).split('-')[0]!;
    const binding = view.bindingForInitializer(effect.expression);
    const file = facts.files.find((file) => file.path === effect.span.path);
    const key = `code.metric:${effect.span.path}#${fullName}`;
    records.add({ key, kind: 'code.metric', label: fullName,
      properties: { name: fullName, metricType, labels: labels === undefined ? [] : [...labels as string[]].sort(byCodePoint),
        service: file?.manifest?.name ?? '', binding: binding.length === 1 ? binding[0]!.name : '',
        definitionFormat: 'constructor', ...libraryEvidence(effect) } satisfies { [key: string]: PropertyValue }, span: binding.length === 1 ? binding[0]!.declarationSpan ?? effect.span : effect.span });
    metrics.set(effect.expression, { key, effect });
  }
  for (const effect of evaluated.effects.filter((effect) => effect.kind === 'metric-update')) {
    const metric = effect.roleOrigin === undefined ? undefined : metrics.get(effect.roleOrigin);
    if (metric === undefined) {
      records.gap(effect.span.path, `line ${effect.span.lineStart}: metric update has no resolved declaration [${effect.modelId}]`);
      continue;
    }
    const owner = effectOwner(t, records, effect);
    if (owner === undefined) continue;
    records.edge('code.updates-metric', owner, metric.key, libraryEvidence(effect), effectSpan(effect), String(effect.span.byteStart));
  }
  // Registry identities come from the role interpreter, not local receiver names.
  const registryRoles = new Map(evaluated.roles.filter((role) => role.role === 'metric-registry').map((role) => [role.expression, role]));
  const metricRoles = new Map(evaluated.roles.filter((role) => role.role.startsWith('metric-') && role.role !== 'metric-registry').map((role) => [role.expression, role]));
  const registryOf = (expression: string): string | undefined => {
    const role = registryRoles.get(expression); if (role === undefined) return undefined;
    if (role.metricRegistry?.defaultRegistry !== true) return role.roleOrigin;
    const imported = facts.imports.find((entry) => entry.id === role.origin.importId);
    return imported === undefined ? undefined : registryIdentity(role.metricRegistry.defaultNamespace ?? imported.specifier);
  };
  const members = new Map<string, Set<string>>();
  const include = (registry: string, metric: string): void => {
    const held = members.get(registry) ?? new Set<string>(); held.add(metric); members.set(registry, held);
  };
  const writtenBindings = new Set<string>();
  const markWritten = (id: string, seen = new Set<string>()): void => {
    if (seen.has(id)) return; seen.add(id);
    const expression = view.expressions.get(id); if (expression === undefined) return;
    if (expression.bindingId !== undefined) writtenBindings.add(expression.bindingId);
    for (const child of expression.children) markWritten(child, seen);
  };
  for (const expression of facts.expressions) {
    if (['assignment_expression', 'augmented_assignment_expression', 'assignment_statement'].includes(expression.syntaxKind)) {
      for (const id of expression.fields.left ?? []) markWritten(id);
    } else if (['update_expression', 'inc_statement', 'dec_statement'].includes(expression.syntaxKind)) {
      for (const id of expression.children) markWritten(id);
    }
  }
  // A method on a held list can mutate it. No purity or reaching-definition fact is available.
  for (const call of facts.calls) {
    const callee = view.expressions.get(call.callee);
    if (callee?.receiver !== undefined) markWritten(callee.receiver);
  }
  // Alias writes invalidate the same registry-list value in either direction.
  let changed = true;
  while (changed) {
    changed = false;
    for (const binding of facts.bindings) {
      const target = binding.initializer === undefined ? undefined : view.expressions.get(binding.initializer)?.bindingId;
      if (target === undefined || !writtenBindings.has(binding.id) && !writtenBindings.has(target)) continue;
      for (const id of [binding.id, target]) if (!writtenBindings.has(id)) { writtenBindings.add(id); changed = true; }
    }
  }
  const terminal = (id: string, seen = new Set<string>()): CodeExpressionFact | undefined => {
    if (seen.has(id)) return undefined; seen.add(id);
    const expression = view.expressions.get(id); if (expression === undefined) return undefined;
    if (expression.bindingId !== undefined) {
      const binding = facts.bindings.find((binding) => binding.id === expression.bindingId);
      if (binding?.kind !== 'local' || binding.initializer === undefined || writtenBindings.has(binding.id) ||
        binding.path !== expression.path || binding.scope.path !== expression.path || expression.span.byteStart < binding.span.byteStart ||
        expression.span.byteStart < binding.scope.byteStart || expression.span.byteEnd > binding.scope.byteEnd) return undefined;
      return terminal(binding.initializer, seen);
    }
    if (['parenthesized_expression', 'as_expression', 'satisfies_expression', 'non_null_expression', 'literal_element'].includes(expression.syntaxKind)) {
      return expression.children.length === 1 ? terminal(expression.children[0]!, seen) : undefined;
    }
    return expression;
  };
  for (const metric of metrics.values()) {
    const selected = metric.effect.arguments.find((argument) => argument.name === 'registers');
    if (selected?.expression === undefined) {
      if (metric.effect.metricRegistry?.defaultMember === true) {
        if (selected !== undefined && selected.status !== 'absent') {
          records.gap(metric.effect.span.path, `line ${metric.effect.span.lineStart}: implicit metric registry requires proof that the registry override is absent [${metric.effect.modelId}]`);
        } else include(registryIdentity(metric.effect.metricRegistry.defaultNamespace ?? metric.effect.package), metric.key);
      }
      continue;
    }
    const array = terminal(selected.expression);
    if (array?.syntaxKind !== 'array') {
      records.gap(metric.effect.span.path, `line ${metric.effect.span.lineStart}: metric registry list has no immutable structural array proof [${metric.effect.modelId}]`);
      continue;
    }
    const entries = array.children.filter((id) => view.expressions.get(id)?.syntaxKind !== 'comment');
    const origins = entries.map((id) => registryOf(id));
    if (origins.some((origin) => origin === undefined)) {
      records.gap(metric.effect.span.path, `line ${metric.effect.span.lineStart}: metric registry list contains an unresolved registry origin [${metric.effect.modelId}]`);
      continue;
    }
    for (const origin of origins) if (origin !== undefined) include(origin, metric.key);
  }
  for (const effect of evaluated.effects.filter((effect) => effect.kind === 'metric-register')) {
    const selected = effect.arguments.find((argument) => argument.name === 'metric')?.expression;
    const call = facts.calls.find((call) => call.expression === effect.expression);
    const arguments_ = effect.metricRegistry?.metricsFrom === undefined ? selected === undefined ? [] : [selected]
      : call?.arguments.slice(effect.metricRegistry.metricsFrom) ?? [];
    const registered = arguments_.map((expression) => {
      const origin = metricRoles.get(expression)?.roleOrigin;
      return origin === undefined ? undefined : metrics.get(origin);
    });
    const registry = effect.metricRegistry?.defaultTarget !== true
      ? effect.receiverExpression === undefined ? undefined : registryOf(effect.receiverExpression)
      : registryIdentity(effect.metricRegistry.defaultNamespace ?? effect.package);
    if (registry === undefined || arguments_.length === 0 || registered.some((metric) => metric === undefined)) {
      records.gap(effect.span.path, `line ${effect.span.lineStart}: metric registration has no exact registry and declaration origin [${effect.modelId}]`);
      continue;
    }
    for (const metric of registered) if (metric !== undefined) include(registry, metric.key);
  }
  const routes = structuralHttpRegistrations(t);
  for (const effect of evaluated.effects.filter((effect) => effect.kind === 'metric-expose')) {
    const registrations = routes.filter((route) => route.handler?.key === effect.holder);
    if (registrations.length === 0) {
      records.gap(effect.span.path, `line ${effect.span.lineStart}: metric collection has no structural HTTP handler registration [${effect.modelId}]`);
      continue;
    }
    const registry = effect.receiverExpression === undefined ? undefined : registryOf(effect.receiverExpression);
    if (registry === undefined) {
      records.gap(effect.span.path, `line ${effect.span.lineStart}: metric collection has no exact registry origin [${effect.modelId}]`);
      continue;
    }
    const exposed = [...(members.get(registry) ?? [])].sort(byCodePoint);
    const owner = effectOwner(t, records, effect); if (owner === undefined) continue;
    for (const route of registrations) {
      const identity = route.handler!.qualifiedName;
      const key = `code.metrics-endpoint:${route.span.path}#${identity}:${route.method}:${route.path}`;
      const names = exposed.map((metric) => records.nodes.find((node) => node.key === metric)?.properties.name).filter((name): name is string => typeof name === 'string').sort(byCodePoint);
      const service = facts.files.find((file) => file.path === route.span.path)?.manifest?.name ?? '';
      records.add({ key, kind: 'code.metrics-endpoint', label: `${route.path} of ${service || route.span.path}`,
        properties: { path: route.path, method: route.method, ports: [...route.ports], service, format: 'prometheus-text', counters: names,
          receiverExpression: route.receiverExpression, registryOrigin: registry, ...libraryEvidence(effect) }, span: route.span });
      records.edge('code.served-by', key, records.file(route.span.path), { service }, route.span);
      records.edge('code.served-by', key, owner, { role: 'handler' }, route.span);
      for (const metric of exposed) records.edge('code.exposes-metric', key, metric, libraryEvidence(effect), effectSpan(effect));
    }
  }
}

/** Text declarations require modeled writer provenance and complete literal grammar. */
function extractTextMetrics(t: TreeText, records: Records, view: CodeFactView, effects: readonly LibraryEffect[]): void {
  const facts = view.facts;
  type Fragment = { readonly effect: LibraryEffect; readonly literal: CodeExpressionFact; readonly parsed: PrometheusTextResult;
    readonly arguments: readonly string[]; readonly writer: string };
  const fields = new Map((facts.fields ?? []).filter((field) => {
    const owner = view.expressions.get(field.ownerDeclaration);
    const type = view.expressions.get(field.typeExpression);
    if (owner?.syntaxKind !== 'type_spec' || type === undefined || owner.path !== field.path || type.path !== field.path ||
      owner.span.byteStart > field.span.byteStart || field.span.byteEnd > owner.span.byteEnd ||
      owner.span.byteStart > type.span.byteStart || type.span.byteEnd > owner.span.byteEnd) return false;
    return (facts.fields ?? []).filter((other) => other.key === field.key).length === 1 &&
      facts.symbols.some((symbol) => symbol.key === field.key && symbol.path === field.path && !symbol.callable);
  }).map((field) => [field.key, field]));
  const groups = new Map<string, Fragment[]>();
  const literalOf = (id: string, seen = new Set<string>()): CodeExpressionFact | undefined => {
    if (seen.has(id)) return undefined; seen.add(id);
    const expression = view.expressions.get(id); if (expression === undefined) return undefined;
    if (expression.literal?.kind === 'string') return expression;
    if (expression.bindingId !== undefined) {
      const binding = facts.bindings.find((entry) => entry.id === expression.bindingId);
      return binding?.kind === 'local' && binding.initializer !== undefined ? literalOf(binding.initializer, seen) : undefined;
    }
    return ['parenthesized_expression', 'literal_element', 'as_expression', 'satisfies_expression', 'non_null_expression'].includes(expression.syntaxKind) && expression.children.length === 1
      ? literalOf(expression.children[0]!, seen) : undefined;
  };
  const rejected = new Set<string>();
  const writerIdentity = (id: string, seen = new Set<string>()): string | undefined => {
    if (seen.has(id)) return undefined; seen.add(id);
    const expression = view.expressions.get(id); if (expression === undefined) return undefined;
    if (expression.bindingId !== undefined) {
      const binding = facts.bindings.find((entry) => entry.id === expression.bindingId);
      if (binding === undefined || binding.path !== expression.path || expression.span.byteStart < binding.scope.byteStart || expression.span.byteEnd > binding.scope.byteEnd) return undefined;
      // Parameter identity is exact even though its runtime writer implementation is unknown.
      if (binding.kind === 'parameter') return binding.id;
      if (binding.kind === 'local' && binding.initializer !== undefined && view.value(id) !== undefined) return writerIdentity(binding.initializer, seen);
      return undefined;
    }
    if (expression.syntaxKind === 'parenthesized_expression' && expression.children.length === 1) return writerIdentity(expression.children[0]!, seen);
    return undefined;
  };
  for (const effect of effects.filter((effect) => effect.kind === 'metric-text-write')) {
    const gap = (reason: string): void => records.gap(effect.span.path, `line ${effect.span.lineStart}: ${reason} [${effect.modelId}]`);
    const metadata = effect.textWrite;
    const writer = effect.arguments.find((entry) => entry.name === 'writer')?.expression;
    const selected = effect.arguments.find((entry) => entry.name === 'text')?.expression;
    const call = facts.calls.find((entry) => entry.expression === effect.expression);
    const writerOrigin = writer === undefined ? undefined : writerIdentity(writer);
    if (metadata === undefined || writerOrigin === undefined || selected === undefined || call === undefined) {
      gap('exposition write has no exact model, writer binding, text argument or invocation proof'); continue;
    }
    const key = JSON.stringify([effect.holder, writerOrigin]);
    const literal = literalOf(selected); const text = view.value(selected);
    if (literal === undefined || typeof text !== 'string') { rejected.add(key); gap('exposition text has no immutable decoded literal value'); continue; }
    const args = call.arguments.slice(metadata.argumentsFrom);
    const parsed = parsePrometheusText(text, metadata.format === 'printf');
    if (parsed.errors.length > 0 || metadata.format === 'plain' && args.length > 0 || metadata.format === 'printf' && parsed.argumentCount !== args.length) {
      rejected.add(key);
      for (const error of parsed.errors) gap(`exposition literal line ${error.line}, column ${error.column}: ${error.reason}`);
      if (parsed.errors.length === 0) gap('exposition format argument count is not exact');
      continue;
    }
    const fragments = groups.get(key) ?? [];
    fragments.push({ effect, literal, parsed, arguments: args, writer: writerOrigin }); groups.set(key, fragments);
  }
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
      const gap = (reason: string): void => records.gap(evidence.effect.span.path, `line ${evidence.effect.span.lineStart}: metric ${name}: ${reason} [${evidence.effect.modelId}]`);
      if (types.length !== 1 || helps.length > 1 || selected.length === 0) {
        gap('exposition family requires one TYPE, at most one HELP and an exact sample; aggregate-family inference is unsupported'); continue;
      }
      const labels = [...new Set(selected.flatMap((entry) => entry.sample.labels))].sort(byCodePoint);
      if (selected.some((entry) => [...entry.sample.labels].sort(byCodePoint).join('\u0000') !== labels.join('\u0000'))) {
        gap('sample label sets disagree'); continue;
      }
      const backing = selected.map((entry) => {
        const argument = entry.sample.valueArgument === undefined ? undefined : entry.fragment.arguments[entry.sample.valueArgument];
        const expression = argument === undefined ? undefined : view.expressions.get(argument);
        if (expression === undefined) return undefined;
        const targets = [...new Set(facts.sites.filter((site) => site.holder === entry.fragment.effect.holder && site.use === 'reference' &&
          site.span.path === expression.path && expression.span.byteStart <= site.span.byteStart && site.span.byteEnd <= expression.span.byteEnd)
          .map((site) => site.to).filter((key) => fields.has(key)))];
        return targets.length === 1 ? targets[0] : undefined;
      });
      const backingKeys = [...new Set(backing)];
      const backingKey = backingKeys.length === 1 && backingKeys[0] !== undefined ? backingKeys[0] : undefined;
      const backingSymbol = backingKey === undefined ? undefined : fields.get(backingKey);
      const key = `code.metric:${evidence.effect.span.path}#${name}`;
      records.add({ key, kind: 'code.metric', label: name, properties: {
        name, metricType: types[0]!.declaration.value, labels, definitionFormat: 'prometheus-text',
        help: helps[0]?.declaration.value ?? '', writerBinding: evidence.writer,
        ...(backingSymbol === undefined ? {} : { backingDeclaration: backingSymbol.key, backingDeclarationSpan: { ...backingSymbol.span },
          backingOwnerDeclaration: backingSymbol.ownerDeclaration, backingTypeExpression: backingSymbol.typeExpression }),
        service: facts.files.find((file) => file.path === evidence.effect.span.path)?.manifest?.name ?? '',
        declarations: declarations.filter((entry) => entry.declaration.name === name).map((entry) => ({
          kind: entry.declaration.kind, literalExpression: entry.fragment.literal.id, literalSpan: { ...entry.fragment.literal.span },
          decodedStart: entry.declaration.start, decodedEnd: entry.declaration.end, decodedLine: entry.declaration.line,
          ...libraryEvidence(entry.fragment.effect),
        })),
        samples: selected.map((entry) => ({ literalExpression: entry.fragment.literal.id, literalSpan: { ...entry.fragment.literal.span },
          decodedStart: entry.sample.start, decodedEnd: entry.sample.end, decodedLine: entry.sample.line,
          formatArguments: [...entry.fragment.arguments],
          ...(entry.sample.valueArgument === undefined ? {} : { valueExpression: entry.fragment.arguments[entry.sample.valueArgument]! }),
          labelExpressions: entry.sample.labelArguments.map((argument) => entry.fragment.arguments[argument]!),
          ...libraryEvidence(entry.fragment.effect),
        })), ...libraryEvidence(evidence.effect),
      } satisfies { [key: string]: PropertyValue }, span: evidence.literal.span });
      if (backingSymbol === undefined) {
        gap('sample value has no unique resolved backing declaration; update and HTTP exposure are withheld');
        continue;
      }
      const writes = facts.sites.filter((site) => site.to === backingSymbol.key && site.roles.includes('write-access'));
      for (const site of writes) {
        const ownerEffect: LibraryEffect = { ...evidence.effect, holder: site.holder, span: site.span, invocationSpan: undefined };
        const owner = effectOwner(t, records, ownerEffect); if (owner === undefined) continue;
        records.edge('code.updates-metric', owner, key, { backingDeclaration: backingSymbol.key,
          backingDeclarationSpan: { ...backingSymbol.span }, backingOwnerDeclaration: backingSymbol.ownerDeclaration,
          backingTypeExpression: backingSymbol.typeExpression, writeRoles: [...site.roles], ...libraryEvidence(evidence.effect) }, site.span, String(site.span.byteStart));
      }
      if (writes.length === 0) gap('backing declaration has no resolved write effect; external receiver mutation is not inferred from method spelling');
      gap('writer parameter HTTP response type and registered handler value are not resolved; HTTP exposure is withheld');
    }
  }
}
