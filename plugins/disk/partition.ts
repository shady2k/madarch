import type { Unit, UnitResult, KeyValues, EdgeResult, ExtractContext } from 'madarch-plugin-sdk';

const GROUP_BYTES = 1_000_000;
const PAGE_BYTES = 500_000;
const keyOf = (key: KeyValues): string => JSON.stringify(Object.fromEntries(Object.entries(key).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)));
const bytesOf = (value: unknown): number => Buffer.byteLength(JSON.stringify(value));

/** One endpoint owns an edge in a key partition, including edges whose ends share a kind. */
function anchor(edge: EdgeResult, kind: string): KeyValues {
  return edge.from.kind === kind ? edge.from.key : edge.to.key;
}

/** Enumerate bounded key groups; each extraction can run in a fresh private process. */
export function partitioned(extractOutput: (unit: Unit, context: ExtractContext) => Promise<UnitResult>) {
  let held: { identity: string; result: UnitResult; groups: KeyValues[][] } | undefined;
  const prepare = async (unit: Unit, context: ExtractContext) => {
    const { keys: _keys, ...inputs } = unit.inputs as Record<string, unknown>;
    const identity = JSON.stringify([unit.kind, inputs]);
    if (held?.identity === identity) return held;
    const result = await extractOutput({ ...unit, inputs }, context);
    // An identity-only vertex is not a partition of its own: it travels with the edge that names it. An edge whose
    // anchor is such an identity (a rename between historical paths) still makes one partition, so the edge is not lost.
    const byKey = new Map<string, { key: KeyValues; bytes: number; identityOnly: boolean; anchored: boolean }>();
    for (const vertex of result.vertices ?? []) {
      const identity = keyOf(vertex.key);
      const row = byKey.get(identity);
      if (row === undefined) byKey.set(identity, { key: vertex.key, bytes: bytesOf(vertex), identityOnly: vertex.identityOnly === true, anchored: false });
      else { row.bytes += bytesOf(vertex); row.identityOnly = false; }
    }
    for (const edge of result.edges ?? []) {
      const key = anchor(edge, unit.kind);
      const identity = keyOf(key);
      const row = byKey.get(identity) ?? { key, bytes: 0, identityOnly: false, anchored: false };
      byKey.set(identity, row);
      row.anchored = true;
      row.bytes += bytesOf(edge);
    }
    const groups: KeyValues[][] = [];
    let group: KeyValues[] = [], bytes = 0;
    for (const [_, row] of [...byKey].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
      if (row.identityOnly && !row.anchored) continue;
      if (group.length > 0 && bytes + row.bytes > GROUP_BYTES) { groups.push(group); group = []; bytes = 0; }
      group.push(row.key); bytes += row.bytes;
    }
    if (group.length > 0) groups.push(group);
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
      if (inputs.keys === undefined) return result;
      const selected = new Set(inputs.keys.map(keyOf));
      const edges = result.edges?.filter(edge => selected.has(keyOf(anchor(edge, unit.kind))));
      // An identity-only end of a selected edge travels with it: the edge's other end may stand in another partition.
      const endpoints = new Set((edges ?? []).flatMap(edge => [keyOf(edge.from.key), keyOf(edge.to.key)]));
      return { ...result, vertices: result.vertices?.filter(vertex => selected.has(keyOf(vertex.key)) || (vertex.identityOnly === true && endpoints.has(keyOf(vertex.key)))), edges };
    },
  };
}
