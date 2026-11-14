/**
 * The entities one fill is asked for (decision 0035, items 11 and 31; madarch-stm0.6): `madarch fill --entity <kind>`
 * fills that kind and its transitive derives-from prerequisites only, in declaration order. The engine names no entity of
 * its own: the kinds, their dependencies and their words are the product's manifest, and a request that names a kind the
 * manifest does not declare is refused by name.
 *
 * A vertex fill (`--vertex <kind>:<key values>`) is the one exception to the cascade: it rewrites exactly that vertex,
 * because the reader asked for one value, not for the kind.
 */
import { byCodePoint } from '../model/order.js';
import { effectiveReadsOf, type FillDeclarationInput } from '../plugin/fill-declarations.js';
import type { KindsManifest } from '../product/manifest/kinds.js';

/** Why a kind is in the set: the person asked for it, it is a dependency of one asked for, or it depends on one asked for. */
export type FillTargetReason = 'requested' | 'dependency';

/** One kind in the set, and what put it there. */
export interface FillTargetEntry {
  readonly kind: string;
  readonly reason: FillTargetReason;
  /** The kind whose request brought this one in: the dependant for a dependency, the requested kind for a dependant. */
  readonly namedBy: string;
}

/** What one request asks to fill. */
export interface FillTargets {
  /** The kinds in dependency order: every kind after the kinds it depends on, and no kind before one it is needed by. */
  readonly order: readonly string[];
  /** The set with its reasons, in code point order, for the words a person reads. */
  readonly entries: readonly FillTargetEntry[];
  /** With a vertex: the one entity a vertex fill rewrites, in the graph's own id form (`<kind>:<key values>`). */
  readonly vertex?: string;
}

/** A request the manifest cannot satisfy, with the file, the line and what to change. */
export interface FillTargetRefusal {
  readonly ok: false;
  readonly file: string;
  readonly line: number;
  readonly message: string;
}

export type FillTargetRead = { readonly ok: true; readonly targets: FillTargets } | FillTargetRefusal;

/** The kinds a manifest declares, in code point order, for a refusal that lists what a request may name. */
function declared(manifest: KindsManifest): string[] {
  return [...manifest.kinds.keys()].sort(byCodePoint);
}

/**
 * The kinds one kind's turn needs: the kinds its concept rests on (`derives-from`) and the kinds its producers read. A
 * plugin's reads is the source tie, so a selective fill names both and runs their producers first.
 */
function dependenciesOf(manifest: KindsManifest, reads: (kind: string) => readonly string[], kind: string): string[] {
  return [...new Set([...(manifest.kinds.get(kind)?.derivesFrom ?? []), ...reads(kind)])].sort(byCodePoint);
}

/** The declarations a manifest hands the planner, so this listing reads the same gap coverage and reads it plans by. */
function declarationsOf(manifest: KindsManifest): FillDeclarationInput {
  return {
    kinds: [...manifest.kinds.values()].map((kind) => ({ name: kind.name, fields: (kind.fields ?? []).map((field) => field.name), file: manifest.file, line: kind.line, derivesFrom: kind.derivesFrom })),
    plugins: [...(manifest.plugins?.values() ?? [])].flatMap((plugin) => plugin.declaration === undefined ? [] : [{ manifest: plugin.declaration, file: plugin.declarationFile ?? manifest.file, ...(plugin.declarationText === undefined ? {} : { text: plugin.declarationText }) }]),
  };
}

/** A kind's line in the manifest, for a refusal that names it. */
function lineOf(manifest: KindsManifest, kind: string): number {
  return manifest.kinds.get(kind)?.line ?? 1;
}

/**
 * The set one request fills: the kinds asked for and every transitive prerequisite, in dependency order. The walk is deterministic — code point
 * order at every step — so two runs of one request plan the same units in the same order.
 */
export function fillTargets(manifest: KindsManifest, requested: readonly string[]): FillTargetRead {
  const kinds = declared(manifest);
  const unknown = [...new Set(requested)].filter((kind) => !manifest.kinds.has(kind)).sort(byCodePoint);
  if (unknown.length > 0) {
    return {
      ok: false,
      file: manifest.file,
      line: 1,
      message: `${manifest.file}:1: the fill asks for ${unknown.map((kind) => JSON.stringify(kind)).join(', ')}, and the product's manifest declares no such kind: it declares ${kinds.length === 0 ? 'none' : kinds.join(', ')}`,
    };
  }
  const declarations = declarationsOf(manifest);
  // A producer's earlier read of its own kind is its snapshot, not a prerequisite kind: it orders nothing new.
  const reads = (kind: string): readonly string[] => effectiveReadsOf(declarations, kind)
    .map((read) => typeof read === 'string' ? read : read.kind)
    .filter((read) => read !== kind);
  const reasons = new Map<string, FillTargetEntry>();
  for (const kind of [...new Set(requested)].sort(byCodePoint)) reasons.set(kind, { kind, reason: 'requested', namedBy: kind });
  /** The derives-from closure of the kinds given, level by level, so every direct dependency is named before its own. */
  const expand = (starts: readonly string[]): string[] => {
    const added: string[] = [];
    let level = [...starts];
    while (level.length > 0) {
      const next: string[] = [];
      for (const parent of level) {
        for (const dependency of [...(manifest.kinds.get(parent)?.derivesFrom ?? [])].sort(byCodePoint)) {
          if (reasons.has(dependency)) continue;
          reasons.set(dependency, { kind: dependency, reason: 'dependency', namedBy: parent });
          added.push(dependency);
          next.push(dependency);
        }
      }
      level = next;
    }
    return added;
  };
  // The kinds the request rests on, as the manifest declares them: the whole derives-from closure comes first, so a
  // kind it already names keeps the dependency a person knows. Then the kinds the selected producers read are added,
  // with their own derives-from closure: a plugin's reads is the source tie, so the files a term producer reads join.
  const queue = [...reasons.keys()].sort(byCodePoint);
  for (const added of [expand(queue)]) queue.push(...added);
  for (let at = 0; at < queue.length; at += 1) {
    const kind = queue[at]!;
    const read = reads(kind).filter((dependency) => !reasons.has(dependency));
    for (const dependency of read) {
      reasons.set(dependency, { kind: dependency, reason: 'dependency', namedBy: kind });
      queue.push(dependency);
    }
    for (const added of [expand(read)]) queue.push(...added);
  }
  const order = dependencyOrdered(manifest, [...reasons.keys()], (kind) => dependenciesOf(manifest, reads, kind));
  if ('refuse' in order) return { ok: false, file: manifest.file, line: order.refuse.line, message: order.refuse.message };
  const entries = [...reasons.values()].sort((left, right) => byCodePoint(left.kind, right.kind));
  return { ok: true, targets: { order: order.order, entries } };
}

/**
 * The set in dependency order: every kind after the kinds it depends on that are in the set, ties in code point order.
 * A cycle among the set's kinds is refused with the kinds it walks — the manifest check refuses a cycle of the whole
 * graph, so this refusal is the one a hand-edited manifest meets before the check has run.
 */
function dependencyOrdered(manifest: KindsManifest, set: readonly string[], dependencies: (kind: string) => readonly string[]): { readonly order: string[] } | { readonly refuse: { readonly line: number; readonly message: string } } {
  const held = new Set(set);
  const order: string[] = [];
  const done = new Set<string>();
  const active: string[] = [];
  const walk = (kind: string): { readonly line: number; readonly message: string } | undefined => {
    if (done.has(kind)) return undefined;
    const at = active.indexOf(kind);
    if (at >= 0) {
      const cycle = [...active.slice(at), kind].join(' -> ');
      return { line: lineOf(manifest, kind), message: `${manifest.file}:${String(lineOf(manifest, kind))}: the fill reaches the dependency cycle ${cycle}: the kinds' declared dependencies must form no cycle, so no fill starts while one stands` };
    }
    active.push(kind);
    for (const dependency of dependencies(kind)) {
      if (!held.has(dependency)) continue;
      const refused = walk(dependency);
      if (refused !== undefined) return refused;
    }
    active.pop();
    done.add(kind);
    order.push(kind);
    return undefined;
  };
  for (const kind of [...set].sort(byCodePoint)) {
    const refused = walk(kind);
    if (refused !== undefined) return { refuse: refused };
  }
  return { order };
}

/**
 * What one request asks to fill, from the command's own words: `--entity <kind>` any number of times, and `--vertex
 * <kind>:<key values>` for one entity only. A vertex fill names its kind in the key's first leg; the key's shape is the
 * graph's own id form, `<kind>:<key values joined by /">`.
 */
export function readFillTargets(manifest: KindsManifest, asked: { readonly entities?: readonly string[]; readonly vertex?: string }): FillTargetRead {
  const entities = [...(asked.entities ?? [])].map((kind) => kind.trim()).filter((kind) => kind !== '');
  if (asked.vertex !== undefined) {
    if (entities.length > 0) return { ok: false, file: manifest.file, line: 1, message: `${manifest.file}:1: --vertex fills one entity and --entity fills kinds: give one or the other, not both` };
    const vertex = asked.vertex.trim();
    const cut = vertex.indexOf(':');
    if (cut <= 0 || cut === vertex.length - 1) return { ok: false, file: manifest.file, line: 1, message: `${manifest.file}:1: --vertex ${JSON.stringify(asked.vertex)} is no entity id: an entity id is <kind>:<its key values>, such as ${declared(manifest)[0] ?? '<kind>'}:<value>` };
    const kind = vertex.slice(0, cut);
    if (!manifest.kinds.has(kind)) {
      return { ok: false, file: manifest.file, line: 1, message: `${manifest.file}:1: --vertex ${JSON.stringify(vertex)} names the kind ${JSON.stringify(kind)}, and the product's manifest declares no such kind: it declares ${declared(manifest).length === 0 ? 'none' : declared(manifest).join(', ')}` };
    }
    // One entity, and nothing around it: the reader asked for this value, not for its kind or the kinds that read it.
    return { ok: true, targets: { order: [kind], entries: [{ kind, reason: 'requested', namedBy: kind }], vertex } };
  }
  if (entities.length === 0) return { ok: false, file: manifest.file, line: 1, message: `${manifest.file}:1: --entity names at least one kind, or --vertex names one entity` };
  return fillTargets(manifest, entities);
}
