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

type Tab = 'likec4' | 'mermaid' | 'archify';

const TABS: readonly { readonly id: Tab; readonly label: string }[] = [
  { id: 'likec4', label: 'LikeC4' },
  { id: 'mermaid', label: 'Mermaid' },
  { id: 'archify', label: 'archify' },
];

/**
 * The format a failed one falls back to: LikeC4's runtime hands the picture to Mermaid's renderer, which either draws it
 * or reports its own failure. archify answers no failure of its own, so it is never a fallback (madarch-64o5.134).
 */
function nextFormat(format: Tab): Tab | undefined {
  return format === 'likec4' ? 'mermaid' : undefined;
}

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
  const [fallbackTo, setFallbackTo] = useState<Readonly<Record<string, Tab>>>({});
  const [full, setFull] = useState(false);
  const [answers, setAnswers] = useState<Record<string, LikeC4Answer | MermaidAnswer | { failed: string }>>({});
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
      const answer = await fetch(key, { signal: stop.signal });
      if (!answer.ok) {
        const said = (await answer.json().catch(() => ({}))) as { code?: string };
        setAnswers((held) => ({ ...held, [key]: { failed: failure(said.code) } }));
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
  // The renderer whose answer the picture shows: the reader's choice, or the one it fell back to for this address.
  const took = fallbackTo[address(tab)] ?? tab;
  const held = answers[address(took)];
  useEffect(() => {
    if (held === undefined || !('failed' in held) || took !== tab) return;
    const next = nextFormat(tab);
    if (next === undefined) return;
    setFallbackTo((current) => ({ ...current, [address(tab)]: next }));
    void ask(next);
  }, [held, tab, took, ask]);
  // One picture, one place: the renderers are a choice inside the figure, not three tabs beside each other — the page's
  // own tabs stay for the page's sections (madarch-64o5.83).
  const label = (format: Tab): string => TABS.find((one) => one.id === format)?.label ?? format;
  const note = took !== tab && held !== undefined && !('failed' in held)
    ? <Metadata data-testid="diagram-fallback">{t('knowledge.diagramFellBack', { renderer: label(took), failed: label(tab) })}</Metadata>
    : null;
  const picture = (
    <div data-testid="diagram-picture">
      {took === 'archify' ? (
        <ArchifyPane src={address('archify')} root={root} open={context.open} />
      ) : held === undefined ? (
        <Paragraph>{t('knowledge.loadingPicture')}</Paragraph>
      ) : 'failed' in held ? (
        <Stack>
          <Alert variant="problem"><AlertDescription>{held.failed}</AlertDescription></Alert>
          <InlineGroup>
            <Button variant="default" size="sm" data-testid="diagram-retry" onClick={() => {
              setAnswers((current) => { const next = { ...current }; delete next[address(took)]; return next; });
              setFallbackTo((current) => { const next = { ...current }; delete next[address(tab)]; return next; });
              void ask(took);
            }}>{t('knowledge.retry')}</Button>
          </InlineGroup>
        </Stack>
      ) : took === 'likec4' ? (
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
          testId="diagram-renderer"
          value={tab}
          options={TABS.map((one) => ({ value: one.id, label: one.label, testId: `diagram-renderer-${one.id}` }))}
          onChange={(next) => { const chosen = next as Tab; setTab(chosen); try { window.localStorage.setItem(PREFERRED_KEY, chosen); } catch { /* no storage */ } }}
        />
        <Button size="sm" data-testid="diagram-fullscreen" onClick={() => { setFull(true); }}>{t('knowledge.fullScreen')}</Button>
      </InlineGroup>
      {note}
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
