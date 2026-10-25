/**
 * The tree lister: the owner of every `code.file` node. It files each path of
 * the commit's tree once, with the content digest of its bytes; every other
 * producer's `code.file` node is dropped by the driver and its edges end here.
 */
import { createHash } from 'node:crypto';
import type { ExtractedNode, ExtractedEdge, Extraction, TreeReader } from '../records.js';
import { byCodePoint } from '../../model/order.js';

export const FILES_PRODUCER = 'code.extract.files' as const;

export function extractFiles(tree: TreeReader): Extraction {
  const sections: ExtractedNode[] = [];
  const edges: ExtractedEdge[] = [];
  for (const path of tree.paths.filter((entry) => /\.md$/i.test(entry))) {
    const text = new TextDecoder().decode(tree.read(path));
    const lines = text.split('\n');
    const headings: {name: string; level: number; line: number; start: number}[] = [];
    let offset = 0;
    let fence: string | undefined;
    let comment = false;
    for (const [index, line] of lines.entries()) {
      if (fence !== undefined) {
        const closing = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line)?.[1];
        if (closing !== undefined && closing[0] === fence[0] && closing.length >= fence.length) fence = undefined;
      } else {
        let visible = '';
        let at = 0;
        while (at < line.length) {
          if (comment) {
            const end = line.indexOf('-->', at);
            if (end < 0) {at = line.length; break;}
            comment = false; at = end + 3;
          } else {
            const start = line.indexOf('<!--', at);
            if (start < 0) {visible += line.slice(at); break;}
            visible += line.slice(at, start); comment = true; at = start + 4;
          }
        }
        const mark = /^ {0,3}(`{3,}|~{3,})/.exec(visible)?.[1];
        if (mark !== undefined) fence = mark;
        else {
          const heading = /^ {0,3}(#{1,6})\s+(.+?)(?:\s+#+\s*)?$/.exec(visible);
          if (heading !== null) headings.push({name: heading[2]!, level: heading[1]!.length, line: index + 1, start: offset});
        }
      }
      offset += Buffer.byteLength(line) + (index < lines.length - 1 ? 1 : 0);
    }
    for (const [index, heading] of headings.entries()) {
      const next = headings.slice(index + 1).find((entry) => entry.level <= heading.level);
      const key = `code.document-section:${path}#${heading.line}`;
      const span = {path, byteStart: heading.start, byteEnd: next?.start ?? Buffer.byteLength(text), lineStart: heading.line, lineEnd: next === undefined ? lines.length : next.line - 1};
      sections.push({key, kind: 'code.document-section', label: `${heading.name} · ${path}:${heading.line}`, properties: {path, heading: heading.name, level: heading.level}, span});
      edges.push({type: 'code.contains', from: `code.file:${path}`, to: key, discriminator: '', properties: {}, span});
    }
  }
  return {
    producer: FILES_PRODUCER,
    nodes: [...tree.paths.map((filePath) => {
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
    }), ...sections].sort((a, b) => byCodePoint(a.key, b.key)),
    edges,
    gaps: [],
  };
}
