/**
 * The tree lister: the owner of every `code.file` node. It files each path of
 * the commit's tree once, with the content digest of its bytes; every other
 * producer's `code.file` node is dropped by the driver and its edges end here.
 */
import { createHash } from 'node:crypto';
import type { Extraction, TreeReader } from '../records.js';

export const FILES_PRODUCER = 'code.extract.files' as const;

export function extractFiles(tree: TreeReader): Extraction {
  return {
    producer: FILES_PRODUCER,
    nodes: tree.paths.map((filePath) => ({
      key: `code.file:${filePath}`,
      kind: 'code.file' as const,
      label: filePath.slice(filePath.lastIndexOf('/') + 1),
      properties: { path: filePath, sha256: createHash('sha256').update(tree.read(filePath)).digest('hex') },
    })),
    edges: [],
    gaps: [],
  };
}
