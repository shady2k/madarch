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
    nodes: tree.paths.map((filePath) => {
      const bytes = tree.read(filePath);
      // A file's place is the file: its first line to its last, its first byte to its length. Its label is the whole
      // path, because five READMEs and four Dockerfiles carry one basename (madarch-m38l.16).
      const text = new TextDecoder('utf-8').decode(bytes);
      const lines = text === '' ? 1 : text.split('\n').length;
      return {
        key: `code.file:${filePath}`,
        kind: 'code.file' as const,
        label: filePath,
        properties: { path: filePath, sha256: createHash('sha256').update(bytes).digest('hex') },
        span: { path: filePath, byteStart: 0, byteEnd: bytes.length, lineStart: 1, lineEnd: lines },
      };
    }),
    edges: [],
    gaps: [],
  };
}
