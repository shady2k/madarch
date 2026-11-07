/**
 * The operations extractor: configuration, build, deploy, dependencies,
 * observability, the stack passport and the newcomer's first run, read from
 * one tree as pure records (decision 0028). No database, no network, no clock;
 * a file that cannot be read is a gap, never a silence.
 */
import type { Extraction, TreeReader } from '../records.js';
import { REL_CONTAINS } from './vocabulary.js';
import type { CodeFacts } from '../code/facts.js';
import { extractBuild } from './build.js';
import { Records, sortedEdges, sortedGaps, sortedNodes } from './accumulate.js';
import { extractDependencies } from './dependencies.js';
import { extractDeploy } from './deploy.js';
import { extractEnv } from './env.js';
import { extractNewcomer } from './newcomer.js';
import { extractMessaging } from './messaging.js';
import { extractObservability, linkEndpoints } from './observability.js';
import { extractStack } from './stack.js';
import { TreeText } from './source.js';

/** The producer key of every record this folder returns. */
export { OPERATIONS_PRODUCER } from './vocabulary.js';
import { OPERATIONS_PRODUCER } from './vocabulary.js';

/** Extracts the operations records of one tree. */
export function extractOperations(tree: TreeReader, code?: Extraction, facts?: CodeFacts): Extraction {
  const t = new TreeText(tree, code, facts);
  const records = new Records(t);
  try {
    const library = t.libraryFacts();
    if (library !== undefined) for (const gap of library.gaps) records.gap(gap.path, gap.reason);
    const envReads = extractEnv(t, records);
    extractDependencies(t, records);
    extractDeploy(t, records);
    const targets = extractBuild(t, records);
    extractObservability(t, records);
    extractStack(t, records, envReads);
    extractMessaging(t, records);
    linkEndpoints(t, records);
    extractNewcomer(t, records, targets);
    for (const node of [...records.nodes]) {
      if (node.kind === 'code.file' || node.span === undefined || !t.has(node.span.path)) continue;
      // A dependency is declared by the manifest that names it, and that declaration is the
      // manifest's own edge (`code.declares-dependency`): a containment from the file would state
      // the same fact a second time, on another end and under another relation.
      if (node.kind === 'code.dependency') continue;
      records.edge(REL_CONTAINS, records.file(node.span.path), node.key, {}, node.span);
    }
  } catch (error) {
    records.gap('.', `the operations records cannot be extracted: ${error instanceof Error ? error.message : String(error)}`);
  }
  for (const gap of t.factGaps.values()) records.gap(gap.path, gap.reason);
  return {
    producer: OPERATIONS_PRODUCER,
    nodes: sortedNodes(records.nodes),
    edges: sortedEdges(records.edges),
    gaps: sortedGaps(records.gaps),
  };
}
