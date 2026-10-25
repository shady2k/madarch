/** Individual metrics from resolved library effects; no source scanning. */
import { byCodePoint } from '../../model/order.js';
import type { PropertyValue } from '../records.js';
import type { LibraryEffect } from '../library-models/model.js';
import type { Records } from './accumulate.js';
import { CodeFactView, libraryEvidence } from './code-facts.js';
import type { TreeText } from './source.js';

export function extractMetrics(t: TreeText, records: Records): void {
  if (t.facts === undefined) {
    records.gap('.', 'metric extraction requires the shared resolved code facts');
    return;
  }
  const facts = t.facts;
  const view = new CodeFactView(facts);
  const evaluated = t.libraryFacts()!;
  const metrics = new Map<string, { readonly key: string; readonly effect: LibraryEffect }>();
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
    records.edge('code.updates-metric', effect.holder, metric.key, libraryEvidence(effect), effect.span, String(effect.span.byteStart));
  }
  for (const effect of evaluated.effects.filter((effect) => effect.kind === 'metric-expose' || effect.kind === 'metric-register')) {
    records.gap(effect.span.path, `line ${effect.span.lineStart}: metric registry membership and route association require structural route facts [${effect.modelId}]`);
  }
}
