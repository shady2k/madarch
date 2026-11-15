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
    ...(graph.ownFacts === undefined ? {} : { ownFacts: async (query: Parameters<NonNullable<GraphAnswerer['ownFacts']>>[0]) => {
      const facts = await graph.ownFacts!(query);
      return { vertices: facts.vertices.filter((vertex) => vertex.kind === scope.output).map((vertex) => ({ ...vertex,
        ...(vertex.values === undefined ? {} : { values: Object.fromEntries(Object.entries(vertex.values).filter(([field]) => scope.fields.includes(field))) }),
      })), edges: facts.edges.filter((edge) => scope.edges.includes(edge.kind)) };
    } }),
    // The host authorizes writer consistency records by graphReads, not catalogue content prerequisites.
    ...(graph.unresolved === undefined ? {} : { unresolved: (...args: Parameters<NonNullable<GraphAnswerer['unresolved']>>) => graph.unresolved!(...args) }),
    ...(graph.removedEnds === undefined ? {} : { removedEnds: (...args: Parameters<NonNullable<GraphAnswerer['removedEnds']>>) => graph.removedEnds!(...args) }),
    ...(graph.unevidenced === undefined ? {} : { unevidenced: (...args: Parameters<NonNullable<GraphAnswerer['unevidenced']>>) => graph.unevidenced!(...args) }),
  };
  return {
    graph: scoped,
    assertAllowed(): void { if (violation !== undefined) throw violation; },
    assertWrites(result: Pick<ValidatedUnit, 'vertices' | 'edges' | 'removals' | 'writes'>): void {
      if (violation !== undefined) throw violation;
      const explicitVertices = (result.writes ?? []).flatMap((write) => write.vertex === undefined ? [] : [write.vertex]);
      const explicitEdges = (result.writes ?? []).flatMap((write) => write.edge === undefined ? [] : [write.edge]);
      for (const vertex of [...result.vertices, ...result.removals, ...explicitVertices]) {
        if (vertex.kind !== scope.output) deny(`write of unselected output ${vertex.kind}; this invocation selects only ${scope.output}`);
        for (const field of Object.keys('values' in vertex ? vertex.values ?? {} : {})) {
          if (!scope.fields.includes(field)) deny(`write of undeclared selected field ${vertex.kind}.${field}`);
        }
      }
      for (const edge of [...result.edges, ...explicitEdges]) if (!scope.edges.includes(edge.kind)) deny(`write of unselected edge ${edge.kind}`);
    },
  };
}
