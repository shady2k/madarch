/**
 * The diagram of the page's entity (decision 0036, sections 7 and 8): the server renders the picture — the neighbourhood
 * at a depth, an edge and its inverse drawn once, more than `aggregateAbove` neighbours of one kind folded into one node
 * with the count — and this section only shows it, in three tabs: LikeC4's interactive runtime over the server's computed
 * view, Mermaid's own renderer over the server's source, and archify's interactive page the server made. A press on a node
 * in any tab walks to the entity's page. Nothing here lays anything out.
 */
import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { valueAt } from '../../../../src/page-contract/index.js';
import { withSpan } from '../trace.js';
import { Alert, AlertDescription } from './ui/alert.js';
import { Button } from './ui/button.js';
import { InlineGroup } from './ui/typography.js';
import { SegmentedChoice } from './ui/segmented-choice.js';
import { Metadata, Paragraph, Stack } from './ui/typography.js';
import { Dialog, DialogBody, DialogContent, DialogHeader, DialogTitle } from './ui/dialog.js';
import { LikeC4Pane } from './diagram-panes/likec4-pane.js';
import { MermaidPane } from './diagram-panes/mermaid-pane.js';
import { ArchifyPane } from './diagram-panes/archify-pane.js';
import type { LikeC4Answer, MermaidAnswer } from './diagram-types.js';
import type { SectionContext } from './types.js';

const RENDERER_CONTROL = {
  testId: "diagram-renderer",
} as const;

type Tab = 'likec4' | 'mermaid' | 'archify';

const TABS: readonly { readonly id: Tab; readonly label: string }[] = [
  { id: 'likec4', label: 'LikeC4' },
  { id: 'mermaid', label: 'Mermaid' },
  { id: 'archify', label: 'archify' },
];

/** The format the reader opened last; the first visit draws the server's own LikeC4 picture until the reader picks another. */
const PREFERRED_KEY = 'madarch-wiki-diagram';

function preferredTab(): Tab | null {
  try {
    const held = window.localStorage.getItem(PREFERRED_KEY);
    if (held === 'likec4' || held === 'mermaid' || held === 'archify') return held;
  } catch {
    // A browser that refuses storage keeps the choice for this page only.
  }
  return 'likec4';
}

export function DiagramSection({ context }: { readonly context: SectionContext }): ReactElement {
  const { t } = useTranslation();
  const id = typeof valueAt(context.data, 'id') === 'string' ? String(valueAt(context.data, 'id')) : '';
  const depth = typeof context.section.params['depth'] === 'number' ? context.section.params['depth'] : 1;
  const aggregateAbove = typeof context.section.params['aggregateAbove'] === 'number' ? context.section.params['aggregateAbove'] : 12;
  const [tab, setTab] = useState<Tab>(() => preferredTab() ?? 'likec4');
  // A renderer that fails hands the picture to the next one, and the page says which one drew it (madarch-64o5.134).
  const [full, setFull] = useState(false);
  const [answers, setAnswers] = useState<Record<string, LikeC4Answer | MermaidAnswer | { failed: string; place?: string }>>({});
  const [root, setRoot] = useState<HTMLElement | null>(null);
  useEffect(() => { setRoot(document.getElementById('root')); }, []);
  const address = useMemo(() => {
    const query = new URLSearchParams({ entity: id, depth: String(depth), aggregateAbove: String(aggregateAbove), lang: context.language });
    return (format: Tab): string => `${context.base}/render/diagram?${query.toString()}&format=${format}`;
  }, [id, depth, aggregateAbove, context.base, context.language]);
  const failure = useCallback((code: string | undefined): string => {
    switch (code) {
      case 'TIMEOUT': return t('knowledge.diagramTooLong');
      case 'TOO_LARGE': return t('knowledge.diagramTooLarge');
      case 'BAD_INPUT': return t('knowledge.diagramBadRequest');
      default: return t('knowledge.diagramFailed');
    }
  }, [t]);
  const ask = useCallback(async (format: Tab): Promise<void> => {
    const key = address(format);
    if (id === '' || answers[key] !== undefined) return;
    const stop = new AbortController();
    const timer = setTimeout(() => { stop.abort(); }, 15000);
    try {
      const answer = await withSpan('net.fetch', { 'http.method': 'GET', 'http.url': key }, async (span) => {
        const held = await fetch(key, { signal: stop.signal });
        span.setAttribute('http.status', held.status);
        return held;
      });
      if (!answer.ok) {
        // The server's own words stay data: the place and the cause it names are what a reader can act on, and the
        // sentence around them is the interface's (madarch-64o5.134).
        const said = (await answer.json().catch(() => ({}))) as { code?: string; message?: unknown };
        const place = typeof said.message === 'string' ? said.message : '';
        setAnswers((held) => ({ ...held, [key]: { failed: failure(said.code), ...(place === '' ? {} : { place }) } }));
        return;
      }
      const body = (await answer.json()) as Record<string, unknown>;
      setAnswers((held) => ({ ...held, [key]: body as unknown as LikeC4Answer | MermaidAnswer }));
    } catch (error) {
      setAnswers((held) => ({ ...held, [key]: { failed: failure(error instanceof Error && error.name === 'AbortError' ? 'TIMEOUT' : undefined) } }));
    } finally {
      clearTimeout(timer);
    }
  }, [address, answers, id, failure, t]);
  useEffect(() => { void ask(tab); }, [tab, ask]);
  const held = answers[address(tab)];
  // One picture, one place: the renderers are a choice inside the figure, not three tabs beside each other — the page's
  // own tabs stay for the page's sections (madarch-64o5.83).
  const picture = (
    <div data-testid="diagram-picture">
      {tab === 'archify' ? (
        <ArchifyPane src={address('archify')} root={root} open={context.open} />
      ) : held === undefined ? (
        <Paragraph>{t('knowledge.loadingPicture')}</Paragraph>
      ) : 'failed' in held ? (
        <Stack>
          <Alert variant="problem"><AlertDescription>{held.failed}</AlertDescription></Alert>
          {held.place === undefined ? null : <Metadata data-testid="diagram-failure-place">{held.place}</Metadata>}
          <InlineGroup>
            <Button variant="default" size="sm" data-testid="diagram-retry" onClick={() => {
              setAnswers((current) => { const next = { ...current }; delete next[address(tab)]; return next; });
              void ask(tab);
            }}>{t('knowledge.retry')}</Button>
          </InlineGroup>
        </Stack>
      ) : tab === 'likec4' ? (
        <LikeC4Pane answer={held as LikeC4Answer} open={(path) => { context.open(path); }} />
      ) : (
        <MermaidPane answer={held as MermaidAnswer} open={(path) => { context.open(path); }} />
      )}
    </div>
  );
  // One picture, one place: the renderers are a choice inside the figure, not three tabs beside each other — the page's
  // own tabs stay for the page's sections (madarch-64o5.83). The same figure fills the window on a press, and Escape
  // closes it (madarch-64o5.134).
  return (
    <Stack>
      <InlineGroup>
        <SegmentedChoice
          label={t('knowledge.diagramRenderer')}
          testId={RENDERER_CONTROL.testId}
          value={tab}
          options={TABS.map((one) => ({ value: one.id, label: one.label, testId: `diagram-renderer-${one.id}` }))}
          onChange={(next) => { const chosen = next as Tab; setTab(chosen); try { window.localStorage.setItem(PREFERRED_KEY, chosen); } catch { /* no storage */ } }}
        />
        <Button size="sm" data-testid="diagram-fullscreen" onClick={() => { setFull(true); }}>{t('knowledge.fullScreen')}</Button>
      </InlineGroup>
      {full ? null : picture}
      <Dialog open={full} onOpenChange={setFull}>
        <DialogContent size="window" closeLabel={t('knowledge.close')}>
          <DialogHeader><DialogTitle>{t('knowledge.fullScreen')}</DialogTitle></DialogHeader>
          <DialogBody data-testid="diagram-fullscreen-body">{full ? picture : null}</DialogBody>
        </DialogContent>
      </Dialog>
    </Stack>
  );
}
