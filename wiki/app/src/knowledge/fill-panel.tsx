/**
 * The top bar's fill panel (madarch-stm0.6, the owner's item 5 and 6 of the fill design): a panel from the right over the
 * page — not a modal and not a page of its own — that says filling everything at once is not needed and that the next run
 * continues, lists the catalogue's sections with a checkbox each, how many entities they hold, who fills them, and what a
 * run would cost, and holds the agent choice, the token cap and the press. After the press it shows the run's progress and
 * a way to the fill page; closing it does not stop the fill.
 *
 * The engine names no entity here: the sections, their kinds, who fills them and their estimates are the catalogue's own
 * answer (src/knowledge/catalog-view.ts), and the selection is the product's state in the store.
 */
import { useEffect, useState, type ReactElement, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, AlertDescription } from '@/components/ui/alert.js';
import { Badge } from '@/components/ui/badge.js';
import { Button } from '@/components/ui/button.js';
import { getAgents, getCatalog, getFillSelection, fillSelected } from './api.js';
import { KLink } from './blocks.js';
import { WIKI_CATALOGUE, WIKI_FILL } from './routes.js';
import type { AgentOffer, CatalogKindView, CatalogView, FillSelectionView, WikiStatus } from './types.js';

/** One section of the catalogue as the panel lists it: its name, its kinds and what they add up to. */
export interface PanelSection {
  readonly key: string;
  readonly name: string;
  readonly kinds: readonly CatalogKindView[];
  readonly count: number;
  readonly plugins: number;
  readonly agent: number;
  readonly volume: number;
  readonly tokens: number | null;
  readonly seconds: number | null;
  readonly unknown: number;
}

/**
 * The catalogue's sections with what each one adds up to: entities, how many of them their own plugins fill and how many
 * the agent does, the volume the graph measures and the cost where every kind of the section declares a per-unit figure.
 * The grouping is the catalogue's own (its groups, its areas and its subgroups), never a list of kinds held here.
 */
export function panelSections(catalog: CatalogView, language: string): PanelSection[] {
  const known = new Set(catalog.groups.map((group) => group.group));
  const label = (key: string): string => {
    const group = catalog.groups.find((held) => held.group === key);
    return group?.labels[language] ?? group?.labels['en'] ?? key;
  };
  const areas = [...new Set(catalog.kinds.map((kind) => kind.area))].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  return areas.map((area) => {
    const kinds = catalog.kinds.filter((kind) => kind.area === area);
    let tokens = 0;
    let seconds = 0;
    let unknown = 0;
    for (const kind of kinds) {
      if (kind.estimate.tokens === null || kind.estimate.seconds === null) unknown += 1;
      else { tokens += kind.estimate.tokens; seconds += kind.estimate.seconds; }
    }
    return {
      key: area,
      name: known.has(area) ? label(area) : area,
      kinds,
      count: kinds.reduce((sum, kind) => sum + kind.count, 0),
      plugins: kinds.filter((kind) => (kind.plugins ?? []).length > 0).length,
      agent: kinds.filter((kind) => (kind.plugins ?? []).length === 0).length,
      volume: kinds.reduce((sum, kind) => sum + (kind.estimate.volume ?? 0), 0),
      tokens: unknown > 0 ? null : tokens,
      seconds: unknown > 0 ? null : seconds,
      unknown,
    };
  });
}

/** The panel from the right: what a press would fill, what it would cost, and how it is going once it runs. */
export function FillSidePanel({ status, refresh, onClose, id, extra }: { status: WikiStatus; refresh: () => void; onClose: () => void; id?: string; extra?: ReactNode }): ReactElement {
  const { t, i18n } = useTranslation();
  const language = (i18n.resolvedLanguage ?? 'en').startsWith('ru') ? 'ru' : 'en';
  const [catalog, setCatalog] = useState<CatalogView | null>(null);
  const [selected, setSelected] = useState<Set<string> | null>(null);
  const [agents, setAgents] = useState<AgentOffer[]>([]);
  const [agent, setAgent] = useState<string | null>(null);
  const [cap, setCap] = useState('');
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const reading = catalog === null;
  useEffect(() => {
    const controller = new AbortController();
    getCatalog(controller.signal).then((read) => {
      // An answer that is no catalogue is said, never read as an empty one: the panel's sections come from it alone.
      if (!Array.isArray(read.kinds)) { setFailure(t('knowledge.fillPanel.noCatalogue')); return; }
      setCatalog(read);
      setSelected((held) => held ?? new Set(read.kinds.map((kind) => kind.kind)));
    }, (error: unknown) => { if (!controller.signal.aborted) setFailure(error instanceof Error ? error.message : String(error)); });
    getFillSelection(controller.signal).then((answer: { selection?: FillSelectionView }) => {
      // The last selection is the product's state: a stored one replaces the whole-catalogue default, and the panel's
      // agent and cap come with it. An answer that holds no selection is said, never taken for "none".
      const held = answer.selection;
      if (held === undefined) { setFailure(t('knowledge.fillPanel.noSelection')); return; }
      // A selection the person saved is the panel's own, an empty one included; a product whose selection was never
      // written starts with the whole catalogue checked (the owner, 2026-11-10: every entity has an agent plugin).
      if (held.savedAt !== '') setSelected(new Set(held.selected));
      setAgent((current) => current ?? held.agent);
      setCap((current) => (current === '' && held.tokenCap !== null ? String(held.tokenCap) : current));
    }, (error: unknown) => setFailure(error instanceof Error ? error.message : String(error)));
    getAgents(controller.signal).then((answer) => setAgents(Array.isArray(answer.agents) ? answer.agents : []), () => setAgents([]));
    return () => controller.abort();
  }, []);
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  const chosen = selected ?? new Set<string>();
  const sections = catalog === null ? [] : panelSections(catalog, language);
  const press = (): void => {
    if (busy) return;
    setBusy(true);
    setFailure(null);
    const value = cap.trim() === '' ? null : Number(cap);
    fillSelected({ selected: [...chosen].sort(), agent, tokenCap: value !== null && Number.isInteger(value) && value > 0 ? value : null }).then(
      () => { setBusy(false); refresh(); },
      (error: unknown) => { setBusy(false); setFailure(error instanceof Error ? error.message : String(error)); },
    );
  };
  const toggle = (section: PanelSection): void => {
    const all = section.kinds.every((kind) => chosen.has(kind.kind));
    setSelected(() => {
      const next = new Set(chosen);
      for (const kind of section.kinds) { if (all) next.delete(kind.kind); else next.add(kind.kind); }
      return next;
    });
  };
  const totals = sections.reduce((sum, section) => ({ count: sum.count + section.count, tokens: section.tokens === null ? sum.tokens : sum.tokens + section.tokens, seconds: section.seconds === null ? sum.seconds : sum.seconds + section.seconds, unknown: sum.unknown + section.unknown }),
    { count: 0, tokens: 0, seconds: 0, unknown: 0 });
  const selectedCount = chosen.size;
  const running = status.fill.state === 'running';
  const progress = status.fill.progress;
  return (
    <aside
      role="dialog"
      aria-modal="false"
      aria-label={t('knowledge.fillPanel.title')}
      {...(id === undefined ? {} : { id })}
      data-testid="fill-side-panel"
      className="fixed inset-y-0 right-0 z-40 flex w-[min(30rem,100vw)] flex-col border-l border-line bg-page shadow-[var(--shadow-high)]"
    >
      <header className="flex items-start justify-between gap-3 border-b border-line px-4 py-3">
        <div>
          <h2 className="m-0 text-h3 font-semibold text-ink">{t('knowledge.fillPanel.title')}</h2>
          <p className="m-0 mt-1 text-small text-muted">{t('knowledge.fillPanel.product', { name: status.product.name })}</p>
        </div>
        <Button variant="default" size="default" data-testid="fill-side-close" onClick={onClose} aria-label={t('knowledge.fillPanel.close')}>{t('knowledge.fillPanel.close')}</Button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3 text-small">
        <p className="m-0" data-testid="fill-side-intro">{t('knowledge.fillPanel.intro')}</p>
        {extra}
        {running && (
          <section className="mt-3 rounded-[var(--radius-card)] border border-line p-3" data-testid="fill-side-progress">
            <p className="m-0 font-medium text-ink">{t('knowledge.fillPanel.running')}</p>
            {progress !== undefined && (
              <p className="m-0 mt-1 text-small text-secondary" data-testid="fill-side-progress-counts">{t('knowledge.fillPanel.progress', { published: progress.published ?? 0, planned: progress.planned ?? 0 })}</p>
            )}
            <p className="m-0 mt-1 text-small"><KLink href={WIKI_FILL} testId="fill-side-open-fill">{t('knowledge.fillPanel.openFill')}</KLink></p>
            <p className="m-0 mt-1 text-small text-muted">{t('knowledge.fillPanel.closingKeeps')}</p>
          </section>
        )}
        {reading && <p className="mt-3 text-muted" data-testid="fill-side-loading">{t('knowledge.loading')}</p>}
        {!reading && (
          <section className="mt-3" data-testid="fill-side-sections">
            <h3 className="mb-2 mt-0 text-[15px] font-semibold text-ink">{t('knowledge.fillPanel.sections')}</h3>
            <ul className="m-0 list-none p-0">
              {sections.map((section) => {
                const all = section.kinds.every((kind) => chosen.has(kind.kind));
                const some = !all && section.kinds.some((kind) => chosen.has(kind.kind));
                return (
                  <li key={section.key} className="flex items-start gap-2 border-b border-line py-2 last:border-b-0" data-testid="fill-side-section" data-section={section.key}>
                    <input
                      type="checkbox"
                      className="mt-1"
                      data-testid={`fill-side-check-${section.key}`}
                      aria-label={t('knowledge.fillPanel.checkSection', { section: section.name })}
                      checked={all}
                      ref={(input) => { if (input !== null) input.indeterminate = some; }}
                      onChange={() => toggle(section)}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block font-medium text-ink">{section.name} <span className="text-small font-normal text-muted">{section.count}</span></span>
                      <span className="block text-small text-muted" data-testid="fill-side-who">{t('knowledge.fillPanel.who', { plugins: section.plugins, agent: section.agent })}</span>
                      <span className="block text-small text-muted" data-testid="fill-side-estimate">
                        {section.tokens === null ? t('knowledge.fillPanel.unknown') : t('knowledge.fillPanel.cost', { tokens: section.tokens, seconds: Math.round(section.seconds ?? 0) })}
                      </span>
                    </span>
                  </li>
                );
              })}
            </ul>
          </section>
        )}
        <section className="mt-3 grid gap-2" data-testid="fill-side-choices">
          <p className="m-0 text-small" data-testid="fill-side-totals">{t('knowledge.fillPanel.selected', { count: selectedCount })}</p>
          <p className="m-0 text-small text-muted" data-testid="fill-side-total-cost">
            {totals.tokens === null || totals.unknown > 0 ? t('knowledge.fillPanel.unknown') : t('knowledge.fillPanel.cost', { tokens: totals.tokens, seconds: Math.round(totals.seconds) })}
          </p>
          <label className="grid gap-1" htmlFor="fill-side-agent">
            <span className="text-secondary">{t('knowledge.fillPanel.agent')}</span>
            <select id="fill-side-agent" data-testid="fill-side-agent" className="w-full max-w-[18rem] rounded-[var(--radius-control)] border border-line bg-page px-2 py-1 text-body text-ink" value={agent ?? ''} onChange={(event) => setAgent(event.target.value === '' ? null : event.target.value)}>
              <option value="">{t('knowledge.fillPanel.noAgent')}</option>
              {agents.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
            </select>
          </label>
          <label className="grid gap-1" htmlFor="fill-side-cap">
            <span className="text-secondary">{t('knowledge.fillPanel.cap')}</span>
            <input id="fill-side-cap" data-testid="fill-side-cap" className="w-32 rounded-[var(--radius-control)] border border-line bg-page px-2 py-1 text-body text-ink" inputMode="numeric" placeholder={t('knowledge.fillPanel.noCap')} value={cap} onChange={(event) => setCap(event.target.value.replace(/[^0-9]/gu, ''))} />
          </label>
          <p className="m-0 text-small text-muted">{t('knowledge.fillPanel.capNote')}</p>
        </section>
        <p className="m-0 mt-3 text-small"><KLink href={WIKI_CATALOGUE} testId="fill-side-catalogue">{t('knowledge.fillPanel.catalogue')}</KLink></p>
        {failure !== null && <Alert variant="problem" className="mt-3" data-testid="fill-side-error"><AlertDescription><p>{failure}</p></AlertDescription></Alert>}
      </div>
      <footer className="border-t border-line px-4 py-3">
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="default" size="default" className="!border-ink !bg-ink !text-page" data-testid="fill-side-press" disabled={busy || selectedCount === 0} onClick={press}>{busy ? t('knowledge.fillPanel.pressing') : t('knowledge.fillPanel.press')}</Button>
          <Badge variant="outline" data-testid="fill-side-agent-note">{agent === null ? t('knowledge.fillPanel.agentWaiting') : t('knowledge.fillPanel.agentChosen', { agent: agents.find((entry) => entry.id === agent)?.label ?? agent })}</Badge>
        </div>
      </footer>
    </aside>
  );
}
