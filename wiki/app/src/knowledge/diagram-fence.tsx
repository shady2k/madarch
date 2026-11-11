/**
 * A ```mermaid fence in a document (madarch-u3vw.18): the fence the Markdown
 * parser marked as Mermaid is drawn by the wiki's own Mermaid renderer
 * (`../diagram.js`: the pinned mermaid, loaded at the first draw, and the
 * reader's colour scheme), under a Diagram / Source switch. A fence in any
 * other language stays the code block it was.
 *
 * The fence is recognised by the language the parser put on its code node,
 * never by reading the text; a failed draw says where the fence stands — the
 * document's path and the fence's line — instead of leaving an empty frame.
 */
import { useState, type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { MermaidDiagram } from '../diagram.js';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs.js';

/** The part of the Markdown parser's node that says what a `<pre>` holds. */
export interface FenceNode {
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: FenceNode[];
  type?: string;
  value?: string;
  position?: { start: { line: number } };
}

/** The language the parser gave the code fence inside a `<pre>`, or null when it holds no fenced code. */
export function fenceLanguage(block: FenceNode | undefined): string | null {
  const code = block?.tagName === 'pre' ? block.children?.[0] : undefined;
  if (code?.tagName !== 'code') return null;
  const names = code.properties?.['className'];
  const list = Array.isArray(names) ? names : typeof names === 'string' ? names.split(/\s+/) : [];
  for (const name of list) {
    if (typeof name === 'string' && name.startsWith('language-')) return name.slice('language-'.length).toLowerCase();
  }
  return null;
}

/** The text of the fence: its code node's text, as the parser kept it. */
function fenceText(block: FenceNode | undefined): string {
  const code = block?.children?.[0];
  return (code?.children ?? []).map((child) => (child.type === 'text' ? child.value ?? '' : '')).join('');
}

/** The Mermaid source of the fence this `<pre>` holds and the line its opening stands on, or null when it is no Mermaid fence. */
export function mermaidFence(block: FenceNode | undefined): { source: string; line: number | null } | null {
  if (fenceLanguage(block) !== 'mermaid') return null;
  return { source: fenceText(block), line: block?.position?.start.line ?? null };
}

/** Where the fence stands, in the reader's words: `path:line`, or the line alone when no path is known. */
function placeOf(path: string | null, line: number | null, t: (key: string, options?: Record<string, unknown>) => string): string | undefined {
  if (line === null) return path ?? undefined;
  return path === null ? t('knowledge.documentDiagram.line', { line }) : `${path}:${line}`;
}

/**
 * One Mermaid fence: the diagram the fence draws, or its source, chosen by the
 * switch above the frame. The diagram scrolls in its own box at its natural
 * size (the frame `.diagram-mermaid` already gives every diagram).
 */
export function MermaidFence({ source, line, path }: { source: string; line: number | null; path: string | null }): ReactElement {
  const { t } = useTranslation();
  const [view, setView] = useState<'diagram' | 'source'>('diagram');
  const place = placeOf(path, line, t);
  return (
    <section className="fence-diagram" data-fence="mermaid" data-fence-line={line ?? undefined} data-testid="mermaid-fence">
      <Tabs value={view} onValueChange={(value) => setView(value as 'diagram' | 'source')}>
        <div className="fence-bar">
          <span className="dg-spacer" />
          <TabsList aria-label={t('knowledge.documentDiagram.switch')}>
            <TabsTrigger value="diagram" data-testid="fence-diagram-tab">{t('knowledge.documentDiagram.diagram')}</TabsTrigger>
            <TabsTrigger value="source" data-testid="fence-source-tab">{t('knowledge.documentDiagram.source')}</TabsTrigger>
          </TabsList>
        </div>
        <TabsContent value="diagram">
          <MermaidDiagram source={source} {...(place === undefined ? {} : { place })} />
        </TabsContent>
        <TabsContent value="source">
          <pre className="fence-source" data-testid="fence-source"><code>{source}</code></pre>
        </TabsContent>
      </Tabs>
    </section>
  );
}
