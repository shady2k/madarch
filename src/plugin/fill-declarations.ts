/** Declaration-only fill validation. No plugin process or graph read is needed. */
import { resolve } from 'node:path';
import { byCodePoint } from '../model/order.js';
import { ClosureRefusal, pluginManifestLine, type PluginManifest } from './closure.js';
import type { KindsManifest } from '../product/manifest/kinds.js';

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
  const outputs = new Map<string, Map<string, readonly string[]>>();
  const predecessors = new Map<string, Set<string>>();
  const refinements = new Map<string, Set<string>>();
  const concurrency = new Map<string, number>();
  for (const plugin of input.plugins) {
    const { manifest } = plugin;
    const output = new Map<string, readonly string[]>();
    if (manifest.produces.length === 0) refuse(plugin, ['produces'], `plugin ${manifest.name} declares no output; declare produces, including Problem records for checks`);
    for (const [i, produced] of manifest.produces.entries()) {
      const names = produced.kind === '*' ? [...kinds.keys()] : [produced.kind];
      for (const name of names) {
        const kind = kinds.get(name);
        if (kind === undefined) refuse(plugin, ['produces', i, 'kind'], `${name} is not a declared kind in produces, reads or derives-from`);
        const fields = produced.fields === '*' ? kind!.fields : produced.fields;
        for (const field of fields) if (!kind!.fields.includes(field)) refuse(plugin, ['produces', i, 'fields'], `plugin ${manifest.name} names undeclared field ${name}.${field}`);
        output.set(name, [...new Set([...(output.get(name) ?? []), ...fields])]);
      }
    }
    for (const [i, name] of manifest.reads.entries()) if (!kinds.has(name)) refuse(plugin, ['reads', i], `${name} is not a declared kind in produces, reads or derives-from`);
    outputs.set(manifest.name, output);
    predecessors.set(manifest.name, new Set());
    refinements.set(manifest.name, new Set());
    concurrency.set(manifest.name, manifest.concurrency ?? 1);
  }
  for (const kind of kinds.values()) for (const name of kind.derivesFrom ?? []) if (!kinds.has(name)) kindRefusal(kind, `${name} is not a declared kind in produces, reads or derives-from`);
  for (const plugin of input.plugins) {
    const name = plugin.manifest.name;
    for (const [i, target] of (plugin.manifest.refines ?? []).entries()) {
      const targets = target === '*' ? [...plugins.keys()].filter((other) => other !== name) : [target];
      for (const other of targets) {
        if (!plugins.has(other)) refuse(plugin, ['refines', i], `plugin ${name} refines unknown or disabled plugin ${other}`);
        refinements.get(name)!.add(other);
        predecessors.get(name)!.add(other);
      }
    }
  }
  const reachable = (from: string, to: string, edges: ReadonlyMap<string, ReadonlySet<string>>, seen = new Set<string>()): boolean => {
    if (seen.has(from)) return false;
    seen.add(from);
    return edges.get(from)?.has(to) === true || [...(edges.get(from) ?? [])].some((next) => reachable(next, to, edges, seen));
  };
  // A downstream refiner reads the reader's result, not the other way around.
  // Input kinds therefore name the snapshot before that reader's declared refinements.
  for (const plugin of input.plugins) {
    const name = plugin.manifest.name;
    for (const read of plugin.manifest.reads) for (const [other, output] of outputs) {
      if (other !== name && output.has(read) && !reachable(other, name, refinements)) predecessors.get(name)!.add(other);
    }
  }
  const order: string[] = [];
  const visiting: string[] = [];
  const visit = (name: string) => {
    const at = visiting.indexOf(name);
    if (at >= 0) refuse(plugins.get(name)!, ['refines'], `fill declarations form a cycle: ${[...visiting.slice(at), name].join(' -> ')}`);
    if (order.includes(name)) return;
    visiting.push(name);
    for (const previous of [...predecessors.get(name)!].sort()) visit(previous);
    visiting.pop();
    order.push(name);
  };
  for (const name of [...plugins.keys()].sort()) visit(name);
  for (const [a, left] of outputs) for (const [b, right] of outputs) {
    if (a >= b || reachable(a, b, refinements) || reachable(b, a, refinements)) continue;
    for (const [kind, fields] of left) {
      // Even a fieldless kind has entity membership, which is itself an overlapping output.
      const overlap = fields.find((field) => right.get(kind)?.includes(field));
      if (overlap !== undefined || (fields.length === 0 && right.has(kind))) refuse(plugins.get(a)!, ['produces'], `plugins ${a} and ${b} both produce ${kind}.${overlap ?? '*'} without a refinement relation; declare which refines which or disable one; other declaration ${location(plugins.get(b)!, ['produces'])}`);
    }
  }
  const selected = new Set(input.selectedKinds ?? [...kinds.keys()]);
  for (const name of selected) {
    const kind = kinds.get(name);
    if (kind === undefined) throw new ClosureRefusal('fill-declaration', `${resolve(input.kinds[0]?.file ?? 'kinds.yaml')}:1: ${name} is not a declared kind in produces, reads or derives-from`, resolve(input.kinds[0]?.file ?? 'kinds.yaml'));
    if (![...outputs.values()].some((output) => output.has(name))) kindRefusal(kind!, `selected kind ${name} has no enabled producer; enable its producer`);
  }
  const active = order.filter((name) => [...outputs.get(name)!.keys()].some((kind) => selected.has(kind)));
  if (input.agentSelected === false) for (const name of active) if (plugins.get(name)!.manifest.agent !== undefined) refuse(plugins.get(name)!, ['agent'], `plugin ${name} requested an agent but none is selected; choose --agent or select one in the wiki`);
  const unitPredecessors = (plugin: string, kind: string): { plugin: string; kind: string }[] => {
    const held = new Map<string, { plugin: string; kind: string }>();
    const add = (producer: string, output: string) => {
      if (selected.has(output)) held.set(`${producer}:${output}`, { plugin: producer, kind: output });
    };
    for (const previous of predecessors.get(plugin) ?? []) if (active.includes(previous)) for (const output of outputs.get(previous)!.keys()) add(previous, output);
    for (const prerequisite of kinds.get(kind)?.derivesFrom ?? []) for (const [producer, output] of outputs) {
      if (output.has(prerequisite) && !reachable(producer, plugin, refinements)) add(producer, prerequisite);
    }
    return [...held.values()].sort((a, b) => byCodePoint(`${a.plugin}:${a.kind}`, `${b.plugin}:${b.kind}`));
  };
  const visitedUnits = new Set<string>();
  const visitingUnits: string[] = [];
  const visitUnit = (plugin: string, kind: string) => {
    const id = `${plugin}:${kind}`;
    const at = visitingUnits.indexOf(id);
    if (at >= 0) refuse(plugins.get(plugin)!, ['reads'], `fill declarations form a cycle: ${[...visitingUnits.slice(at), id].join(' -> ')}`);
    if (visitedUnits.has(id)) return;
    visitingUnits.push(id);
    for (const dependency of unitPredecessors(plugin, kind)) visitUnit(dependency.plugin, dependency.kind);
    visitingUnits.pop();
    visitedUnits.add(id);
  };
  for (const plugin of active) for (const kind of outputs.get(plugin)!.keys()) if (selected.has(kind)) visitUnit(plugin, kind);
  return {
    unitPredecessors,
    order: active,
    outputs,
    refinements,
    concurrency,
    predecessors: new Map(active.map((name) => [name, [...predecessors.get(name)!].filter((other) => active.includes(other)).sort()])),
    producers(kind: string, field: string): readonly string[] {
      return order.filter((name) => outputs.get(name)?.get(kind)?.includes(field));
    },
    lastProducer(kind: string, field: string): string | undefined {
      return order.filter((name) => outputs.get(name)?.get(kind)?.includes(field)).at(-1);
    },
  };
}

export function planManifestFill(manifest: KindsManifest, folder: string, selectedKinds?: readonly string[], agentSelected?: boolean) {
  for (const plugin of manifest.plugins?.values() ?? []) {
    if (plugin.declaration === undefined) {
      const file = resolve(plugin.declarationFile ?? resolve(folder, plugin.path ?? '', 'plugin.json'));
      throw new ClosureRefusal('fill-declaration', `${file}:1: plugin ${plugin.id} declares no output; declare produces, including Problem records for checks`, file);
    }
  }
  const requested = selectedKinds ?? [...new Set([...(manifest.plugins?.values() ?? [])].flatMap((plugin) => plugin.declaration!.produces.flatMap((output) => output.kind === '*' ? [...manifest.kinds.keys()] : [output.kind])))];
  return planFillDeclarations({
    kinds: [...manifest.kinds.values()].map((kind) => ({ name: kind.name, fields: (kind.fields ?? []).map((field) => field.name), file: resolve(manifest.file), line: kind.line, derivesFrom: kind.derivesFrom })),
    plugins: [...(manifest.plugins?.values() ?? [])].filter((plugin) => plugin.declaration !== undefined).map((plugin) => ({ manifest: plugin.declaration!, file: plugin.declarationFile ?? resolve(folder, plugin.path ?? '', 'plugin.json'), text: plugin.declarationText })),
    selectedKinds: requested,
    ...(agentSelected === undefined ? {} : { agentSelected }),
  });
}
