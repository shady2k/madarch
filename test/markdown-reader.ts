/**
 * What a reader of a Markdown page reads, with links reduced to their labels
 * (madarch-ztyq.8). The Markdown parser finds the links, so a page's prose is
 * compared as rendered rather than as the source bytes the writer produced.
 */
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import { unified } from 'unified';

interface MdNode {
  type: string;
  value?: string;
  identifier?: string;
  label?: string;
  url?: string;
  children?: MdNode[];
  position?: { start: { offset?: number }; end: { offset?: number } };
}

const parser = unified().use(remarkParse).use(remarkGfm);

function parse(markdown: string): MdNode | undefined {
  try {
    return parser.parse(markdown) as unknown as MdNode;
  } catch {
    // A test page the parser cannot read is compared as written; the production checks report that page.
    return undefined;
  }
}

/** The text inside a link's brackets, with any formatting reduced to its text. */
function labelOf(node: MdNode): string {
  if (node.type === 'text' || node.type === 'inlineCode' || node.type === 'code') return node.value ?? '';
  return (node.children ?? []).map(labelOf).join('');
}

/** A page's Markdown with every inline or reference link standing as its label. */
export function readerText(markdown: string): string {
  const root = parse(markdown);
  if (root === undefined) return markdown;
  const links: { start: number; end: number; label: string }[] = [];
  const walk = (node: MdNode): void => {
    if (node.type === 'link' || node.type === 'linkReference') {
      const start = node.position?.start.offset;
      const end = node.position?.end.offset;
      if (start !== undefined && end !== undefined) links.push({ start, end, label: labelOf(node) });
      return;
    }
    for (const child of node.children ?? []) walk(child);
  };
  walk(root);
  let text = markdown;
  for (const link of links.sort((left, right) => right.start - left.start)) text = text.slice(0, link.start) + link.label + text.slice(link.end);
  return text;
}
