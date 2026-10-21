/**
 * The operations extractor: configuration, build, deploy, dependencies,
 * observability, the stack passport and the newcomer's first run, read from
 * one tree as pure records (decision 0028). No database, no network, no clock;
 * a file that cannot be read is a gap, never a silence.
 */
import type { Extraction, TreeReader } from '../records.js';
import { extractBuild } from './build.js';
import { Records, sortedEdges, sortedGaps, sortedNodes } from './accumulate.js';
import { extractDependencies } from './dependencies.js';
import { extractDeploy } from './deploy.js';
import { extractEnv } from './env.js';
import { extractNewcomer } from './newcomer.js';
import { extractObservability } from './observability.js';
import { extractStack } from './stack.js';
import { TreeText } from './source.js';

/** The producer key of every record this folder returns. */
export const OPERATIONS_PRODUCER = 'code.extract.operations';

/** Extracts the operations records of one tree. */
export function extractOperations(tree: TreeReader): Extraction {
  const t = new TreeText(tree);
  const records = new Records(t);
  try {
    const envReads = extractEnv(t, records);
    extractDependencies(t, records);
    extractDeploy(t, records);
    const targets = extractBuild(t, records);
    extractObservability(t, records);
    extractStack(t, records, envReads);
    extractNewcomer(t, records, targets);
  } catch (error) {
    records.gap('.', `the operations records cannot be extracted: ${error instanceof Error ? error.message : String(error)}`);
  }
  return {
    producer: OPERATIONS_PRODUCER,
    nodes: sortedNodes(records.nodes),
    edges: sortedEdges(records.edges),
    gaps: sortedGaps(records.gaps),
  };
}
