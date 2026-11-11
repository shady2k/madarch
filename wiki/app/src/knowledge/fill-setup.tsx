import { useEffect, useState, type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, AlertDescription } from '@/components/ui/alert.js';
import { Badge } from '@/components/ui/badge.js';
import { Button } from '@/components/ui/button.js';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card.js';
import { Checkbox } from '@/components/ui/checkbox.js';
import { Input } from '@/components/ui/input.js';
import { Select } from '@/components/ui/select.js';
import { fillSelected, getAgents, getCatalog } from './api.js';
import { areaOf } from './catalog-area.js';
import { KindSources } from './kind-sources.js';
import { dependencySplit } from './dependency-page.js';
import { addedByDependency, estimateOf } from './fill-selection.js';
import { useRead } from './live.js';
import { fillWithOf } from './producers.js';
import { PageSkeleton } from './skeleton.js';
import type { AgentOffer, CatalogKindView, CatalogView } from './types.js';

/** One consent surface. Saved selections never become a new run's selection. */
export function FillSetup({ refresh, disabled = false }: { refresh: () => void; disabled?: boolean }): ReactElement {
  const { t, i18n } = useTranslation();
  const language = (i18n.resolvedLanguage ?? 'en').startsWith('ru') ? 'ru' : 'en';
  const { data, error } = useRead<CatalogView>('fill-setup', 0, getCatalog);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [agents, setAgents] = useState<AgentOffer[]>([]);
  const [agent, setAgent] = useState<string | null>(null);
  const [cap, setCap] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    getAgents(controller.signal).then((answer) => setAgents(answer.agents), (error: unknown) => {
      if (!controller.signal.aborted) setFailure(error instanceof Error ? error.message : String(error));
    });
    return () => controller.abort();
  }, []);
  if (data === null) return error === null ? <PageSkeleton testId="fill-setup-loading" /> : <Alert><AlertDescription>{error}</AlertDescription></Alert>;
  const all = data.kinds;
  const added = addedByDependency(all, checked);
  const active = new Set([...checked, ...added.keys()]);
  const chosen = all.filter((kind) => active.has(kind.kind));
  const cost = estimateOf(all, checked, added);
  const name = (kind: CatalogKindView): string => kind.labels?.[language]?.many ?? kind.kind;
  const byId = new Map(all.map((kind) => [kind.kind, kind]));
  const neededName = (id: string): string => byId.has(id) ? name(byId.get(id)!) : id;
  const locked = disabled || busy;
  const validCap = cap.trim() === '' || (Number.isSafeInteger(Number(cap)) && Number(cap) > 0);
  const sections = [...new Set(all.map((kind) => areaOf(data.groups, kind)))].map((area) => ({
    area, name: data.groups.find((group) => group.group === area)?.labels[language] ?? (area || t('knowledge.fillSetup.other')),
    kinds: all.filter((kind) => areaOf(data.groups, kind) === area),
  }));
  const change = (ids: string[], remove: boolean): void => {
    setChecked((held) => {
      const next = new Set(held);
      for (const id of ids) { if (remove) next.delete(id); else next.add(id); }
      return next;
    });
    setFailure(null);
  };
  const run = (): void => {
    if (checked.size === 0 || locked || !validCap) return;
    setBusy(true);
    setFailure(null);
    fillSelected({ selected: [...checked].sort(), agent, tokenCap: cap.trim() === '' ? null : Number(cap) }).then(
      () => { setBusy(false); setChecked(new Set()); refresh(); },
      (error: unknown) => { setBusy(false); setFailure(error instanceof Error ? error.message : String(error)); },
    );
  };
  const { nodes, layers, independent } = dependencySplit(all);
  const boxWidth = 176, boxHeight = 52, columnWidth = 224, rowHeight = 68;
  const positions = new Map(nodes.map((node) => [node.kind.kind, { x: node.depth * columnWidth + 8, y: layers[node.depth]!.indexOf(node.kind.kind) * rowHeight + 8 }]));
  const width = Math.max(layers.length, 1) * columnWidth;
  const height = Math.max(...layers.map((layer) => layer.length), 1) * rowHeight + 16;
  const state = (id: string): string => checked.has(id) ? 'selected' : added.has(id) ? 'dependency' : 'unselected';
  return (
    <Card className="mb-8" data-testid="fill-setup">
      <CardHeader><CardTitle>{t('knowledge.fillSetup.title')}</CardTitle><p className="mb-0 text-small text-muted">{t('knowledge.fillSetup.intro')}</p><p className="mb-0 text-small text-muted" data-testid="fill-setup-total">{t('knowledge.catalogueKinds', { count: all.length })} · {t('knowledge.catalogueEntities', { count: all.reduce((sum, kind) => sum + kind.count, 0) })}</p></CardHeader>
      <CardContent>
        <div className="grid min-w-0 gap-6 lg:grid-cols-[minmax(18rem,1fr)_minmax(0,2fr)]">
          <div data-testid="fill-setup-kinds">
            {sections.map((section) => {
              const on = section.kinds.filter((kind) => checked.has(kind.kind)).length;
              return <section key={section.area} className="mb-4" data-testid="fill-setup-section">
                <h3 className="mt-0 flex items-center gap-2 text-small"><Checkbox aria-label={t('knowledge.fillSetup.section', { section: section.name })} checked={on === section.kinds.length} ref={(input) => { if (input !== null) input.indeterminate = on > 0 && on < section.kinds.length; }} disabled={locked} onChange={() => change(section.kinds.map((kind) => kind.kind), on === section.kinds.length)} />{section.name}</h3>
                {section.kinds.map((kind) => <div key={kind.kind} className="mb-2 text-small" data-kind={kind.kind}><label className="flex items-start gap-2">
                  <Checkbox data-testid={`fill-setup-check-${kind.kind}`} checked={active.has(kind.kind)} disabled={locked || added.has(kind.kind)} onChange={() => change([kind.kind], checked.has(kind.kind))} />
                  <span>{name(kind)}{added.has(kind.kind) && <span className="block text-muted" data-testid="fill-setup-needed">{t('knowledge.fillSetup.neededBy', { kind: neededName(added.get(kind.kind)!) })}</span>}</span>
                </label><div className="ml-6"><KindSources kind={kind} /></div></div>)}
              </section>;
            })}
          </div>
          <section className="min-w-0" aria-label={t('knowledge.fillSetup.graph')}>
            <h3 className="mt-0 text-small">{t('knowledge.fillSetup.graph')}</h3>
            <p className="text-small text-muted">{t('knowledge.fillSetup.legend')}</p>
            <div className="max-h-[32rem] overflow-auto" data-testid="fill-setup-graph">
              <div className="relative" style={{ width, height }}>
                <svg width={width} height={height} aria-hidden="true" className="absolute inset-0">
                  {nodes.flatMap((node) => node.dependsOn.flatMap((dependency) => {
                    const from = positions.get(dependency), to = positions.get(node.kind.kind);
                    if (from === undefined || to === undefined) return [];
                    const highlighted = active.has(node.kind.kind) && active.has(dependency);
                    return [<path key={`${dependency}->${node.kind.kind}`} data-edge={`${dependency}->${node.kind.kind}`} data-active={String(highlighted)} d={`M ${from.x + boxWidth} ${from.y + boxHeight / 2} L ${to.x} ${to.y + boxHeight / 2}`} className={highlighted ? 'fill-none stroke-ink' : 'fill-none stroke-line'} strokeWidth={highlighted ? 3 : 1} />];
                  }))}
                </svg>
                {nodes.map((node) => <div key={node.kind.kind} data-testid="fill-setup-node" data-kind={node.kind.kind} data-selection={state(node.kind.kind)} className={`absolute rounded-[var(--radius-card)] border px-2 py-1 text-small ${active.has(node.kind.kind) ? 'border-ink bg-[var(--surface-active)] text-ink' : 'border-line bg-page text-muted'} ${added.has(node.kind.kind) ? 'border-dashed' : ''}`} style={{ left: positions.get(node.kind.kind)!.x, top: positions.get(node.kind.kind)!.y, width: boxWidth, height: boxHeight }}>
                  <span className="block truncate">{name(node.kind)}</span>{active.has(node.kind.kind) && <span className="text-[11px]">{t(`knowledge.fillSetup.${state(node.kind.kind)}`)}</span>}
                </div>)}
              </div>
            </div>
            {independent.length > 0 && <details className="mt-3 text-small"><summary>{t('knowledge.fillSetup.independent', { count: independent.length })}</summary><div className="mt-2 flex flex-wrap gap-2">{independent.map((kind) => <Badge key={kind.kind} data-testid="fill-setup-node" data-kind={kind.kind} data-selection={state(kind.kind)} variant={active.has(kind.kind) ? 'solid' : 'outline'}>{name(kind)}</Badge>)}</div></details>}
          </section>
        </div>
        <div className="mt-4 flex flex-wrap items-end gap-4 border-t border-line pt-4">
          <label className="grid gap-1 text-small" htmlFor="fill-setup-agent">{t('knowledge.fillSetup.agent')}<Select id="fill-setup-agent" data-testid="fill-setup-agent" disabled value={agent ?? ''} onChange={(event) => setAgent(event.target.value || null)} options={[{ value: '', label: t('knowledge.fillSetup.noAgent') }, ...agents.map((entry) => ({ value: entry.id, label: entry.label }))]} /></label>
          <label className="grid gap-1 text-small" htmlFor="fill-setup-cap">{t('knowledge.fillSetup.cap')}<Input id="fill-setup-cap" data-testid="fill-setup-cap" type="number" min={1} step={1} value={cap} disabled aria-invalid={!validCap} onChange={(event) => setCap(event.target.value)} /></label>
          <p className="m-0 text-small" data-testid="fill-setup-count">{t('knowledge.fillSetup.count', { selected: checked.size, dependencies: added.size })}</p>
          <Button variant="default" size="default" data-testid="fill-setup-run" disabled={locked || checked.size === 0 || !validCap} onClick={run}>{t(busy ? 'knowledge.fillSetup.starting' : 'knowledge.fillSetup.run')}</Button>
        </div>
        <p className="mb-0 mt-3 text-small text-muted" data-testid="fill-setup-unsupported">{t('knowledge.fillSetup.unsupported')}</p>
        {checked.size > 0 && <div className="mt-3 text-small" data-testid="fill-setup-estimate">{cost.tokens === null ? t('knowledge.fillSetup.unknown', { count: cost.unknown }) : t('knowledge.fillSetup.estimate', { tokens: cost.tokens, seconds: Math.round(cost.seconds ?? 0) })}</div>}
        {chosen.filter((kind) => fillWithOf(kind) === 'agent' && agent === null).map((kind) => <p key={kind.kind} className="mb-0 text-small text-muted" data-testid="fill-setup-agent-warning">{t('knowledge.fillSetup.needsAgent', { kind: name(kind) })}</p>)}
        {chosen.filter((kind) => fillWithOf(kind) === 'person').map((kind) => <p key={kind.kind} className="mb-0 text-small text-muted" data-testid="fill-setup-person-warning">{t('knowledge.fillSetup.needsPerson', { kind: name(kind) })}</p>)}
        {!validCap && <p role="alert" className="text-small">{t('knowledge.fillSetup.invalidCap')}</p>}
        {failure !== null && <Alert variant="problem" className="mt-3"><AlertDescription>{failure}</AlertDescription></Alert>}
      </CardContent>
    </Card>
  );
}
