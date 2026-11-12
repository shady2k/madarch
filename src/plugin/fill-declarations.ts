/** Declaration-only fill validation. No plugin process or graph read is needed. */
import { resolve } from 'node:path';
import { byCodePoint } from '../model/order.js';
import { ClosureRefusal, pluginManifestLine, type PluginManifest } from './closure.js';
import type { KindsManifest } from '../product/manifest/kinds.js';

export type FillRead = NonNullable<PluginManifest['produces'][number]['reads']>[number];
export interface FillKindDeclaration {
  readonly name: string;
  readonly fields: readonly string[];
  readonly file: string;
  readonly line: number;
  readonly derivesFrom?: readonly string[];
}
export interface FillPluginDeclaration {
  readonly manifest: PluginManifest;
  readonly file: string;
  readonly text?: string;
}
export interface FillDeclarationInput {
  readonly kinds: readonly FillKindDeclaration[];
  readonly plugins: readonly FillPluginDeclaration[];
  readonly selectedKinds?: readonly string[];
  readonly agentSelected?: boolean;
}
interface ExpandedOutput {
  plugin: FillPluginDeclaration;
  index: number;
  kind: string;
  fields: readonly string[];
  declaration: PluginManifest['produces'][number];
}
export function planFillDeclarations(input: FillDeclarationInput) {
  const kinds = new Map(input.kinds.map((kind) => [kind.name, kind]));
  const plugins = new Map(input.plugins.map((plugin) => [plugin.manifest.name, plugin]));
  const location = (plugin: FillPluginDeclaration, path: readonly (string | number)[]) => `${resolve(plugin.file)}:${plugin.text === undefined ? 1 : pluginManifestLine(plugin.text, path)}`;
  const refuse = (plugin: FillPluginDeclaration, path: readonly (string | number)[], message: string): never => {
    const line = plugin.text === undefined ? 1 : pluginManifestLine(plugin.text, path);
    throw new ClosureRefusal('fill-declaration', `${location(plugin, path)}: ${message}`, resolve(plugin.file), line);
  };
  const kindRefusal = (kind: FillKindDeclaration, message: string): never => {
    throw new ClosureRefusal('fill-declaration', `${resolve(kind.file)}:${kind.line}: ${message}`, resolve(kind.file), kind.line);
  };
  const closure = new Map<string, Set<string>>();
  const kindStack: string[] = [];
  const prerequisites = (name: string): Set<string> => {
    if (kindStack.includes(name)) kindRefusal(kinds.get(name)!, `kind prerequisites form a cycle: ${[...kindStack, name].join(' -> ')}`);
    const cached = closure.get(name);
    if (cached !== undefined) return cached;
    const kind = kinds.get(name)!;
    kindStack.push(name);
    const result = new Set<string>();
    for (const parent of kind.derivesFrom ?? []) {
      if (!kinds.has(parent)) kindRefusal(kind, `${parent} is not a declared kind in produces, reads or derives-from`);
      result.add(parent);
      for (const ancestor of prerequisites(parent)) result.add(ancestor);
    }
    kindStack.pop();
    closure.set(name, result);
    return result;
  };
  for (const name of kinds.keys()) prerequisites(name);
  const expanded: ExpandedOutput[] = [];
  for (const plugin of input.plugins) {
    if (plugin.manifest.produces.length === 0) refuse(plugin, ['produces'], `plugin ${plugin.manifest.name} declares no output; declare produces, including Problem records for checks`);
    for (const [index, declaration] of plugin.manifest.produces.entries()) {
      const names = declaration.kind === '*' ? [...kinds.keys()] : [declaration.kind];
      for (const name of names) {
        const kind = kinds.get(name);
        if (kind === undefined) refuse(plugin, ['produces', index, 'kind'], `${name} is not a declared kind in produces, reads or derives-from`);
        const fields = declaration.fields === '*' ? kind!.fields : declaration.fields;
        for (const field of fields) if (!kind!.fields.includes(field)) refuse(plugin, ['produces', index, 'fields'], `plugin ${plugin.manifest.name} names undeclared field ${name}.${field}`);
        expanded.push({ plugin, index, kind: name, fields, declaration });
      }
    }
  }
  // Coverage is declaration-based; runtime omissions never activate another producer.
  const claims = expanded.filter((entry) => entry.declaration.coverage !== 'gaps');
  const entries = expanded.flatMap((entry) => {
    if (entry.declaration.coverage !== 'gaps') return [entry];
    const sameKind = claims.filter((claim) => claim.kind === entry.kind);
    const fields = entry.fields.filter((field) => !sameKind.some((claim) => claim.fields.includes(field)));
    return fields.length > 0 || (entry.fields.length === 0 && sameKind.length === 0) ? [{ ...entry, fields }] : [];
  });
  const allOutputs = new Map<string, Map<string, readonly string[]>>();
  const readVersions = new Map<string, Map<string, readonly FillRead[]>>();
  const fieldRefinements = new Map<string, Map<string, Set<string>>>();
  const refinements = new Map<string, Set<string>>();
  const concurrency = new Map<string, number>();
  const fieldKey = (kind: string, field: string) => JSON.stringify([kind, field]);
  const unitId = (plugin: string, kind: string) => JSON.stringify([plugin, kind]);
  const unitInfo = new Map<string, { plugin: string; kind: string }>();
  const unitEdges = new Map<string, Set<string>>();
  const addUnit = (plugin: string, kind: string) => {
    const id = unitId(plugin, kind);
    if (!unitInfo.has(id)) { unitInfo.set(id, { plugin, kind }); unitEdges.set(id, new Set()); }
    return id;
  };
  for (const plugin of input.plugins) {
    allOutputs.set(plugin.manifest.name, new Map());
    readVersions.set(plugin.manifest.name, new Map());
    refinements.set(plugin.manifest.name, new Set());
    concurrency.set(plugin.manifest.name, plugin.manifest.concurrency ?? 1);
  }
  for (const entry of entries) {
    const name = entry.plugin.manifest.name;
    const outputs = allOutputs.get(name)!;
    outputs.set(entry.kind, [...new Set([...(outputs.get(entry.kind) ?? []), ...entry.fields])]);
    addUnit(name, entry.kind);
    const reads = readVersions.get(name)!;
    reads.set(entry.kind, [...(reads.get(entry.kind) ?? []), ...(entry.declaration.reads ?? [])]);
  }
  const reachable = (from: string, to: string, edges: ReadonlyMap<string, ReadonlySet<string>>, seen = new Set<string>()): boolean => {
    if (seen.has(from)) return false;
    seen.add(from);
    return edges.get(from)?.has(to) === true || [...(edges.get(from) ?? [])].some((next) => reachable(next, to, edges, seen));
  };
  for (const entry of entries) {
    const name = entry.plugin.manifest.name;
    for (const [i, target] of (entry.declaration.refines ?? []).entries()) {
      const targets = target === '*' ? [...plugins.keys()].filter((other) => other !== name) : [target];
      for (const other of targets) {
        if (!plugins.has(other)) refuse(entry.plugin, ['produces', entry.index, 'refines', i], `plugin ${name} refines unknown or disabled plugin ${other}`);
        if (other === name) refuse(entry.plugin, ['produces', entry.index, 'refines', i], `fill declarations form a cycle: ${name} refines itself`);
        const otherFields = allOutputs.get(other)!.get(entry.kind);
        if (otherFields === undefined) continue;
        const overlap = entry.fields.length === 0 && otherFields.length === 0 ? ['*'] : entry.fields.filter((field) => otherFields.includes(field));
        if (overlap.length === 0) continue;
        refinements.get(name)!.add(other);
        unitEdges.get(unitId(name, entry.kind))!.add(unitId(other, entry.kind));
        for (const field of overlap) {
          const key = fieldKey(entry.kind, field);
          if (!fieldRefinements.has(key)) fieldRefinements.set(key, new Map());
          const relations = fieldRefinements.get(key)!;
          if (!relations.has(name)) relations.set(name, new Set());
          relations.get(name)!.add(other);
        }
      }
    }
  }
  // Every claimed field needs its own ordering relation; unrelated overlap cannot order it.
  for (const [a, left] of allOutputs) for (const [b, right] of allOutputs) {
    if (byCodePoint(a, b) >= 0) continue;
    for (const [kind, fields] of left) {
      const otherFields = right.get(kind);
      if (otherFields === undefined) continue;
      const overlap = fields.length === 0 && otherFields.length === 0 ? ['*'] : fields.filter((field) => otherFields.includes(field));
      for (const field of overlap) {
        const relations = fieldRefinements.get(fieldKey(kind, field)) ?? new Map<string, Set<string>>();
        if (!reachable(a, b, relations) && !reachable(b, a, relations)) refuse(plugins.get(a)!, ['produces'], `plugins ${a} and ${b} both produce ${kind}.${field} without a refinement relation; declare which refines which or disable one; other declaration ${location(plugins.get(b)!, ['produces'])}`);
      }
    }
  }
  for (const entry of entries) {
    const name = entry.plugin.manifest.name;
    for (const [i, read] of (entry.declaration.reads ?? []).entries()) {
      const kind = typeof read === 'string' ? read : read.kind;
      const path = ['produces', entry.index, 'reads', i];
      if (!kinds.has(kind)) refuse(entry.plugin, path, `${kind} is not a declared kind in produces, reads or derives-from`);
      const earlierSelf = typeof read !== 'string' && kind === entry.kind && (entry.declaration.refines ?? []).includes(read.producer);
      if (!prerequisites(entry.kind).has(kind) && !earlierSelf) refuse(entry.plugin, path, `plugin ${name} reads ${kind} for output ${entry.kind}, outside that output's prerequisite closure; add ${kind} to ${entry.kind}.derives-from or declare an earlier version of the producer being refined`);
      if (typeof read !== 'string' && !allOutputs.get(read.producer)?.has(kind)) refuse(entry.plugin, path, `earlier read of ${kind} names producer ${read.producer} without an enabled output of that kind`);
    }
  }
  for (const [name, output] of allOutputs) for (const kind of output.keys()) {
    const edges = unitEdges.get(unitId(name, kind))!;
    const reads = readVersions.get(name)!.get(kind) ?? [];
    const required = new Set([...(kinds.get(kind)?.derivesFrom ?? []), ...reads.map((read) => typeof read === 'string' ? read : read.kind)]);
    for (const readKind of required) {
      const versions = reads.filter((read) => (typeof read === 'string' ? read : read.kind) === readKind);
      const earlier = versions.filter((read): read is Exclude<FillRead, string> => typeof read !== 'string');
      const needsLatest = earlier.length === 0 || versions.some((read) => typeof read === 'string');
      if (needsLatest) for (const [producer, outputs] of allOutputs) {
        if (outputs.has(readKind)) edges.add(unitId(producer, readKind));
      }
      for (const read of earlier) edges.add(unitId(read.producer, readKind));
    }
  }
  const requested = input.selectedKinds ?? [...kinds.keys()];
  const selected = new Set<string>();
  for (const name of requested) {
    const kind = kinds.get(name);
    if (kind === undefined) throw new ClosureRefusal('fill-declaration', `${resolve(input.kinds[0]?.file ?? 'kinds.yaml')}:1: ${name} is not a declared kind in produces, reads or derives-from`, resolve(input.kinds[0]?.file ?? 'kinds.yaml'));
    for (const prerequisite of prerequisites(name)) selected.add(prerequisite);
    selected.add(name);
  }
  for (const name of selected) if (![...allOutputs.values()].some((output) => output.has(name))) kindRefusal(kinds.get(name)!, `selected kind ${name} has no enabled producer; enable its producer`);
  const sortedUnits: string[] = [];
  const visiting: string[] = [];
  const visited = new Set<string>();
  const visit = (id: string) => {
    const at = visiting.indexOf(id);
    const unit = unitInfo.get(id)!;
    if (at >= 0) refuse(plugins.get(unit.plugin)!, ['produces'], `fill declarations form a cycle: ${[...visiting.slice(at), id].map((key) => { const item = unitInfo.get(key)!; return `${item.plugin}:${item.kind}`; }).join(' -> ')}`);
    if (visited.has(id)) return;
    visiting.push(id);
    for (const dependency of [...unitEdges.get(id)!].sort(byCodePoint)) visit(dependency);
    visiting.pop(); visited.add(id); sortedUnits.push(id);
  };
  // Validate all configured declarations, including currently unselected units.
  for (const id of [...unitInfo.keys()].sort(byCodePoint)) visit(id);
  const activeUnits = sortedUnits.filter((id) => selected.has(unitInfo.get(id)!.kind));
  const order = [...new Set(activeUnits.map((id) => unitInfo.get(id)!.plugin))];
  const outputs = new Map(order.map((name) => [name, new Map([...allOutputs.get(name)!].filter(([kind]) => selected.has(kind)))]));
  if (input.agentSelected === false) for (const name of order) if (plugins.get(name)!.manifest.agent !== undefined) refuse(plugins.get(name)!, ['agent'], `plugin ${name} requested an agent but none is selected; choose --agent or select one in the wiki`);
  const unitPredecessors = (plugin: string, kind: string): { plugin: string; kind: string }[] => [...(unitEdges.get(unitId(plugin, kind)) ?? [])]
    .map((id) => unitInfo.get(id)!).filter((unit) => selected.has(unit.kind))
    .sort((a, b) => byCodePoint(`${a.plugin}:${a.kind}`, `${b.plugin}:${b.kind}`));
  const predecessors = new Map(order.map((name) => [name, [...new Set([...(outputs.get(name)?.keys() ?? [])].flatMap((kind) => unitPredecessors(name, kind).map((unit) => unit.plugin)))].filter((other) => other !== name).sort(byCodePoint)]));
  const readsFor = (plugin: string, kind: string): readonly FillRead[] => readVersions.get(plugin)?.get(kind) ?? [];
  return {
    unitPredecessors, readsFor, readVersions,
    reads: new Map([...readVersions].map(([name, output]) => [name, new Map([...output].map(([kind, reads]) => [kind, [...new Set(reads.map((read) => typeof read === 'string' ? read : read.kind))]]))])),
    selectedKinds: [...selected],
    requiresAgent: order.some((name) => plugins.get(name)!.manifest.agent !== undefined),
    order, outputs, refinements, concurrency, predecessors,
    // Readers need the declared refinement order even when no output is selected for execution.
    declaredProducers(kind: string, field: string): readonly string[] {
      return sortedUnits.map((id) => unitInfo.get(id)!).filter((unit) => unit.kind === kind && allOutputs.get(unit.plugin)?.get(kind)?.includes(field)).map((unit) => unit.plugin);
    },
    producers(kind: string, field: string): readonly string[] { return order.filter((name) => outputs.get(name)?.get(kind)?.includes(field)); },
    lastProducer(kind: string, field: string): string | undefined { return order.filter((name) => outputs.get(name)?.get(kind)?.includes(field)).at(-1); },
  };
}

export function planManifestFill(manifest: KindsManifest, folder: string, selectedKinds?: readonly string[], agentSelected?: boolean) {
  for (const plugin of manifest.plugins?.values() ?? []) {
    if (plugin.declaration === undefined) {
      const file = resolve(plugin.declarationFile ?? resolve(folder, plugin.path ?? '', 'plugin.json'));
      throw new ClosureRefusal('fill-declaration', `${file}:1: plugin ${plugin.id} declares no output; declare produces, including Problem records for checks`, file);
    }
  }
  const declarations = [...(manifest.plugins?.values() ?? [])].map((plugin) => ({ manifest: plugin.declaration!, file: plugin.declarationFile ?? resolve(folder, plugin.path ?? '', 'plugin.json'), text: plugin.declarationText }));
  for (const kind of manifest.kinds.values()) {
    if (kind.agent === undefined) continue;
    const target = declarations.find((plugin) => plugin.manifest.name === kind.agent!.plugin);
    const refuse = (message: string): never => { throw new ClosureRefusal('fill-declaration', `${resolve(manifest.file)}:${kind.line}: ${message}`, resolve(manifest.file), kind.line); };
    if (target === undefined || target.manifest.agent === undefined) refuse(`kind ${kind.name} configures unknown or disabled agent plugin ${kind.agent.plugin}`);
    const capability = target!.manifest.produces.find((output) => output.kind === '*' || output.kind === kind.name);
    if (capability === undefined) refuse(`agent plugin ${kind.agent.plugin} has no declared capability for ${kind.name}`);
    const fields = kind.agent.fields === '*' ? (kind.fields ?? []).map((field) => field.name) : kind.agent.fields;
    for (const field of fields) if (capability!.fields !== '*' && !capability!.fields.includes(field)) refuse(`agent plugin ${kind.agent.plugin} has no declared capability for ${kind.name}.${field}`);
    // Compile explicit configuration into an ordinary scoped producer declaration.
    target!.manifest = { ...target!.manifest, produces: [...target!.manifest.produces, { kind: kind.name, fields: kind.agent.fields === '*' ? '*' : [...kind.agent.fields], reads: capability!.reads, ...(kind.agent.refines === undefined ? {} : { refines: [...kind.agent.refines] }) }] };
  }
  // An agent wildcard advertises availability; only configured outputs participate in this plan.
  const executable = declarations.flatMap((plugin) => {
    const produces = plugin.manifest.produces.filter((output) => !(plugin.manifest.agent !== undefined && output.kind === '*' && output.coverage === 'gaps'));
    return produces.length === 0 ? [] : [{ ...plugin, manifest: { ...plugin.manifest, produces } }];
  });
  const requested = selectedKinds ?? [...manifest.kinds.keys()];
  const covered = new Set(executable.flatMap((plugin) => plugin.manifest.produces.flatMap((output) => output.kind === '*' ? [...manifest.kinds.keys()] : [output.kind])));
  const selected = new Set<string>();
  const collect = (name: string): void => {
    if (selected.has(name)) return;
    selected.add(name);
    for (const prerequisite of manifest.kinds.get(name)?.derivesFrom ?? []) collect(prerequisite);
  };
  for (const name of requested) collect(name);
  const unavailable = new Set([...selected].filter((name) => manifest.kinds.has(name) && !covered.has(name)));
  let changed = true;
  while (changed) {
    changed = false;
    for (const name of selected) {
      if (unavailable.has(name)) continue;
      if ((manifest.kinds.get(name)?.derivesFrom ?? []).some((parent) => unavailable.has(parent))) {
        unavailable.add(name);
        changed = true;
      }
    }
  }
  const unproducedKinds = [...unavailable].map((kind) => ({ kind, outcome: 'abstained' as const,
    reason: covered.has(kind) ? `required prerequisite has no configured producer for ${kind}` : `kind ${kind} has no configured producer; configure an ordinary producer or kind.agent`,
  }));
  const plan = planFillDeclarations({
    kinds: [...manifest.kinds.values()].map((kind) => ({ name: kind.name, fields: (kind.fields ?? []).map((field) => field.name), file: resolve(manifest.file), line: kind.line, derivesFrom: kind.derivesFrom })),
    plugins: executable,
    selectedKinds: requested.filter((name) => !unavailable.has(name)),
    ...(agentSelected === undefined ? {} : { agentSelected }),
  });
  return { ...plan, unproducedKinds };
}
