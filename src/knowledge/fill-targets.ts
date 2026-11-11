/**
 * The entities one fill is asked for (decision 0035, items 11 and 31; madarch-stm0.6): `madarch fill --entity <kind>`
 * fills that kind's turn, the kinds it depends on and the kinds that depend on it — "with what it depends on" and
 * "with its dependants" — in the dependency order the manifest's `depends-on` declares. The engine names no entity of
 * its own: the kinds, their dependencies and their words are the product's manifest, and a request that names a kind the
 * manifest does not declare is refused by name.
 *
 * A vertex fill (`--vertex <kind>:<key values>`) is the one exception to the cascade: it rewrites exactly that vertex,
 * because the reader asked for one value, not for the kind.
 */
import { byCodePoint } from '../model/order.js';
import type { KindsManifest } from './kinds.js';

/** Why a kind is in the set: the person asked for it, it is a dependency of one asked for, or it depends on one asked for. */
export type FillTargetReason = 'requested' | 'dependency' | 'dependant';

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

/** The kinds a kind depends on, as the manifest declares them, in code point order. */
function dependenciesOf(manifest: KindsManifest, kind: string): string[] {
  return [...(manifest.kinds.get(kind)?.dependsOn ?? [])].sort(byCodePoint);
}

/** A kind's line in the manifest, for a refusal that names it. */
function lineOf(manifest: KindsManifest, kind: string): number {
  return manifest.kinds.get(kind)?.line ?? 1;
}

/**
 * The set one request fills: the kinds asked for, every kind they need (item 11's dependency closure) and every kind
 * that depends on them (item 31's "with its dependants"), in dependency order. The walk is deterministic — code point
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
  const reasons = new Map<string, FillTargetEntry>();
  for (const kind of [...new Set(requested)].sort(byCodePoint)) reasons.set(kind, { kind, reason: 'requested', namedBy: kind });
  // What the requested kinds need, and what needs them: both closures, walked from the requested set only, so a kind
  // that is both (a relation the manifest would refuse) keeps the reason it was found by first.
  const queue = [...reasons.keys()].sort(byCodePoint);
  for (let at = 0; at < queue.length; at += 1) {
    const kind = queue[at]!;
    for (const dependency of dependenciesOf(manifest, kind)) {
      if (reasons.has(dependency)) continue;
      reasons.set(dependency, { kind: dependency, reason: 'dependency', namedBy: kind });
      queue.push(dependency);
    }
  }
  const dependants = new Map<string, string[]>();
  for (const kind of kinds) {
    for (const dependency of dependenciesOf(manifest, kind)) {
      const held = dependants.get(dependency) ?? [];
      held.push(kind);
      dependants.set(dependency, held);
    }
  }
  for (const list of dependants.values()) list.sort(byCodePoint);
  // What depends on the *requested* kinds, never on the dependencies the request added: asking to fill a term does not
  // ask for the kinds that read a file, and a fill of the files should not drag the whole catalogue in with them.
  const forward = [...new Set(requested)].sort(byCodePoint);
  const seenDependants = new Set(forward);
  const dependantQueue = [...forward].sort(byCodePoint);
  for (let at = 0; at < dependantQueue.length; at += 1) {
    const kind = dependantQueue[at]!;
    for (const dependant of dependants.get(kind) ?? []) {
      if (seenDependants.has(dependant)) continue;
      seenDependants.add(dependant);
      // The kind the person asked for, not the one in between: "doc.usage depends on doc.term" is what a reader acts on.
      const asked = reasons.get(kind);
      reasons.set(dependant, { kind: dependant, reason: 'dependant', namedBy: asked?.reason === 'requested' ? kind : asked?.namedBy ?? kind });
      dependantQueue.push(dependant);
    }
  }
  const order = dependencyOrdered(manifest, [...reasons.keys()]);
  if ('refuse' in order) return { ok: false, file: manifest.file, line: order.refuse.line, message: order.refuse.message };
  const entries = [...reasons.values()].sort((left, right) => byCodePoint(left.kind, right.kind));
  return { ok: true, targets: { order: order.order, entries } };
}

/**
 * The set in dependency order: every kind after the kinds it depends on that are in the set, ties in code point order.
 * A cycle among the set's kinds is refused with the kinds it walks — the manifest check refuses a cycle of the whole
 * graph, so this refusal is the one a hand-edited manifest meets before the check has run.
 */
function dependencyOrdered(manifest: KindsManifest, set: readonly string[]): { readonly order: string[] } | { readonly refuse: { readonly line: number; readonly message: string } } {
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
    for (const dependency of dependenciesOf(manifest, kind)) {
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
