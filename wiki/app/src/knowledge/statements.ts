/**
 * How an agent's page reads (madarch-m38l.6): the sentences of its text are the
 * statements, each one a plain run of text; the footnotes that ground them stay
 * out of the reading (no number after the sentence, no list of grounds at the
 * end) and come back with the "Show grounds" switch. A sentence with no ground
 * is marked, and a click on a sentence opens its statement.
 *
 * This is a remark plugin over the Markdown tree. It cuts a paragraph into
 * sentences by the rule of the engine's own reader (`readBody` in
 * `src/knowledge/markdown.ts`): a sentence ends at `.`, `!` or `?` followed by a
 * blank (with `)`, quotes and the footnote reference after the full stop kept
 * in it); a sentence of fewer than four words, one that opens with "See",
 * "Related" or "Next", and a paragraph made only of links state nothing and
 * stay as they are. The server finds the sentence again by its text.
 */

export interface MNode {
  type: string;
  value?: string;
  identifier?: string;
  label?: string;
  url?: string;
  children?: MNode[];
  data?: { hName?: string; hProperties?: Record<string, unknown> };
}

/** The plain text of a node the way the engine's reader flattens it (a footnote reference is nothing). */
export function plainText(node: MNode): string {
  if (node.type === 'text') return (node.value ?? '').replace(/\[\^[^\]\s]+\]/g, '');
  if (node.type === 'inlineCode') return node.value ?? '';
  if (node.type === 'footnoteReference') return '';
  if (node.type === 'break') return ' ';
  return (node.children ?? []).map(plainText).join('');
}

interface Cut {
  nodes: MNode[];
  notes: string[];
}

const SENTENCE_END = /[.!?]/;
const AFTER_END = /[.!?)"'”]/;

/** The labels of the footnote references inside a node, in order. */
function referencesIn(node: MNode): string[] {
  if (node.type === 'footnoteReference') return [node.identifier ?? node.label ?? ''];
  return (node.children ?? []).flatMap(referencesIn);
}

/**
 * Cuts the inline children of a paragraph into sentences; the blank between two sentences stays a text node of its own.
 * A formatted run (bold, a link, code) is one piece: only the paragraph's own text is cut at a blank, as the engine does.
 */
export function cutSentences(children: readonly MNode[]): (Cut | MNode)[] {
  const out: (Cut | MNode)[] = [];
  let current: Cut = { nodes: [], notes: [] };
  let terminated = false;
  const close = (): void => {
    if (current.nodes.length > 0 || current.notes.length > 0) out.push(current);
    current = { nodes: [], notes: [] };
    terminated = false;
  };
  for (const child of children) {
    if (child.type === 'footnoteReference') {
      current.notes.push(child.identifier ?? child.label ?? '');
      current.nodes.push(child);
      continue;
    }
    if (child.type !== 'text') {
      current.nodes.push(child);
      current.notes.push(...referencesIn(child));
      // The piece's own characters move the state: a full stop at its end followed by a blank in the paragraph's text ends the sentence.
      for (const char of plainText(child)) {
        if (terminated && /\s/.test(char)) continue;
        if (terminated && !AFTER_END.test(char)) terminated = false;
        if (SENTENCE_END.test(char)) terminated = true;
      }
      continue;
    }
    let run = '';
    const flush = (): void => {
      if (run !== '') current.nodes.push({ type: 'text', value: run });
      run = '';
    };
    for (const char of child.value ?? '') {
      if (terminated && /\s/.test(char)) {
        flush();
        close();
        out.push({ type: 'text', value: char });
        continue;
      }
      if (terminated && !AFTER_END.test(char)) terminated = false;
      run += char;
      if (SENTENCE_END.test(char)) terminated = true;
    }
    flush();
  }
  close();
  return out;
}

const isCut = (item: Cut | MNode): item is Cut => 'notes' in item;

/** Whether the sentence is connecting text, which states nothing (see the module's note). */
function connecting(paragraph: MNode, text: string): boolean {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length < 4 || /^(see|see also|related|next)\b/i.test(text)) return true;
  return (paragraph.children ?? []).every((child) => child.type === 'link' || (child.type === 'text' && (child.value ?? '').trim().replace(/[,;:.\-–—]/g, '') === ''));
}

export interface StatementOptions {
  /** The grounds are shown: footnote numbers stay in the text and the list of grounds stays at the end. */
  showGrounds: boolean;
}

/** The remark plugin; the tree is changed in place. */
export function remarkStatements(options: StatementOptions): (tree: MNode) => void {
  return (tree) => {
    // The same sentence may stand twice on a page; the second is the second of its text, so each is found again by its text and its turn.
    const turns = new Map<string, number>();
    const walk = (node: MNode): void => {
      if (node.type === 'footnoteDefinition') return;
      if (node.type === 'paragraph' && node.children !== undefined) {
        const items = cutSentences(node.children);
        const rebuilt: MNode[] = [];
        for (const item of items) {
          if (!isCut(item)) {
            rebuilt.push(item);
            continue;
          }
          const text = item.nodes.map(plainText).join('').trim();
          const kept = options.showGrounds ? item.nodes : item.nodes.filter((child) => child.type !== 'footnoteReference');
          if (text === '' || connecting(node, text)) {
            rebuilt.push(...kept);
            continue;
          }
          const grounded = item.notes.length > 0;
          const squashed = text.replace(/\s+/g, ' ');
          const turn = turns.get(squashed) ?? 0;
          turns.set(squashed, turn + 1);
          rebuilt.push({
            type: 'statement',
            data: { hName: 'span', hProperties: { className: ['statement', grounded ? 'statement-grounded' : 'statement-ungrounded'], 'data-statement': text, 'data-turn': String(turn), 'data-grounded': grounded ? 'true' : 'false' } },
            children: kept,
          });
        }
        node.children = rebuilt;
        for (const child of node.children) walk(child);
        return;
      }
      for (const child of node.children ?? []) walk(child);
    };
    walk(tree);
    if (!options.showGrounds && tree.children !== undefined) tree.children = tree.children.filter((child) => child.type !== 'footnoteDefinition');
  };
}
