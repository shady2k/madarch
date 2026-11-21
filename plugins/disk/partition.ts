import type { Unit, UnitResult, KeyValues, EdgeResult, ExtractContext } from 'madarch-plugin-sdk';

const GROUP_BYTES = 1_000_000;
const PAGE_BYTES = 500_000;
const keyOf = (key: KeyValues): string => JSON.stringify(Object.fromEntries(Object.entries(key).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)));
const bytesOf = (value: unknown): number => Buffer.byteLength(JSON.stringify(value));
type Ref = EdgeResult['from'];
const refOf = (ref: Ref): string => JSON.stringify([ref.kind, keyOf(ref.key), ref.keyEdges ?? null]);

function anchor(edge: EdgeResult, kind: string): KeyValues | undefined {
  return edge.from.kind === kind ? edge.from.key : edge.to.kind === kind ? edge.to.key : undefined;
}

/** Keep selected output facts together with the evidence support they actually reference. */
function select(result: UnitResult, kind: string, keys: ReadonlySet<string>): UnitResult {
  const vertices = result.vertices ?? [];
  const edges = result.edges ?? [];
  const primary = vertices.filter(vertex => vertex.kind === kind && keys.has(keyOf(vertex.key)));
  const primaryEdges = edges.filter(edge => { const key = anchor(edge, kind); return key !== undefined && keys.has(keyOf(key)); });
  const included = new Set(primary.map(refOf));
  const needed = new Set<string>();
  const evidenceOf = (fact: { readonly evidence?: unknown }) => {
    const evidence = fact.evidence as { target?: Ref } | undefined;
    if (evidence?.target !== undefined) needed.add(refOf(evidence.target));
  };
  for (const fact of [...primary, ...primaryEdges]) evidenceOf(fact);
  const support = vertices.filter(vertex => !primary.includes(vertex));
  const supportEdges = new Set<EdgeResult>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const vertex of support) if (needed.has(refOf(vertex)) && !included.has(refOf(vertex))) {
      included.add(refOf(vertex)); evidenceOf(vertex); changed = true;
    }
    for (const edge of edges) {
      if (anchor(edge, kind) !== undefined) continue;
      if (!included.has(refOf(edge.from)) && !included.has(refOf(edge.to))) continue;
      if (supportEdges.has(edge)) continue;
      supportEdges.add(edge); evidenceOf(edge);
      for (const endpoint of [edge.from, edge.to]) if (support.some(vertex => refOf(vertex) === refOf(endpoint))) needed.add(refOf(endpoint));
      changed = true;
    }
  }
  return { ...result, vertices: vertices.filter(vertex => included.has(refOf(vertex))), edges: edges.filter(edge => primaryEdges.includes(edge) || supportEdges.has(edge)) };
}

/** How long the grouping pass may run before it hands the loop back to the host's heartbeat (madarch-64o5.74). */
const LOOP_YIELD_MS = 20;
const yieldToLoop = async (): Promise<void> => { await new Promise<void>((done) => setTimeout(done, 0)); };

/** Enumerate bounded key groups; support never becomes a partition identity. */
export function partitioned(extractOutput: (unit: Unit, context: ExtractContext) => Promise<UnitResult>) {
  let held: { identity: string; result: UnitResult; groups: KeyValues[][] } | undefined;
  const prepare = async (unit: Unit, context: ExtractContext) => {
    const { keys: _keys, ...inputs } = unit.inputs as Record<string, unknown>;
    const identity = JSON.stringify([unit.kind, inputs]);
    if (held?.identity === identity) return held;
    const result = await extractOutput({ ...unit, inputs }, context);
    const byKey = new Map<string, KeyValues>();
    for (const vertex of result.vertices ?? []) if (vertex.kind === unit.kind) byKey.set(keyOf(vertex.key), vertex.key);
    const all = select(result, unit.kind, new Set(byKey.keys()));
    for (const edge of result.edges ?? []) if (!all.edges?.includes(edge)) throw new Error(`partition edge has no output identity or referenced support: ${JSON.stringify(edge)}`);
    // A group takes the longest run of keys whose published output stays within GROUP_BYTES, and one key always stands
    // (the rule never judges a group of one). The size only grows as keys join, so the run is found by search rather
    // than by rebuilding the whole selection once per key: the cost follows the keys published, not their square
    // (madarch-64o5.74). The pass hands the loop back between groups, so the host's heartbeat is answered while a
    // whole tree is grouped.
    const ordered = [...byKey].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, key]) => key);
    const sizeOf = (start: number, end: number): number => bytesOf(select(result, unit.kind, new Set(ordered.slice(start, end + 1).map(keyOf))));
    const endOfGroup = (start: number): number => {
      let good = start;
      let step = 1;
      while (start + step < ordered.length && sizeOf(start, start + step) <= GROUP_BYTES) { good = start + step; step *= 2; }
      let low = good + 1;
      let high = Math.min(ordered.length, start + step);
      while (low < high) {
        const middle = (low + high) >> 1;
        if (sizeOf(start, middle) <= GROUP_BYTES) low = middle + 1;
        else high = middle;
      }
      return low - 1;
    };
    const groups: KeyValues[][] = [];
    let lastYield = Date.now();
    for (let start = 0; start < ordered.length;) {
      const end = endOfGroup(start);
      groups.push(ordered.slice(start, end + 1));
      start = end + 1;
      if (Date.now() - lastYield >= LOOP_YIELD_MS) { await yieldToLoop(); lastYield = Date.now(); }
    }
    held = { identity, result, groups };
    return held;
  };
  return {
    planOutput: async (unit: Unit, context: ExtractContext, cursor?: string) => {
      const output = await prepare(unit, context);
      let at = cursor === undefined ? 0 : Number(cursor);
      if (!Number.isSafeInteger(at) || at < 0 || at > output.groups.length) throw new Error('invalid output planning cursor');
      const partitions: { keys: KeyValues[] }[] = [];
      let bytes = 0;
      while (at < output.groups.length) {
        const group = { keys: output.groups[at]! };
        const size = bytesOf(group);
        if (partitions.length > 0 && bytes + size > PAGE_BYTES) break;
        partitions.push(group); bytes += size; at += 1;
      }
      return { partitions, ...(at < output.groups.length ? { next: String(at) } : {}) };
    },
    extract: async (unit: Unit, context: ExtractContext): Promise<UnitResult> => {
      const inputs = unit.inputs as { keys?: readonly KeyValues[] };
      const result = await extractOutput(unit, context);
      return inputs.keys === undefined ? result : select(result, unit.kind, new Set(inputs.keys.map(keyOf)));
    },
  };
}
