
/**
 * The names a page's prose may mention (madarch-ztyq.8, decision 0032 section 8): a reader who meets a
 * known entity in an agent's sentence should be able to open its page, and a page should list the pages
 * that mention it. The core inserts the link where the agent wrote plain text; the agent does not have
 * to know a key, and a page written before this change gains the links when it is checked again.
 *
 * The names come from data the product already holds: the titles and identifiers of its document
 * entities, the synonyms and code names of its glossary terms, and the labels of the graph's nodes.
 * Nothing here names a product kind or a product entity.
 */
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import { unified } from 'unified';







/**
 * The page context a mention is read in (madarch-ztyq.8, review 202): when several entities share
 * a name, the page itself says which one it means. The page id, its sources and the targets it
 * already links or relates to are evidence; without evidence the name stays plain.
 */
interface MdNode {
  type: string;
  value?: string;
  url?: string;
  identifier?: string;
  children?: MdNode[];
  position?: { start: { offset?: number; line?: number }; end: { offset?: number; line?: number } };
}

const parser = unified().use(remarkParse).use(remarkGfm);

function parseMarkdown(markdown: string): MdNode | undefined {
  try {
    return parser.parse(markdown) as unknown as MdNode;
  } catch {
    // A reader never sees a page the parser cannot read; the caller's check has already refused it.
    return undefined;
  }
}


/**
 * Every footnote identifier a rendered reference reaches: references in the body, then the references
 * inside those definitions only. A definition nobody references, and anything nested in it, is not
 * rendered.
 */
function usedFootnotes(root: MdNode): Set<string> {
  const referenced = new Set<string>();
  const definitions = new Map<string, MdNode>();
  const collect = (node: MdNode): void => {
    if (node.type === 'footnoteDefinition' && typeof node.identifier === 'string') definitions.set(node.identifier, node);
    for (const child of node.children ?? []) collect(child);
  };
  collect(root);
  const scan = (node: MdNode): void => {
    if (node.type === 'footnoteDefinition') return;
    if (node.type === 'footnoteReference' && typeof node.identifier === 'string') referenced.add(node.identifier);
    for (const child of node.children ?? []) scan(child);
  };
  scan(root);
  const expanded = new Set<string>();
  for (;;) {
    const found = [...referenced].find((identifier) => definitions.has(identifier) && !expanded.has(identifier));
    if (found === undefined) return referenced;
    expanded.add(found);
    for (const child of definitions.get(found)!.children ?? []) scan(child);
  }
}

/** The targets of every rendered `madarch:` link, in source order: inline and reference links, and rendered notes. */
export function madarchTargets(markdown: string): string[] {
  const root = parseMarkdown(markdown);
  if (root === undefined) return [];
  const definitions = new Map<string, string>();
  const collectDefinitions = (node: MdNode): void => {
    if (node.type === 'definition' && typeof node.identifier === 'string' && typeof node.url === 'string') definitions.set(node.identifier, node.url);
    for (const child of node.children ?? []) collectDefinitions(child);
  };
  collectDefinitions(root);
  const used = usedFootnotes(root);
  const targets: string[] = [];
  const add = (url: string | undefined): void => {
    if (url !== undefined && url.startsWith('madarch:')) targets.push(url.slice('madarch:'.length));
  };
  const walk = (node: MdNode): void => {
    if (node.type === 'footnoteDefinition') {
      if (node.identifier === undefined || !used.has(node.identifier)) return;
    }
    if (node.type === 'link') add(node.url);
    if (node.type === 'linkReference' && typeof node.identifier === 'string') add(definitions.get(node.identifier));
    // The destination of an image is not a page mention, and neither is a definition's URL by itself.
    for (const child of node.children ?? []) walk(child);
  };
  walk(root);
  return targets;
}
