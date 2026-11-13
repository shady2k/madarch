/** Invocation boundaries derived only from the expanded output declarations. */
import type { GraphAnswerer } from './host.js';
import type { ValidatedUnit } from './results.js';

export type DeclaredRead = string | { readonly kind: string; readonly version: 'earlier'; readonly producer: string };

export function pluginInvocationAccess(graph: GraphAnswerer, scope: {
  readonly location: string;
  readonly plugin: string;
  readonly output: string;
  readonly fields: readonly string[];
  readonly reads: readonly DeclaredRead[];
  readonly catalogueKinds: readonly string[];
  readonly fileKind: string;
  readonly edges: readonly string[];
  readonly snapshots?: ReadonlyMap<string, { readonly runId: string; readonly unitId: string; readonly generation: number }>;
}) {
  let violation: Error | undefined;
  const deny = (message: string): never => {
    violation ??= new Error(`${scope.location}: plugin ${scope.plugin} output ${scope.output}: ${message}`);
    throw violation;
  };
  const readOf = (kind: string): DeclaredRead => scope.reads.find((read) => (typeof read === 'string' ? read : read.kind) === kind)
    ?? deny(`undeclared catalogue read of ${kind}; declare this input in produces[].reads and the output's derives-from`);
  const scoped: GraphAnswerer = {
    files: async (pattern) => {
      const read = readOf(scope.fileKind);
      const snapshot = scope.snapshots?.get(scope.fileKind);
      if (typeof read !== 'string' && snapshot === undefined) deny(`earlier snapshot of ${scope.fileKind} from ${read.producer} is unavailable; enable immutable versioned reads before running this output`);
      return await graph.files(pattern, snapshot);
    },
    value: async (kind, key, field) => {
      const read = readOf(kind);
      const snapshot = scope.snapshots?.get(`${kind}.${field}`) ?? scope.snapshots?.get(kind);
      if (typeof read !== 'string' && snapshot === undefined) deny(`earlier snapshot of ${kind} from ${read.producer} is unavailable; enable immutable versioned reads before running this output`);
      return await graph.value(kind, key, field, snapshot);
    },
    // The host authorizes writer consistency records by graphReads, not catalogue content prerequisites.
    ...(graph.unresolved === undefined ? {} : { unresolved: (...args: Parameters<NonNullable<GraphAnswerer['unresolved']>>) => graph.unresolved!(...args) }),
    ...(graph.removedEnds === undefined ? {} : { removedEnds: (...args: Parameters<NonNullable<GraphAnswerer['removedEnds']>>) => graph.removedEnds!(...args) }),
    ...(graph.unevidenced === undefined ? {} : { unevidenced: (...args: Parameters<NonNullable<GraphAnswerer['unevidenced']>>) => graph.unevidenced!(...args) }),
  };
  return {
    graph: scoped,
    assertAllowed(): void { if (violation !== undefined) throw violation; },
    assertWrites(result: Pick<ValidatedUnit, 'vertices' | 'edges' | 'removals'>): void {
      if (violation !== undefined) throw violation;
      for (const vertex of [...result.vertices, ...result.removals]) {
        if (vertex.kind !== scope.output) deny(`write of unselected output ${vertex.kind}; this invocation selects only ${scope.output}`);
        for (const field of Object.keys('values' in vertex ? vertex.values ?? {} : {})) {
          if (!scope.fields.includes(field)) deny(`write of undeclared selected field ${vertex.kind}.${field}`);
        }
      }
      for (const edge of result.edges) if (!scope.edges.includes(edge.kind)) deny(`write of unselected edge ${edge.kind}`);
    },
  };
}
