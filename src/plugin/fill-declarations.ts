/** Declaration-only fill validation. No plugin process or graph read is needed. */
import { resolve } from 'node:path';
import { byCodePoint } from '../model/order.js';
import { ClosureRefusal, pluginManifestLine, type PluginManifest } from './closure.js';
import type { KindsManifest } from '../product/manifest/kinds.js';

export type FillRead = NonNullable<PluginManifest['produces'][number]['reads']>[number];
export interface FillKindDeclaration {
  readonly name: string;
  readonly fields: readonly string[];
  /** The kind's natural key: fields its producers state when they make the vertex, never a gap while a producer exists. */
  readonly key?: readonly string[];
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
  /** The declaration's reads that this kind's turn can make: never a kind that rests on the kind it fills. */
  reads: readonly FillRead[];
  declaration: PluginManifest['produces'][number];
}
/** Whether the kind `name` rests on `ancestor` through its declared `derives-from`. */
function restsOn(kinds: ReadonlyMap<string, { readonly derivesFrom?: readonly string[] }>, name: string, ancestor: string): boolean {
  const seen = new Set<string>();
  const walk = (held: string): boolean => {
    if (seen.has(held)) return false;
    seen.add(held);
    for (const parent of kinds.get(held)?.derivesFrom ?? []) {
      if (parent === ancestor || walk(parent)) return true;
    }
    return false;
  };
  return walk(name);
}

/**
 * A read an agent's turn cannot make: the kind it reads rests on the kind the turn fills, so that kind's producers run
 * after it and the read could never be answered. The agent's wildcard declares the files it works from for every kind, and
 * a repository's turn cannot read its own files back; such a read is left out. A deterministic producer's declared read
 * is never dropped: a read that would close a cycle is the manifest's error, refused by the unit graph.
 */
function forwardReads<T extends FillRead>(kinds: ReadonlyMap<string, { readonly derivesFrom?: readonly string[] }>, kind: string, reads: readonly T[], agent: boolean): T[] {
  return agent ? reads.filter((read) => !restsOn(kinds, typeof read === 'string' ? read : read.kind, kind)) : [...reads];
}

/**
 * The kinds a kind's producers read, over the outputs that actually run: an output fully covered by another producer's
 * claims is suppressed, and the reads of a suppressed producer are not inputs of the turn. This is the one gap-coverage
 * rule the fill plans by, and the one a selective fill lists its added kinds by.
 */
export function effectiveReadsOf(input: FillDeclarationInput, kind: string, asked?: ReadonlySet<string>): FillRead[] {
  const fieldsOf = (name: string): readonly string[] => input.kinds.find((entry) => entry.name === name)?.fields ?? [];
  const expanded: { declaration: FillPluginDeclaration['manifest']['produces'][number]; fields: readonly string[]; agent: boolean }[] = [];
  for (const plugin of input.plugins) {
    for (const declaration of plugin.manifest.produces) {
      if (declaration.kind !== '*' && declaration.kind !== kind) continue;
      expanded.push({ declaration, fields: declaration.fields === '*' ? fieldsOf(kind) : declaration.fields, agent: plugin.manifest.agent !== undefined });
    }
  }
  // A claim covers the kind's natural key too: the producer that makes a vertex states the key with it.
  const covered = new Set<string>(expanded.filter((entry) => entry.declaration.coverage !== 'gaps').flatMap((entry) => entry.fields));
  if (covered.size > 0) for (const field of input.kinds.find((entry) => entry.name === kind)?.key ?? []) covered.add(field);
  const effective = expanded.filter((entry) => entry.declaration.coverage !== 'gaps'
    || entry.fields.some((field) => !covered.has(field))
    || (entry.fields.length === 0 && covered.size === 0));
  const kinds = new Map(input.kinds.map((entry) => [entry.name, entry]));
  // An agent's fallback for a kind the fill was not asked for is not planned, so its reads are no input of this fill.
  const planned = (entry: { readonly declaration: FillPluginDeclaration['manifest']['produces'][number] }): boolean =>
    entry.declaration.coverage !== 'gaps' || asked === undefined || asked.has(kind);
  return effective.filter(planned).flatMap((entry) => forwardReads(kinds, kind, entry.declaration.reads ?? [], entry.agent));
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
  const supportKinds = new Set(input.plugins.flatMap((plugin) => plugin.manifest.produces.flatMap((output) => output.support?.vertices ?? [])));
  const expanded: ExpandedOutput[] = [];
  for (const plugin of input.plugins) {
    if (plugin.manifest.produces.length === 0) refuse(plugin, ['produces'], `plugin ${plugin.manifest.name} declares no output; declare produces, including Problem records for checks`);
    for (const [index, declaration] of plugin.manifest.produces.entries()) {
      const names = declaration.kind === '*' ? [...kinds.keys()].filter((name) => !supportKinds.has(name)) : [declaration.kind];
      for (const name of names) {
        const kind = kinds.get(name);
        if (kind === undefined) refuse(plugin, ['produces', index, 'kind'], `${name} is not a declared kind in produces, reads or derives-from`);
        const declared = declaration.fields === '*' ? kind!.fields : declaration.fields;
        for (const field of declared) if (!kind!.fields.includes(field)) refuse(plugin, ['produces', index, 'fields'], `plugin ${plugin.manifest.name} names undeclared field ${name}.${field}`);
        // A deterministic claim states the kind's natural key with the vertex it makes, so the key is that producer's
        // field too; an agent's scoped output states only the fields it was asked for.
        const fields = declaration.coverage === 'gaps' || plugin.manifest.agent !== undefined ? declared : [...new Set([...declared, ...(kind!.key ?? [])])];
        expanded.push({ plugin, index, kind: name, fields, reads: forwardReads(kinds, name, declaration.reads ?? [], plugin.manifest.agent !== undefined), declaration });
      }
    }
  }
  // Coverage is declaration-based; runtime omissions never activate another producer. An entry's fields already carry
  // the kind's natural key when the entry is a claim, so a key is never a gap while a producer of the kind runs.
  const claims = expanded.filter((entry) => entry.declaration.coverage !== 'gaps');
  const entries = expanded.flatMap((entry) => {
    if (entry.declaration.coverage !== 'gaps') return [entry];
    const sameKind = claims.filter((claim) => claim.kind === entry.kind);
    const covered = new Set<string>(sameKind.flatMap((claim) => claim.fields));
    const fields = entry.fields.filter((field) => !covered.has(field));
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
    reads.set(entry.kind, [...new Set([...(reads.get(entry.kind) ?? []), ...entry.reads])]);
  }
  const ordinaryScope = new Set<string>();
  const collectOrdinary = (kind: string): void => {
    if (ordinaryScope.has(kind)) return;
    ordinaryScope.add(kind);
    for (const parent of kinds.get(kind)?.derivesFrom ?? []) collectOrdinary(parent);
    for (const read of effectiveReadsOf(input, kind, new Set(input.selectedKinds ?? kinds.keys()))) collectOrdinary(typeof read === 'string' ? read : read.kind);
  };
  for (const kind of input.selectedKinds ?? kinds.keys()) collectOrdinary(kind);
  const supportOwners = (kind: string, reader: ExpandedOutput, producer?: string): ExpandedOutput[] => {
    const candidates = entries.filter((entry) => entry.declaration.support?.vertices.includes(kind) && (producer === undefined || entry.plugin.manifest.name === producer));
    const readKinds = new Set(reader.reads.map((read) => typeof read === 'string' ? read : read.kind));
    const sources = candidates.filter((entry) => readKinds.has(entry.kind));
    const scoped = candidates.filter((entry) => ordinaryScope.has(entry.kind));
    const owners = sources.length > 0 ? sources : scoped.length > 0 ? scoped : candidates;
    if (owners.length > 1) refuse(reader.plugin, ['produces', reader.index, 'reads'], `support read ${kind} has ambiguous owner units: ${owners.map((entry) => `${entry.plugin.manifest.name}:${entry.kind}`).sort(byCodePoint).join(', ')}; name an earlier producer or select its source kind`);
    return owners;
  };
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
    for (const [i, read] of entry.reads.entries()) {
      const kind = typeof read === 'string' ? read : read.kind;
      const path = ['produces', entry.index, 'reads', i];
      if (!kinds.has(kind)) refuse(entry.plugin, path, `${kind} is not a declared kind in produces, reads or derives-from`);
      // A plugin's own reads are its inputs, whatever the catalogue says a kind rests on: an output kind need not declare a
      // derives-from for each source its producer reads, and the unit's turn is ordered after the producers of those reads.
      if (typeof read !== 'string' && !allOutputs.get(read.producer)?.has(kind) && supportOwners(kind, entry, read.producer).length === 0) refuse(entry.plugin, path, `earlier read of ${kind} names producer ${read.producer} without an enabled output of that kind`);
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
      const reader = entries.find((entry) => entry.plugin.manifest.name === name && entry.kind === kind)!;
      if (needsLatest && ![...allOutputs.values()].some((output) => output.has(readKind))) for (const owner of supportOwners(readKind, reader)) edges.add(unitId(owner.plugin.manifest.name, owner.kind));
      if (needsLatest) for (const [producer, outputs] of allOutputs) {
        // A unit that reads its own kind reads what stands before its turn: it never waits for itself.
        if (producer === name && readKind === kind) continue;
        if (outputs.has(readKind)) edges.add(unitId(producer, readKind));
      }
      for (const read of earlier) {
        if (allOutputs.get(read.producer)?.has(readKind)) edges.add(unitId(read.producer, readKind));
        else for (const owner of supportOwners(readKind, reader, read.producer)) edges.add(unitId(owner.plugin.manifest.name, owner.kind));
      }
    }
  }
  const requested = input.selectedKinds ?? [...kinds.keys()];
  const selected = new Set<string>();
  // A kind's turn needs the kinds its concept rests on and the kinds its producers read: a plugin's reads is the source
  // tie, so the selected set follows both, recursively, and stands in that order — every dependency before its dependant.
  const collecting = new Set<string>();
  const askedKinds = new Set(requested);
  const collect = (name: string): void => {
    if (selected.has(name) || collecting.has(name)) return;
    collecting.add(name);
    for (const prerequisite of kinds.get(name)?.derivesFrom ?? []) collect(prerequisite);
    for (const read of effectiveReadsOf(input, name, askedKinds)) collect(typeof read === 'string' ? read : read.kind);
    collecting.delete(name);
    selected.add(name);
  };
  for (const name of requested) {
    if (!kinds.has(name)) throw new ClosureRefusal('fill-declaration', `${resolve(input.kinds[0]?.file ?? 'madarch/catalog.yaml')}:1: ${name} is not a declared kind in produces, reads or derives-from`, resolve(input.kinds[0]?.file ?? 'madarch/catalog.yaml'));
    collect(name);
  }
  let selectedCount: number;
  do {
    selectedCount = selected.size;
    for (const [id, unit] of unitInfo) if (selected.has(unit.kind)) for (const dependency of unitEdges.get(id)!) collect(unitInfo.get(dependency)!.kind);
  } while (selected.size !== selectedCount);
  // A kind that declares no field has nothing for a producer to state: it needs none, and it is no silence.
  for (const name of selected) if ((kinds.get(name)?.fields.length ?? 0) > 0 && ![...allOutputs.values()].some((output) => output.has(name)) && !entries.some((entry) => selected.has(entry.kind) && entry.declaration.support?.vertices.includes(name))) kindRefusal(kinds.get(name)!, `selected kind ${name} has no enabled producer; enable its producer`);
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
  const units = activeUnits.map((id) => unitInfo.get(id)!);
  const order = [...new Set(units.map((unit) => unit.plugin))];
  const outputs = new Map(order.map((name) => [name, new Map([...allOutputs.get(name)!].filter(([kind]) => selected.has(kind)))]));
  // Which plugin fills which field of a kind, in the order the kind's turns run: the unit order, never the deduplicated
  // plugin order a plugin's first unit of another kind would put it by (madarch-64o5.49).
  const producersOf = (kind: string, field: string): readonly string[] => units
    .filter((unit) => unit.kind === kind && outputs.get(unit.plugin)?.get(kind)?.includes(field))
    .map((unit) => unit.plugin);
  const fieldProducers = (kind: string): ReadonlyMap<string, readonly string[]> => new Map(
    (kinds.get(kind)?.fields ?? []).map((field) => [field, producersOf(kind, field)]),
  );
  // Every field the plan leaves to an agent: the agent is every kind's filler of last resort (decision 0035, item 22).
  const agentNeeds = [...new Set(units.filter((unit) => plugins.get(unit.plugin)!.manifest.agent !== undefined).map((unit) => unit.kind))]
    .sort(byCodePoint)
    .map((kind) => ({ kind, fields: (kinds.get(kind)?.fields ?? []).filter((field) => producersOf(kind, field).some((name) => plugins.get(name)!.manifest.agent !== undefined)) }));
  if (input.agentSelected === false && agentNeeds.length > 0) {
    const first = units.find((unit) => unit.kind === agentNeeds[0]!.kind && plugins.get(unit.plugin)!.manifest.agent !== undefined)!;
    refuse(plugins.get(first.plugin)!, ['agent'], agentNeedMessage(agentNeeds));
  }
  const unitPredecessors = (plugin: string, kind: string): { plugin: string; kind: string }[] => [...(unitEdges.get(unitId(plugin, kind)) ?? [])]
    .map((id) => unitInfo.get(id)!).filter((unit) => selected.has(unit.kind))
    .sort((a, b) => byCodePoint(`${a.plugin}:${a.kind}`, `${b.plugin}:${b.kind}`));
  const predecessors = new Map(order.map((name) => [name, [...new Set([...(outputs.get(name)?.keys() ?? [])].flatMap((kind) => unitPredecessors(name, kind).map((unit) => unit.plugin)))].filter((other) => other !== name).sort(byCodePoint)]));
  const readsFor = (plugin: string, kind: string): readonly FillRead[] => readVersions.get(plugin)?.get(kind) ?? [];
  return {
    unitPredecessors, readsFor, readVersions,
    reads: new Map([...readVersions].map(([name, output]) => [name, new Map([...output].map(([kind, reads]) => [kind, [...new Set(reads.map((read) => typeof read === 'string' ? read : read.kind))]]))])),
    selectedKinds: [...selected],
    requiresAgent: agentNeeds.length > 0,
    agentNeeds, fieldProducers,
    order, outputs, refinements, concurrency, predecessors,
    // Readers need the declared refinement order even when no output is selected for execution.
    declaredProducers(kind: string, field: string): readonly string[] {
      return sortedUnits.map((id) => unitInfo.get(id)!).filter((unit) => unit.kind === kind && allOutputs.get(unit.plugin)?.get(kind)?.includes(field)).map((unit) => unit.plugin);
    },
    producers: producersOf,
    lastProducer(kind: string, field: string): string | undefined { return producersOf(kind, field).at(-1); },
  };
}

/** One kind, and the fields of it the plan leaves to an agent because no deterministic producer claims them. */
export interface AgentNeed {
  readonly kind: string;
  readonly fields: readonly string[];
}

/**
 * What a person must choose before such a plan runs, in words the command and the route both use: the kinds and fields
 * the agent fills, and the flags that choose one.
 */
export function agentNeedMessage(needs: readonly AgentNeed[]): string {
  const held = [...needs].sort((left, right) => byCodePoint(left.kind, right.kind));
  const said = held.map((need) => `${need.kind} (${need.fields.length === 0 ? 'its entities' : need.fields.join(', ')})`).join(' and ');
  return `the fill leaves ${said} to an agent, and none is chosen: name one with --agent <id>, cap its spend with --token-cap <n>, or select an agent in the wiki`;
}

/** One kind or field the manifest names a producer for and does not hold: a manifest error, named by the plan. */
export interface FillPlanError {
  readonly kind: string;
  /** The fields of the kind whose binding names the absent plugin. */
  readonly fields: readonly string[];
  /** The plugin the manifest names for those fields and does not hold. */
  readonly plugin?: string;
  readonly message: string;
}

/**
 * One kind or field no enabled producer fills, in a product that holds no agent plugin: skipped, never failed. A product
 * without an agent fills what its plugins fill and leaves the rest (decision 0035, item 22), and says so.
 */
export interface FillPlanSkip {
  readonly kind: string;
  readonly fields: readonly string[];
  readonly reason: string;
}

/**
 * The producer a kind's unproduced fields name and the product lacks, in words: the plugin a binding names. Only a field
 * that names a plugin the manifest does not hold is the manifest's error; a field with no producer at all, or one bound to
 * the agent while the product holds no agent plugin, is a skip — a product without an agent fills what its plugins fill
 * and leaves the rest (decision 0035, item 22), it does not fail.
 */
function missingProducer(manifest: KindsManifest, kind: string, fields: readonly string[], configured?: string): { plugin?: string; message: string } | undefined {
  const declaration = manifest.kinds.get(kind);
  const chosen = (declaration?.fields ?? []).filter((field) => fields.length === 0 || fields.includes(field.name));
  const absent = configured ?? chosen.flatMap((field) => field.binding?.kind === 'plugin' ? [field.binding.plugin] : []).find((plugin) => manifest.plugins?.has(plugin) !== true);
  return absent === undefined ? undefined : { plugin: absent, message: `the manifest declares no plugin "${absent}"` };
}

/** The error a kind makes when its declaration names a plugin the manifest does not hold. */
function fillPlanError(manifest: KindsManifest, kind: string, configured?: string): FillPlanError | undefined {
  const fields = (manifest.kinds.get(kind)?.fields ?? []).map((field) => field.name).sort(byCodePoint);
  const missing = missingProducer(manifest, kind, fields, configured);
  if (missing === undefined) return undefined;
  const said = fields.length === 0 ? 'its entities' : fields.map((field) => `"${field}"`).join(', ');
  return { kind, fields, ...(missing.plugin === undefined ? {} : { plugin: missing.plugin }), message: `kind "${kind}": the ${fields.length === 1 ? 'field' : 'fields'} ${said} ${fields.length === 1 ? 'has' : 'have'} no producer: ${missing.message}` };
}

/** The error one kind nothing produces makes when the product holds an agent: it is named before the run, never skipped. */
function fillPlanUnproducibleError(unavailable: ReadonlySet<string>, kind: string, input: FillDeclarationInput): FillPlanError {
  const skip = fillPlanSkip(unavailable, kind, input);
  return { kind, fields: skip.fields, message: `kind "${kind}" cannot be filled: ${skip.reason}` };
}

/** Why one kind no producer fills is left out: its own fields, or the prerequisite or input that is missing. */
function fillPlanSkip(unavailable: ReadonlySet<string>, kind: string, input: FillDeclarationInput): FillPlanSkip {
  const declaration = input.kinds.find((entry) => entry.name === kind);
  const blockedParent = [...(declaration?.derivesFrom ?? [])].find((parent) => unavailable.has(parent));
  if (blockedParent !== undefined) return { kind, fields: [], reason: `its prerequisite "${blockedParent}" has no producer in the manifest` };
  const blockedInput = effectiveReadsOf(input, kind).map((read) => typeof read === 'string' ? read : read.kind).find((read) => read !== kind && unavailable.has(read));
  if (blockedInput !== undefined) return { kind, fields: [], reason: `its input "${blockedInput}" has no producer in the manifest` };
  return { kind, fields: [...(declaration?.fields ?? [])].sort(byCodePoint), reason: 'no producer in the manifest' };
}

/**
 * The fill a product's manifest plans (decision 0035, items 1, 11, 22): every selected kind's deterministic producers, and
 * the agent for the fields no deterministic producer claims. The agent's wildcard capability (`kind: "*"`, coverage
 * `gaps`) becomes one output per declared kind, so the plan can say which fields each plugin fills and which are the
 * agent's, and the gap rule keeps exactly the fields no claim covers.
 *
 * `agentSelected` is whether a person chose an agent for this fill. A plan that holds the agent and has none chosen is
 * refused, naming the kinds and fields the agent would fill (madarch-64o5.63): those kinds never run without one, and
 * they are never called unfillable.
 */
export function planManifestFill(manifest: KindsManifest, folder: string, selectedKinds?: readonly string[], agentSelected?: boolean, requestedKinds?: readonly string[], pluginsOnly = false) {
  for (const plugin of manifest.plugins?.values() ?? []) {
    if (plugin.declaration === undefined) {
      const file = resolve(plugin.declarationFile ?? resolve(folder, plugin.path ?? '', 'plugin.json'));
      throw new ClosureRefusal('fill-declaration', `${file}:1: plugin ${plugin.id} declares no output; declare produces, including Problem records for checks`, file);
    }
  }
  const declarations = [...(manifest.plugins?.values() ?? [])].map((plugin) => ({ manifest: plugin.declaration!, file: plugin.declarationFile ?? resolve(folder, plugin.path ?? '', 'plugin.json'), text: plugin.declarationText }));
  // A manifest read for its declarations alone still refuses a kind that configures a plugin it does not hold; a fill
  // records that kind's error and fills the others (madarch-64o5.60).
  const validating = selectedKinds !== undefined && selectedKinds.length === 0 && requestedKinds === undefined;
  const configuredMissing = new Map<string, string>();
  for (const kind of manifest.kinds.values()) {
    if (kind.agent === undefined) continue;
    const target = declarations.find((plugin) => plugin.manifest.name === kind.agent!.plugin);
    const refuse = (message: string): never => { throw new ClosureRefusal('fill-declaration', `${resolve(manifest.file)}:${kind.line}: ${message}`, resolve(manifest.file), kind.line); };
    if (target === undefined || target.manifest.agent === undefined) {
      if (validating) refuse(`kind ${kind.name} configures unknown or disabled agent plugin ${kind.agent.plugin}`);
      configuredMissing.set(kind.name, kind.agent.plugin);
      continue;
    }
    const capability = target!.manifest.produces.find((output) => output.kind === '*' || output.kind === kind.name);
    if (capability === undefined) refuse(`agent plugin ${kind.agent.plugin} has no declared capability for ${kind.name}`);
    const fields = kind.agent.fields === '*' ? (kind.fields ?? []).map((field) => field.name) : kind.agent.fields;
    for (const field of fields) if (capability!.fields !== '*' && !capability!.fields.includes(field)) refuse(`agent plugin ${kind.agent.plugin} has no declared capability for ${kind.name}.${field}`);
    // Compile explicit configuration into an ordinary scoped producer declaration.
    target!.manifest = { ...target!.manifest, produces: [...target!.manifest.produces, { kind: kind.name, fields: kind.agent.fields === '*' ? '*' : [...kind.agent.fields], reads: capability!.reads, ...(kind.agent.refines === undefined ? {} : { refines: [...kind.agent.refines] }) }] };
  }
  // The agent's wildcard capability is every kind's filler of last resort (decision 0035, item 22): one output per
  // declared kind, so the plan can name the fields the agent fills beside each deterministic producer and keep exactly
  // the fields no claim covers. A kind that declares no field has nothing for any producer to state, so it is no gap.
  const supportKinds = new Set(declarations.flatMap((plugin) => plugin.manifest.produces.flatMap((output) => output.support?.vertices ?? [])));
  const fielded = (name: string): boolean => manifest.kinds.get(name)?.profileMarkers === undefined && (manifest.kinds.get(name)?.fields ?? []).length > 0;
  // The agent fills the gaps of the kinds the fill was asked for: a kind that only joins the fill as an input of an asked
  // kind runs its deterministic producers, and its own agent gaps wait for a fill that asks for it (madarch-64o5.63).
  const asked = new Set(requestedKinds ?? selectedKinds ?? [...manifest.kinds.keys()]);
  // A field the manifest binds to the agent is the agent's: no deterministic plugin's `fields: "*"` claims it, whatever
  // that shorthand means for the rest of the kind (madarch-64o5.63, decision 0035 item 17).
  const agentBound = (kind: string): ReadonlySet<string> => new Set((manifest.kinds.get(kind)?.fields ?? [])
    .filter((field) => field.binding?.kind === 'agent').map((field) => field.name));
  const executable = declarations.map((plugin) => {
    if (plugin.manifest.agent === undefined) {
      // A blanket output names the kind's fields the manifest does not bind to the agent: an agent-bound field is the
      // agent's alone (decision 0035, item 17).
      const produces = plugin.manifest.produces.map((output) => {
        const kind = output.kind === '*' ? undefined : manifest.kinds.get(output.kind);
        if (output.fields !== '*' || kind === undefined) return output;
        const bound = agentBound(kind.name);
        return bound.size === 0 ? output : { ...output, fields: (kind.fields ?? []).map((field) => field.name).filter((name) => !bound.has(name)) };
      });
      return { ...plugin, manifest: { ...plugin.manifest, produces } };
    }
    const produces = plugin.manifest.produces.flatMap((output) => {
      if (output.kind !== '*') return [output];
      // A manifest read for its declarations alone (no kind selected) expands the wildcard over every fielded kind, so
      // its reads are judged by the same rule; nothing of it is planned.
      const fieldedKinds = [...manifest.kinds.keys()].filter((name) => fielded(name) && !supportKinds.has(name));
      const scoped = fieldedKinds.filter((kind) => asked.size === 0 || asked.has(kind));
      const chosen = scoped.length > 0 ? scoped : fieldedKinds;
      if (chosen.length === 0) return [output];
      return chosen.map((kind) => ({ ...output, kind, fields: '*' as const }));
    });
    return { ...plugin, manifest: { ...plugin.manifest, produces } };
  });
  const requested = selectedKinds ?? [...manifest.kinds.keys()];
  const declared = [...manifest.kinds.values()].map((kind) => ({ name: kind.name, fields: kind.profileMarkers === undefined ? (kind.fields ?? []).map((field) => field.name) : [], key: kind.key, file: resolve(manifest.file), line: kind.line, derivesFrom: kind.derivesFrom }));
  // The declarations the plan hands the planner: one source of the reads a kind's turn takes.
  const input: FillDeclarationInput = { kinds: declared, plugins: executable };
  const askedKinds = new Set(requested);
  const covered = new Set(executable.flatMap((plugin) => plugin.manifest.produces.flatMap((output) => [...(output.kind === '*' ? [...manifest.kinds.keys()].filter((name) => !supportKinds.has(name)) : [output.kind]), ...(output.support?.vertices ?? [])])));
  const selected = new Set<string>();
  const collect = (name: string): void => {
    if (selected.has(name)) return;
    selected.add(name);
    for (const prerequisite of manifest.kinds.get(name)?.derivesFrom ?? []) collect(prerequisite);
    for (const read of effectiveReadsOf(input, name, askedKinds)) collect(typeof read === 'string' ? read : read.kind);
  };
  for (const name of requested) collect(name);
  // A selected kind no output at all names — a manifest that keeps no producer for it, not even the agent — is reported
  // by name and left out, so the kinds that can run still do. A kind the agent covers is never in this set.
  // A product that holds no agent plugin and whose kind is written by people only has nothing to extract: its fields
  // are a person's authored write, not a gap and not an error.
  const hasAgent = declarations.some((plugin) => plugin.manifest.agent !== undefined);
  const authoredOnly = (name: string): boolean => {
    const declared = manifest.kinds.get(name)?.fields ?? [];
    return declared.length > 0 && declared.every((field) => (field.producers ?? []).includes('person'));
  };
  const nothingToFill = new Set(hasAgent ? [] : [...selected].filter((name) => authoredOnly(name)));
  const unavailable = new Set([...selected].filter((name) => fielded(name) && !covered.has(name) && !nothingToFill.has(name)));
  for (const name of configuredMissing.keys()) if (selected.has(name)) unavailable.add(name);
  // A kind that rests on an unproduced kind, or reads one, cannot be filled either: the run reports that kind and lets
  // the kinds that do not depend on it run.
  let changed = true;
  while (changed) {
    changed = false;
    for (const name of selected) {
      if (unavailable.has(name) || !fielded(name)) continue;
      const needs = [...(manifest.kinds.get(name)?.derivesFrom ?? []),
        ...effectiveReadsOf(input, name, askedKinds).map((read) => typeof read === 'string' ? read : read.kind).filter((read) => read !== name)];
      if (needs.some((dependency) => unavailable.has(dependency))) {
        unavailable.add(name);
        changed = true;
      }
    }
  }
  // A kind whose declaration names a plugin the manifest does not hold is the manifest's error. A kind nothing produces
  // is the plan's error too when the product holds an agent — a kind the agent cannot fill is named before the run, never
  // skipped in silence — and is skipped, with its reason, only where the product holds no agent plugin at all: such a
  // product fills what its plugins fill and leaves the rest (decision 0035, item 22).
  const errors = [...unavailable].sort(byCodePoint)
    .map((kind) => fillPlanError(manifest, kind, configuredMissing.get(kind)))
    .filter((error): error is FillPlanError => error !== undefined);
  if (hasAgent) for (const kind of [...unavailable].sort(byCodePoint)) {
    if (!errors.some((error) => error.kind === kind)) errors.push(fillPlanUnproducibleError(unavailable, kind, input));
  }
  const skipped: FillPlanSkip[] = hasAgent ? [] : [...unavailable].filter((kind) => !errors.some((error) => error.kind === kind)).sort(byCodePoint)
    .map((kind) => fillPlanSkip(unavailable, kind, input));
  const plan = planFillDeclarations({
    kinds: declared,
    plugins: executable,
    selectedKinds: requested.filter((name) => !unavailable.has(name) && !nothingToFill.has(name)),
    agentSelected: true,
  });
  if (pluginsOnly) {
    // A plugins-only press runs every deterministic producer and leaves the agent's fields unfilled: the agent's output
    // is not planned, so the plan needs no agent and refuses nothing. The full plan's `agentNeeds` is kept for the page,
    // which says which fields this press will not fill.
    const deterministicPlugins = executable.filter((plugin) => plugin.manifest.agent === undefined);
    const deterministic = new Set(deterministicPlugins.flatMap((plugin) => plugin.manifest.produces.flatMap((output) => output.kind === '*' ? [...manifest.kinds.keys()] : [output.kind])));
    const runSelected = requested.filter((name) => !unavailable.has(name) && !nothingToFill.has(name) && (deterministic.has(name) || !fielded(name)));
    const run = planFillDeclarations({
      kinds: declared,
      plugins: deterministicPlugins,
      selectedKinds: runSelected,
      agentSelected: true,
    });
    return { ...run, errors, skipped, agentNeeds: plan.agentNeeds, fieldProducers: plan.fieldProducers, pluginsOnly: true };
  }
  // A field no producer fills is never silent: a field whose binding names a plugin the manifest lacks is an error, and
  // any other is skipped with its kind and fields (codex review, P2). A field the manifest names a person for is that
  // person's write, and a dependency kind's gaps are not this fill's ask.
  const authoredFields = (kind: string): ReadonlySet<string> => new Set((manifest.kinds.get(kind)?.fields ?? [])
    .filter((field) => (field.producers ?? []).includes('person')).map((field) => field.name));
  const fieldOf = (kind: string, field: string) => manifest.kinds.get(kind)?.fields?.find((one) => one.name === field);
  // What the person asked for: a page can name the plan's kinds — a pulled-in dependency among them — so the ask is the
  // requested selection when there is one, and never a dependency the plan pulled in (madarch-64o5.102).
  const askedSet = new Set(requestedKinds ?? requested);
  for (const kind of plan.selectedKinds) {
    if (manifest.kinds.get(kind)?.profileMarkers !== undefined) continue;
    if (unavailable.has(kind) || nothingToFill.has(kind)) continue;
    const authored = authoredFields(kind);
    const empty = [...plan.fieldProducers(kind)].filter(([field, producers]) => producers.length === 0 && !authored.has(field)).map(([field]) => field);
    if (empty.length === 0) continue;
    if (!askedSet.has(kind)) {
      // A kind this fill pulls in only as a prerequisite or input is not asked for: its agent-filled fields are unfilled
      // here, and named so the page can say so (madarch-64o5.102, 64o5.63). A field bound to a plugin the manifest does
      // not hold is still the manifest's error, exactly as for an asked kind — a pull-in hides no manifest mistake.
      const missing = empty.filter((field) => fieldOf(kind, field)?.binding?.kind === 'plugin' && manifest.plugins?.has((fieldOf(kind, field)!.binding as { plugin: string }).plugin) !== true);
      if (missing.length > 0) {
        const error = fillPlanError(manifest, kind);
        if (error !== undefined) errors.push({ ...error, fields: missing });
      }
      const rest = empty.filter((field) => !missing.includes(field)).sort(byCodePoint);
      if (rest.length > 0) skipped.push({ kind, fields: rest, reason: 'the agent fills it, and this fill does not ask for this kind' });
      continue;
    }
    const named = empty.filter((field) => fieldOf(kind, field)?.binding?.kind === 'plugin' && manifest.plugins?.has((fieldOf(kind, field)!.binding as { plugin: string }).plugin) !== true);
    if (named.length > 0) {
      const error = fillPlanError(manifest, kind);
      if (error !== undefined) errors.push({ ...error, fields: named });
    }
    const rest = empty.filter((field) => !named.includes(field));
    // With an agent the plan can leave no field unproduced unannounced: it is the plan's error, named with the kind.
    if (rest.length > 0 && hasAgent) {
      errors.push({ kind, fields: rest, message: `kind "${kind}": the ${rest.length === 1 ? 'field' : 'fields'} ${rest.map((field) => `"${field}"`).join(', ')} ${rest.length === 1 ? 'has' : 'have'} no producer in the manifest` });
    } else if (rest.length > 0) skipped.push({ kind, fields: rest, reason: 'no producer in the manifest' });
  }
  errors.sort((left, right) => byCodePoint(left.kind, right.kind) || byCodePoint(left.fields.join('\u0000'), right.fields.join('\u0000')));
  skipped.sort((left, right) => byCodePoint(left.kind, right.kind) || byCodePoint(left.fields.join('\u0000'), right.fields.join('\u0000')));
  if (agentSelected === false && plan.agentNeeds.length > 0) {
    throw new ClosureRefusal('fill-declaration', `${resolve(manifest.file)}:1: ${agentNeedMessage(plan.agentNeeds)}`, resolve(manifest.file), 1);
  }
  return { ...plan, errors, skipped, pluginsOnly: false };
}
