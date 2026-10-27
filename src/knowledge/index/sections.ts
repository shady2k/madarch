/**
 * The sections of a Markdown document (madarch-m38l.8): the same anchors a ground may name as
 * `doc:<path>#<anchor>` (heading slugs, the slug of a list item's leading bold phrase, the identifier such a phrase or
 * heading starts with, like UC-2, a block's label, and — for a block no name covers — the enclosing heading's anchor and
 * the block's place in it, like `qualities.1`), each with the text of the part it names, so a section has a digest and a
 * changed section can be told from an unchanged one.
 *
 * Both the names and the extents come from the parsed tree (`anchors.ts` over `doc-tree.ts`), the one reader of them: a
 * heading section runs over its own lines and its sub-sections', an item or a paragraph over itself alone.
 */
import { byCodePoint } from '../../model/order.js';
import { sha256Hex } from '../../graph/digest.js';
import { anchorsOfTree, extentOfNode } from '../anchors.js';
import { readDocTree } from '../doc-tree.js';

export interface Section {
  readonly anchor: string;
  /** The section's lines, joined by newlines, trailing blanks removed. */
  readonly text: string;
}

/** Every anchor of a document with the text it names, in code-point anchor order; a repeated anchor keeps its first section. */
export function documentSections(text: string): Section[] {
  const tree = readDocTree({ repo: null, path: '', text });
  const reading = anchorsOfTree(tree);
  const lines = text.split('\n');
  const found: Section[] = [];
  for (const [anchor, node] of reading.nodes) {
    const extent = extentOfNode(tree, node);
    found.push({ anchor, text: lines.slice(extent.start - 1, extent.end).join('\n').trimEnd() });
  }
  return found.sort((a, b) => byCodePoint(a.anchor, b.anchor));
}

/** SHA-256 of a section's text. */
export function sectionDigest(text: string): string {
  return sha256Hex(new TextEncoder().encode(text));
}
