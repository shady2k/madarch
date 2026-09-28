/**
 * The problems the model check reports (docs/changes/agent-model/
 * capabilities/model-check.md, requirement problems): six kinds, each the
 * small function that finds it, each naming the method that defines it, its
 * source and the model ids involved. Problems never fail the check; the
 * check calls them all and prints them between its stale items and its
 * warnings.
 *
 * The level a problem is found at is the view set's collapsing (see
 * `buildViewSet`): "at a level" means among the children of one parent and
 * among the elements without a parent, and an arrow is the view's arrow
 * whose ends are both inside that level, carrying the relation ids behind
 * it. No second collapse is written here.
 */
import type { CompiledModel } from '../model/compile.js';
import { byCodePoint, sortedByCodePoint } from '../model/order.js';
import { messagingOf } from '../model/contracts.js';
import type { View } from '../render/view-set.js';

/** The kinds of problem the check looks for, in the order it prints them. */
export type ProblemKind = 'cycle' | 'unstable-dependency' | 'hub' | 'magic-source-or-sink' | 'trust-boundary-crossing' | 'hidden-coupling';

export const PROBLEM_KINDS: readonly ProblemKind[] = ['cycle', 'unstable-dependency', 'hub', 'magic-source-or-sink', 'trust-boundary-crossing', 'hidden-coupling'];

/** One problem found: the kind, the method and its source that define it, the model ids involved, and what decided it. */
export interface ProblemFinding {
  problem: ProblemKind;
  method: string;
  source: string;
  /** The elements, relations and interfaces involved, code-point order. */
  ids: string[];
  message: string;
}

/** An element with this many relations in and out at its level is a hub. */
export const HUB_THRESHOLD = 5;
/** Hidden coupling counts commits whose date is within this many days before the checked revision's. */
export const HIDDEN_COUPLING_WINDOW_DAYS = 180;
/** Hidden coupling needs at least this many co-change commits. */
export const HIDDEN_COUPLING_MIN_COMMITS = 5;
/** A commit touching more files than this is a bulk change and is skipped: bulk changes are noise. */
export const BULK_COMMIT_FILES = 30;

/** The method that defines each kind, verbatim. */
const METHOD_BY_KIND: Record<ProblemKind, string> = {
  cycle: 'Acyclic Dependencies Principle; Arcan Cyclic Dependency',
  'unstable-dependency': 'Stable Dependencies Principle; Arcan Unstable Dependency',
  hub: 'Arcan Hub-Like Dependency',
  'magic-source-or-sink': 'sensible data flow diagram: no magic data sources or sinks',
  'trust-boundary-crossing': 'STRIDE per element: data flow across a trust boundary (examine tampering, information disclosure, denial of service)',
  'hidden-coupling': 'modularity violation (co-change without a structural dependency)',
};

/** Where each kind's method comes from, verbatim. */
const SOURCE_BY_KIND: Record<ProblemKind, string> = {
  cycle: 'R. C. Martin, Design Principles and Design Patterns (2000); F. Arcelli Fontana et al., Arcan (ICSA 2017)',
  'unstable-dependency': 'R. C. Martin, Design Principles and Design Patterns (2000); F. Arcelli Fontana et al., Arcan (ICSA 2017)',
  hub: 'F. Arcelli Fontana et al., Arcan (ICSA 2017)',
  'magic-source-or-sink': 'S. Hernan, S. Lambert, T. Ostwald, A. Shostack, Uncover Security Design Flaws Using the STRIDE Approach (MSDN Magazine, 2006)',
  'trust-boundary-crossing': 'S. Hernan, S. Lambert, T. Ostwald, A. Shostack, Uncover Security Design Flaws Using the STRIDE Approach (MSDN Magazine, 2006)',
  'hidden-coupling': 'R. Mo, Y. Cai, R. Kazman, L. Xiao, Hotspot Patterns (WICSA 2015)',
};

/** One finding of the given kind naming the given ids, with the kind's method and source. */
function finding(problem: ProblemKind, ids: readonly string[], message: string): ProblemFinding {
  return { problem, method: METHOD_BY_KIND[problem], source: SOURCE_BY_KIND[problem], ids: sortedByCodePoint([...new Set(ids)]), message };
}

/** Findings print by kind (the order of `PROBLEM_KINDS`), then by their ids in code-point order. */
export function compareProblems(a: ProblemFinding, b: ProblemFinding): number {
  const byKind = PROBLEM_KINDS.indexOf(a.problem) - PROBLEM_KINDS.indexOf(b.problem);
  if (byKind !== 0) return byKind;
  for (let i = 0; i < Math.min(a.ids.length, b.ids.length); i++) {
    const byId = byCodePoint(a.ids[i]!, b.ids[i]!);
    if (byId !== 0) return byId;
  }
  return a.ids.length - b.ids.length;
}

/** One collapsed level of the model: the parent whose children it is (left out for the elements with no parent), and the arrows among them. */
export interface LevelGraph {
  parent?: string;
  elements: readonly string[];
  arrows: readonly { from: string; to: string; relationIds: readonly string[] }[];
}

/** The collapsed graph of every level, read off the view set the way the views draw it. */
export function levelsOf(views: readonly View[]): LevelGraph[] {
  return views.map((view) => {
    const inside = new Set(view.elements.filter((element) => element.place === 'inside').map((element) => element.id));
    return {
      parent: view.scope,
      elements: sortedByCodePoint([...inside]),
      arrows: view.arrows.filter((arrow) => inside.has(arrow.from) && inside.has(arrow.to)).map((arrow) => ({ from: arrow.from, to: arrow.to, relationIds: arrow.relationIds })),
    };
  });
}

/**
 * The strongly connected components of two or more elements (Tarjan), one
 * finding each, naming the component's elements and the relations of the
 * arrows inside it.
 */
export function cycleProblems(levels: readonly LevelGraph[]): ProblemFinding[] {
  const findings: ProblemFinding[] = [];
  for (const level of levels) {
    const outgoing = new Map<string, string[]>();
    const arrowIds = new Map<string, string[]>();
    for (const arrow of level.arrows) {
      outgoing.set(arrow.from, [...(outgoing.get(arrow.from) ?? []), arrow.to]);
      arrowIds.set(`${arrow.from}\0${arrow.to}`, [...arrow.relationIds]);
    }
    // Tarjan's strongly connected components over one level's arrows.
    const index = new Map<string, number>();
    const low = new Map<string, number>();
    const stack: string[] = [];
    const onStack = new Set<string>();
    let next = 0;
    const components: string[][] = [];
    const strongConnect = (elementId: string): void => {
      index.set(elementId, next);
      low.set(elementId, next);
      next++;
      stack.push(elementId);
      onStack.add(elementId);
      for (const successor of outgoing.get(elementId) ?? []) {
        if (!index.has(successor)) {
          strongConnect(successor);
          low.set(elementId, Math.min(low.get(elementId)!, low.get(successor)!));
        } else if (onStack.has(successor)) {
          low.set(elementId, Math.min(low.get(elementId)!, index.get(successor)!));
        }
      }
      if (low.get(elementId) === index.get(elementId)) {
        const component: string[] = [];
        for (let top = stack.pop()!; ; top = stack.pop()!) {
          onStack.delete(top);
          component.push(top);
          if (top === elementId) break;
        }
        if (component.length >= 2) components.push(component);
      }
    };
    for (const elementId of level.elements) if (!index.has(elementId)) strongConnect(elementId);
    for (const component of components) {
      const ids = sortedByCodePoint(component);
      const relationIds = new Set<string>();
      for (const from of component) {
        for (const to of component) {
          for (const relationId of arrowIds.get(`${from}\0${to}`) ?? []) relationIds.add(relationId);
        }
      }
      const relations = sortedByCodePoint([...relationIds]);
      findings.push(
        finding('cycle', [...ids, ...relations], `elements ${ids.map((id) => `"${id}"`).join(', ')} form a cycle through relations ${relations.map((id) => `"${id}"`).join(', ')}`),
      );
    }
  }
  return findings;
}

/**
 * An arrow whose target is less stable than its source (higher
 * instability, the exact fractions compared by cross-multiplication): the
 * source depends on a sibling more of the model depends on.
 */
export function unstableDependencyProblems(levels: readonly LevelGraph[]): ProblemFinding[] {
  const findings: ProblemFinding[] = [];
  for (const level of levels) {
    const outOf = new Map<string, Set<string>>();
    const into = new Map<string, Set<string>>();
    for (const arrow of level.arrows) {
      outOf.set(arrow.from, (outOf.get(arrow.from) ?? new Set()).add(arrow.to));
      into.set(arrow.to, (into.get(arrow.to) ?? new Set()).add(arrow.from));
    }
    // Instability I = Ce/(Ce+Ca) for every element with any relation at this level.
    const instability = new Map<string, { ce: number; ca: number }>();
    for (const elementId of level.elements) {
      const ce = outOf.get(elementId)?.size ?? 0;
      const ca = into.get(elementId)?.size ?? 0;
      if (ce + ca > 0) instability.set(elementId, { ce, ca });
    }
    for (const arrow of level.arrows) {
      const from = instability.get(arrow.from)!;
      const to = instability.get(arrow.to)!;
      if (to.ce * (from.ce + from.ca) <= from.ce * (to.ce + to.ca)) continue;
      const text = (degrees: { ce: number; ca: number }): string => (degrees.ce / (degrees.ce + degrees.ca)).toFixed(2);
      findings.push(
        finding(
          'unstable-dependency',
          [arrow.from, arrow.to, ...arrow.relationIds],
          `element "${arrow.from}" depends on "${arrow.to}", which is less stable: I("${arrow.from}") = ${text(from)}, I("${arrow.to}") = ${text(to)}`,
        ),
      );
    }
  }
  return findings;
}

/** An element with at least the threshold's relations both in and out at its level. */
export function hubProblems(levels: readonly LevelGraph[]): ProblemFinding[] {
  const findings: ProblemFinding[] = [];
  for (const level of levels) {
    const outOf = new Map<string, Set<string>>();
    const into = new Map<string, Set<string>>();
    for (const arrow of level.arrows) {
      outOf.set(arrow.from, (outOf.get(arrow.from) ?? new Set()).add(arrow.to));
      into.set(arrow.to, (into.get(arrow.to) ?? new Set()).add(arrow.from));
    }
    for (const elementId of level.elements) {
      const ce = outOf.get(elementId)?.size ?? 0;
      const ca = into.get(elementId)?.size ?? 0;
      if (ca < HUB_THRESHOLD || ce < HUB_THRESHOLD) continue;
      findings.push(finding('hub', [elementId], `element "${elementId}" is a hub: ${ca} relations in, ${ce} relations out (threshold ${HUB_THRESHOLD})`));
    }
  }
  return findings;
}

/** The ids of every element inside the given one, worked out from the compiled ancestors. */
function descendantsByElement(model: CompiledModel): Map<string, Set<string>> {
  const descendants = new Map<string, Set<string>>();
  for (const element of model.elements) {
    for (const ancestor of element.ancestors) {
      descendants.set(ancestor, (descendants.get(ancestor) ?? new Set()).add(element.id));
    }
  }
  return descendants;
}

/**
 * A topic or queue interface some relation sends to and none receives from
 * is a magic sink (and the reverse a source); a store whose relations all
 * move data into it is a sink (and out of it a source). Found within this
 * model only: another repository may hold the missing side.
 */
export function magicSourceOrSinkProblems(model: CompiledModel): ProblemFinding[] {
  const findings: ProblemFinding[] = [];
  const messaging = new Map<string, { sends: string[]; receives: string[] }>();
  for (const relation of model.relations) {
    if (relation.interface === undefined || relation.action === undefined) continue;
    const uses = messaging.get(relation.interface) ?? { sends: [], receives: [] };
    (relation.action === 'send' ? uses.sends : uses.receives).push(relation.id);
    messaging.set(relation.interface, uses);
  }
  for (const iface of model.interfaces) {
    const uses = messaging.get(iface.id);
    if (uses === undefined || messagingOf(iface.contract) === undefined) continue;
    if (uses.sends.length > 0 && uses.receives.length === 0) {
      findings.push(
        finding(
          'magic-source-or-sink',
          [iface.id, ...uses.sends],
          `interface "${iface.id}" is a magic sink within this model only: ${uses.sends.length} relation${uses.sends.length === 1 ? '' : 's'} send to it and none receives from it (another repository may hold the missing side)`,
        ),
      );
    } else if (uses.receives.length > 0 && uses.sends.length === 0) {
      findings.push(
        finding(
          'magic-source-or-sink',
          [iface.id, ...uses.receives],
          `interface "${iface.id}" is a magic source within this model only: ${uses.receives.length} relation${uses.receives.length === 1 ? '' : 's'} receive from it and none sends to it (another repository may hold the missing side)`,
        ),
      );
    }
  }

  const storeIds = model.elements.filter((element) => element.kind === 'store').map((element) => element.id);
  const descendants = descendantsByElement(model);
  for (const storeId of storeIds) {
    const inside = new Set([storeId, ...(descendants.get(storeId) ?? [])]);
    let forward = 0;
    let reverse = 0;
    const carrying: string[] = [];
    for (const relation of model.relations) {
      if (!inside.has(relation.to)) continue;
      if ((relation.transfers?.length ?? 0) === 0) continue;
      carrying.push(relation.id);
      for (const transfer of relation.transfers ?? []) (transfer.direction === 'forward' ? forward++ : reverse++);
    }
    if (forward + reverse === 0) continue;
    if (reverse === 0) {
      findings.push(
        finding('magic-source-or-sink', [storeId, ...carrying], `store "${storeId}" is a magic sink within this model only: ${forward} transfer${forward === 1 ? '' : 's'} move into it and none out (another repository may hold the missing side)`),
      );
    } else if (forward === 0) {
      findings.push(
        finding('magic-source-or-sink', [storeId, ...carrying], `store "${storeId}" is a magic source within this model only: ${reverse} transfer${reverse === 1 ? '' : 's'} move out of it and none in (another repository may hold the missing side)`),
      );
    }
  }
  return findings;
}

const EXAMINE = ' — examine it for tampering, information disclosure and denial of service';

/** Whether two resolved zone sets are the same set. */
function sameZones(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((zone) => b.includes(zone));
}

function zoneText(zones: readonly string[]): string {
  return zones.length === 0 ? 'no zone' : `zones ${zones.join(', ')}`;
}

/**
 * An interaction whose ends sit in different resolved zones, and a data
 * transfer marked more than public or internal reaching an external
 * element, are questions to examine, never declared defects.
 */
export function trustBoundaryProblems(model: CompiledModel): ProblemFinding[] {
  const findings: ProblemFinding[] = [];
  const byId = new Map(model.elements.map((element) => [element.id, element]));
  const reported = new Set<string>();
  for (const relation of model.relations) {
    const from = byId.get(relation.from);
    const to = byId.get(relation.to);
    if (relation.interaction && from !== undefined && to !== undefined && !sameZones(from.zones, to.zones)) {
      findings.push(
        finding(
          'trust-boundary-crossing',
          [relation.id, relation.from, relation.to],
          `relation "${relation.id}" crosses a trust boundary: "${relation.from}" sits in ${zoneText(from.zones)}, "${relation.to}" sits in ${zoneText(to.zones)}${EXAMINE}`,
        ),
      );
    }
    for (const transfer of relation.transfers ?? []) {
      if (transfer.confidentiality === 'public' || transfer.confidentiality === 'internal') continue;
      const other = transfer.direction === 'forward' ? relation.from : relation.to;
      const recipient = transfer.direction === 'forward' ? relation.to : relation.from;
      if (byId.get(recipient)?.kind !== 'external') continue;
      const key = `${relation.id}\0${recipient}`;
      if (reported.has(key)) continue;
      reported.add(key);
      findings.push(
        finding(
          'trust-boundary-crossing',
          [relation.id, other, recipient],
          `relation "${relation.id}" transfers data marked "${transfer.confidentiality}" to the external element "${recipient}"${EXAMINE}`,
        ),
      );
    }
  }
  return findings;
}

/** One commit the hidden coupling reads: its hash, and the distinct elements it touched, newest first in the caller's list. */
export interface TouchedCommit {
  hash: string;
  elements: readonly string[];
}

/**
 * Two elements, neither an ancestor of the other, whose assigned files
 * changed together in at least the threshold's commits and between which no
 * relation runs at any level — no relation with one end in the first
 * element or its ancestors or descendants and the other end in the
 * second's.
 */
export function hiddenCouplingProblems(model: CompiledModel, commits: readonly TouchedCommit[]): ProblemFinding[] {
  const descendants = descendantsByElement(model);
  const reachCache = new Map<string, Set<string>>();
  const reachOf = (elementId: string): Set<string> => {
    const cached = reachCache.get(elementId);
    if (cached !== undefined) return cached;
    const element = model.elements.find((candidate) => candidate.id === elementId);
    const reach = new Set([elementId, ...(element?.ancestors ?? []), ...(descendants.get(elementId) ?? [])]);
    reachCache.set(elementId, reach);
    return reach;
  };
  // A relation joins the pair when one end sits in the first element's own line (itself, its ancestors, its descendants) and the other in the second's, either way round.
  const joined = (first: string, second: string): boolean => {
    const firstReach = reachOf(first);
    const secondReach = reachOf(second);
    return model.relations.some((relation) => (firstReach.has(relation.from) && secondReach.has(relation.to)) || (secondReach.has(relation.from) && firstReach.has(relation.to)));
  };
  const counts = new Map<string, { x: string; y: string; count: number; hashes: string[] }>();
  for (const commit of commits) {
    for (let i = 0; i < commit.elements.length; i++) {
      for (let j = i + 1; j < commit.elements.length; j++) {
        const [x, y] = [commit.elements[i]!, commit.elements[j]!];
        const key = `${x}\0${y}`;
        const entry = counts.get(key) ?? { x, y, count: 0, hashes: [] };
        entry.count++;
        if (entry.hashes.length < 3) entry.hashes.push(commit.hash);
        counts.set(key, entry);
      }
    }
  }
  const findings: ProblemFinding[] = [];
  for (const { x, y, count, hashes } of counts.values()) {
    if (count < HIDDEN_COUPLING_MIN_COMMITS) continue;
    // An ancestor and its descendant are one line of the model, not a coupling of two.
    if (reachOf(x).has(y) || reachOf(y).has(x)) continue;
    if (joined(x, y)) continue;
    findings.push(
      finding(
        'hidden-coupling',
        [x, y],
        `elements "${x}" and "${y}" changed together in ${count} commits (at least ${HIDDEN_COUPLING_MIN_COMMITS} within ${HIDDEN_COUPLING_WINDOW_DAYS} days; commits touching more than ${BULK_COMMIT_FILES} files are skipped as bulk changes) but no relation joins them; the newest commits: ${hashes.join(', ')}`,
      ),
    );
  }
  return findings;
}
