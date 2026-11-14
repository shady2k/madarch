/**
 * The diagram of the page's entity (decision 0036, sections 7 and 8): the server renders the picture — the neighbourhood
 * at a depth, an edge and its inverse drawn once, more than `aggregateAbove` neighbours of one kind folded into one node
 * with the count — and this section only shows it, in three tabs: LikeC4's interactive runtime over the server's computed
 * view, Mermaid's own renderer over the server's source, and archify's interactive page the server made. A press on a node
 * in any tab walks to the entity's page. Nothing here lays anything out.
 */
import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';
import { valueAt } from '../../../../src/page-contract/index.js';
import { Notice } from './ui/data.js';
import { Stack } from './ui/layout.js';
import { Tabs } from './ui/controls.js';
import { Muted } from './ui/typography.js';
import { LikeC4Pane } from './diagram-panes/likec4-pane.js';
import { MermaidPane } from './diagram-panes/mermaid-pane.js';
import { ArchifyPane } from './diagram-panes/archify-pane.js';
import type { LikeC4Answer, MermaidAnswer } from './diagram-types.js';
import type { SectionContext } from './types.js';

type Tab = 'likec4' | 'mermaid' | 'archify';

const TABS: readonly { readonly id: Tab; readonly label: string }[] = [
  { id: 'likec4', label: 'LikeC4' },
  { id: 'mermaid', label: 'Mermaid' },
  { id: 'archify', label: 'archify' },
];

/** The format the reader opened last; the first visit draws nothing until the reader asks, because each picture costs a render. */
const PREFERRED_KEY = 'madarch-wiki-diagram';

function preferredTab(): Tab | null {
  try {
    const held = window.localStorage.getItem(PREFERRED_KEY);
    if (held === 'likec4' || held === 'mermaid' || held === 'archify') return held;
  } catch {
    // A browser that refuses storage keeps the choice for this page only.
  }
  return null;
}

export function DiagramSection({ context }: { readonly context: SectionContext }): ReactElement {
  const id = typeof valueAt(context.data, 'id') === 'string' ? String(valueAt(context.data, 'id')) : '';
  const depth = typeof context.section.params['depth'] === 'number' ? context.section.params['depth'] : 1;
  const aggregateAbove = typeof context.section.params['aggregateAbove'] === 'number' ? context.section.params['aggregateAbove'] : 12;
  const [tab, setTab] = useState<Tab | null>(() => preferredTab());
  const [answers, setAnswers] = useState<Record<string, LikeC4Answer | MermaidAnswer | { failed: string }>>({});
  const [root, setRoot] = useState<HTMLElement | null>(null);
  useEffect(() => { setRoot(document.getElementById('root')); }, []);
  const address = useMemo(() => {
    const query = new URLSearchParams({ entity: id, depth: String(depth), aggregateAbove: String(aggregateAbove) });
    return (format: Tab): string => `${context.base}/render/diagram?${query.toString()}&format=${format}`;
  }, [id, depth, aggregateAbove, context.base]);
  const ask = useCallback(async (format: Tab): Promise<void> => {
    if (id === '' || answers[format] !== undefined) return;
    try {
      const answer = await fetch(address(format));
      if (!answer.ok) {
        const said = (await answer.json().catch(() => ({}))) as { message?: string };
        setAnswers((held) => ({ ...held, [format]: { failed: said.message ?? `the diagram answered ${String(answer.status)}` } }));
        return;
      }
      const body = (await answer.json()) as Record<string, unknown>;
      setAnswers((held) => ({ ...held, [format]: body as unknown as LikeC4Answer | MermaidAnswer }));
    } catch (error) {
      setAnswers((held) => ({ ...held, [format]: { failed: error instanceof Error ? error.message : String(error) } }));
    }
  }, [address, answers, id]);
  useEffect(() => { if (tab !== null) void ask(tab); }, [tab, ask]);
  const held = tab === null ? undefined : answers[tab];
  return (
    <Stack gap={2}>
      <Tabs tabs={TABS} active={tab ?? ''} onSelect={(next) => { const chosen = next as Tab; setTab(chosen); try { window.localStorage.setItem(PREFERRED_KEY, chosen); } catch { /* no storage */ } }} />
      {tab === null ? (
        <Muted>Choose a picture.</Muted>
      ) : tab === 'archify' ? (
        <ArchifyPane src={address('archify')} root={root} open={context.open} />
      ) : held === undefined ? (
        <Muted>Loading the picture…</Muted>
      ) : 'failed' in held ? (
        <Notice>{held.failed}</Notice>
      ) : tab === 'likec4' ? (
        <LikeC4Pane answer={held as LikeC4Answer} open={(path) => context.open(path)} />
      ) : (
        <MermaidPane answer={held as MermaidAnswer} open={(path) => context.open(path)} />
      )}
    </Stack>
  );
}
