/** Invocation boundaries derived only from the expanded output declarations. */
import type { GraphAnswerer } from './host.js';
import type { ValidatedUnit } from './results.js';

export type DeclaredRead = string | { readonly kind: string; readonly version: 'earlier'; readonly producer: string };

/**
 * What one invocation may read and write, from its declarations alone. A declared read of an earlier version names
 * the producer whose answer the plugin wants; the answer is the graph as it stands (decision 0039, item 13), because
 * a generation's earlier answer is no stored copy any more — the assertions' history serves that read (item 25).
 */
export function pluginInvocationAccess(graph: GraphAnswerer, scope: {
  readonly location: string;
  readonly plugin: string;
  readonly output: string;
  readonly fields: readonly string[];
  readonly reads: readonly DeclaredRead[];
  readonly fileKind: string;
  readonly edges: readonly string[];
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
      readOf(scope.fileKind);
      return await graph.files(pattern);
    },
    value: async (kind, key, field) => {
      readOf(kind);
      return await graph.value(kind, key, field);
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
