
/**
 * The fill page (decision 0036, sections 7 and 8): the catalogue's areas and kinds to choose, the server's plan for the
 * selection — which plugin fills which field, which fields the agent fills, the dependency order and an abnormal
 * missing-plugin error — the agent and its token cap when the plan holds the agent, and the press that starts the run.
 * The catalogue's words come from the graph's navigation; the plan comes from `POST /api/fill-plan`.
 */
import { useEffect, useRef, useState, type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, AlertDescription } from './ui/alert.js';
import { Button } from './ui/button.js';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/card.js';
import { Checkbox } from './ui/checkbox.js';
import { Input } from './ui/input.js';
import { Select } from './ui/select.js';
import { Skeleton } from './ui/skeleton.js';
import { FieldLabel, ListItem, Paragraph, PlainList, SmallTitle, Stack, Text, TextLink } from './ui/typography.js';
import {
  readAgentChoices, readAgents, readFillPlan, readFillRuns, readFillStatus, startFillSelection, useChangeStream, useCommandRead,
  type AgentChoicesAnswer, type AgentsAnswer, type FillPlanKind, type FillPlanView, type FillStatusAnswer, type FillRunDetail,
} from './command.js';
import type { Navigation, NavigationKind } from '../client.js';
import { runAddress } from '../address.js';
import type { SectionContext } from './types.js';

interface Area {
  readonly id: string;
  readonly label: string;
  readonly kinds: readonly NavigationKind[];
}

const lower = (text: string, language: string): string => text.toLocaleLowerCase(language);

/** The catalogue's areas in the manifest's own group order, then the kinds of no group. */
function areasOf(navigation: Navigation | null, keep: (kind: NavigationKind) => boolean, language: string, other: string): Area[] {
  const kinds = (navigation?.kinds ?? []).filter(keep);
  const groups = navigation?.groups ?? [];
  const known = new Set(groups.map((group) => group.name));
  const areas: { id: string; label: string; kinds: NavigationKind[] }[] = [];
  for (const group of groups) {
    const held = kinds.filter((kind) => kind.group === group.name);
    if (held.length > 0) areas.push({ id: group.name, label: group.labels[language] ?? group.labels['en'] ?? group.name, kinds: held });
  }
  const loose = kinds.filter((kind) => kind.group === null || !known.has(kind.group));
  if (loose.length > 0) areas.push({ id: '', label: other, kinds: loose });
  return areas;
}

/** What the plan says one kind's fields are filled by: the deterministic plugins, and the fields the agent fills. */
function filledBy(kind: FillPlanKind | undefined): { plugins: string[]; agent: string[] } {
  if (kind === undefined) return { plugins: [], agent: [] };
  const agentFields = new Set(kind.agentFields);
  const plugins: string[] = [];
  for (const field of kind.fields) {
    if (agentFields.has(field.field)) continue;
    for (const producer of field.producers) if (!plugins.includes(producer)) plugins.push(producer);
  }
  return { plugins, agent: [...kind.agentFields] };
}

/** The page's selection and the plan the server answers for it. */
export function FillSection({ context }: { readonly context: SectionContext }): ReactElement {
  const { t, i18n } = useTranslation();
  const language = context.language !== undefined && context.language !== '' ? context.language : (i18n.resolvedLanguage ?? 'en').startsWith('ru') ? 'ru' : 'en';
  const mode = context.section.params['mode'] === 'choose' ? 'choose' : 'run';
  const base = context.base;
  const navigation = context.navigation;
  const catalogue = navigation?.kinds ?? [];
  const [checked, setChecked] = useState<Set<string>>(() => new Set());
  const [search, setSearch] = useState('');
  const [agent, setAgent] = useState<string | null>(null);
  const [cap, setCap] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const chosenSet = useRef(false);
  const selected = [...checked].sort();
  const selectedKey = selected.join(',');
  const allKinds = catalogue.map((kind) => kind.kind).sort();
  const allKey = allKinds.join(',');
  const allRead = useCommandRead<{ plan: FillPlanView }>(`fill-plan-all:${allKey}`, (signal) => readFillPlan(base, allKinds, signal), allKinds.length > 0);
  const planRead = useCommandRead<{ plan: FillPlanView }>(`fill-plan:${selectedKey}`, (signal) => readFillPlan(base, selected, signal), selected.length > 0);
  const agents = useCommandRead<AgentsAnswer>('fill-agents', (signal) => readAgents(base, signal));
  const status = useCommandRead<FillStatusAnswer>('fill-status', (signal) => readFillStatus(base, signal));
  const runs = useCommandRead<{ runs: readonly FillRunDetail[] }>('fill-runs', (signal) => readFillRuns(base, signal));
  useChangeStream(base, () => { status.reload(); runs.reload(); });

  // The product's saved agent is the first choice; a choice the reader makes is never overwritten by a later read.
  useEffect(() => {
    if (chosenSet.current || agents.data === null) return;
    chosenSet.current = true;
    if (agents.data.chosen !== null) setAgent(agents.data.chosen.id);
  }, [agents.data]);

  const allPlan = allRead.data?.plan;
  const selection = selected.length === 0 ? undefined : planRead.data?.plan;
  const planByKind = new Map((allPlan?.kinds ?? []).map((kind) => [kind.kind, kind]));
  const dependencies = new Map<string, string>();
  for (const kind of selection?.selectedKinds ?? []) if (!checked.has(kind)) dependencies.set(kind, '');
  const active = new Set([...checked, ...dependencies.keys()]);
  const needsAgent = selection?.needsAgent ?? [];
  const errors = selection?.errors ?? [];
  const requiresAgent = needsAgent.length > 0;
  const settled = status.data?.fill.state;
  const live = settled === 'running' || settled === 'paused';
  const liveRunId = status.data?.fill.runId;
  const planBusy = allRead.busy || planRead.busy;
  const locked = live || busy || planBusy || mode === 'choose';
  const validCap = cap.trim() === '' || (Number.isSafeInteger(Number(cap)) && Number(cap) > 0);
  const missingAgent = requiresAgent && agent === null;
  const choices = useCommandRead<AgentChoicesAnswer>(`fill-agent-choices:${agent ?? ''}`, (signal) => readAgentChoices(base, agent as string, signal), requiresAgent && agent !== null);
  const kindOf = (kind: string): NavigationKind | undefined => catalogue.find((one) => one.kind === kind);
  const labelOf = (kind: string): string | undefined => kindOf(kind)?.many;

  const toggle = (ids: readonly string[], add: boolean): void => {
    setChecked((current) => {
      const next = new Set(current);
      for (const id of ids) { if (add) next.add(id); else next.delete(id); }
      return next;
    });
    setFailure(null);
  };
  const run = (): void => {
    if (locked || planBusy || checked.size === 0 || !validCap || missingAgent || errors.length > 0) return;
    setBusy(true);
    setFailure(null);
    startFillSelection(base, { selected, agent: requiresAgent ? agent : null, tokenCap: requiresAgent && cap.trim() !== '' ? Number(cap) : null }).then(
      (answer) => { setBusy(false); setChecked(new Set()); context.open(runAddress(answer.runId)); },
      (error: unknown) => { setBusy(false); setFailure(error instanceof Error ? error.message : String(error)); },
    );
  };

  const needle = search.trim();
  const matches = (kind: NavigationKind): boolean => needle === '' || lower(`${kind.one} ${kind.many}`, language).includes(lower(needle, language));
  const areas = areasOf(navigation, matches, language, t('knowledge.fillSetup.other'));

  return (
    <Stack className="grid gap-6" data-testid="fill-setup">
      <Card>
        <CardHeader>
          <CardTitle>{t('knowledge.fillSetup.title')}</CardTitle>
          <CardDescription>{t('knowledge.fillSetup.intro')}</CardDescription>
        </CardHeader>
        <CardContent>
          {allRead.error === null ? null : <Alert variant="problem"><AlertDescription>{allRead.error}</AlertDescription></Alert>}
          {allPlan === undefined && allRead.error === null ? <Skeleton className="h-8 w-72" /> : null}
          {allPlan === undefined ? null : (
            <Stack className="grid gap-4">
              <Stack className="flex flex-wrap items-end gap-3">
                <FieldLabel className="grid min-w-64 flex-1 gap-1 text-small">
                  {t('knowledge.fillSetup.search')}
                  <Input type="search" value={search} onInput={(event) => setSearch(event.currentTarget.value)} placeholder={t('knowledge.fillSetup.search')} aria-label={t('knowledge.fillSetup.search')} data-testid="fill-setup-search" />
                </FieldLabel>
                <Text className="text-small text-muted" data-testid="fill-setup-total">{t('knowledge.catalogueKinds', { count: catalogue.length })}</Text>
              </Stack>
              {areas.length === 0 ? <Paragraph className="text-small text-muted" data-testid="fill-setup-nomatch">{t('knowledge.fillSetup.noMatch')}</Paragraph> : null}
              {areas.map((area) => {
                const activeInArea = area.kinds.filter((kind) => active.has(kind.kind)).length;
                const all = activeInArea === area.kinds.length && area.kinds.length > 0;
                return (
                  <Stack key={area.id === '' ? '\u0000other' : area.id} className="grid gap-2" data-testid="fill-setup-section">
                    <SmallTitle className="flex items-center gap-2 text-small">
                      <Checkbox
                        aria-label={t('knowledge.fillSetup.section', { section: area.label })}
                        checked={all}
                        ref={(input) => { if (input !== null) input.indeterminate = activeInArea > 0 && !all; }}
                        disabled={locked}
                        onChange={() => toggle(area.kinds.filter((kind) => !dependencies.has(kind.kind)).map((kind) => kind.kind), !all)}
                      />
                      {area.label}
                    </SmallTitle>
                    {area.kinds.map((kind) => {
                      const needed = dependencies.has(kind.kind);
                      const planKind = planByKind.get(kind.kind);
                      const filled = filledBy(planKind);
                      const abnormal = errors.find((error) => error.kind === kind.kind);
                      return (
                        <Stack key={kind.kind} className="grid gap-1 text-small">
                          <FieldLabel className="flex items-start gap-2">
                            <Checkbox
                              data-testid={`fill-setup-check-${kind.kind}`}
                              checked={active.has(kind.kind)}
                              disabled={locked || needed}
                              onChange={() => toggle([kind.kind], !checked.has(kind.kind))}
                            />
                            <Text>
                              {kind.many}
                              {needed ? <Text className="block text-muted" data-testid="fill-setup-needed">{t('knowledge.fillSetup.dependency')}</Text> : null}
                            </Text>
                          </FieldLabel>
                          {abnormal === undefined && filled.plugins.length > 0 ? (
                            <Paragraph className="m-0 ml-6 text-small text-muted" data-testid="fill-setup-plugins">{t('knowledge.fillSetup.filledBy', { plugins: filled.plugins.join(', ') })}</Paragraph>
                          ) : null}
                          {abnormal === undefined && filled.agent.length > 0 ? (
                            <Paragraph className="m-0 ml-6 text-small text-muted" data-testid="fill-setup-agent-fields">{t('knowledge.fillSetup.agentFills', { fields: filled.agent.join(', ') })}</Paragraph>
                          ) : null}
                          {abnormal !== undefined && active.has(kind.kind) ? (
                            <Paragraph className="m-0 ml-6 text-small" data-testid="fill-setup-kind-error">{t('knowledge.fillSetup.planError', { kind: kind.many, message: abnormal.plugin === undefined ? abnormal.message : t('knowledge.fillSetup.missingPlugin', { plugin: abnormal.plugin }) })}</Paragraph>
                          ) : null}
                          {abnormal === undefined && filled.plugins.length === 0 && filled.agent.length === 0 ? (
                            <Paragraph className="m-0 ml-6 text-small text-muted" data-testid="fill-setup-no-fields">{t('knowledge.fillSetup.noFields')}</Paragraph>
                          ) : null}
                        </Stack>
                      );
                    })}
                  </Stack>
                );
              })}
            </Stack>
          )}
        </CardContent>
      </Card>

      {selection === undefined ? null : (
        <Card data-testid="fill-setup-order-card">
          <CardHeader><CardTitle>{t('knowledge.fillSetup.order')}</CardTitle></CardHeader>
          <CardContent>
            <PlainList data-testid="fill-setup-order">
              {selection.selectedKinds.map((kind, at) => {
                const label = labelOf(kind);
                if (label === undefined) return null;
                const filled = filledBy(planByKind.get(kind));
                return (
                  <ListItem key={kind} className="mb-1 text-small">
                    {at + 1}. {label}
                    {filled.plugins.length > 0 ? ` · ${filled.plugins.join(', ')}` : ''}
                    {filled.agent.length > 0 ? ` · ${t('knowledge.fillSetup.fieldsAgent')}` : ''}
                    {checked.has(kind) ? null : <Text className="text-muted"> · {t('knowledge.fillSetup.dependency')}</Text>}
                  </ListItem>
                );
              })}
            </PlainList>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardContent>
          {mode === 'run' && live ? (
            <Alert className="mb-3" data-testid="fill-setup-live">
              <AlertDescription>
                {t('knowledge.fillSetup.runActive')}
                {liveRunId === undefined ? null : <> <TextLink href={base + runAddress(liveRunId)} onClick={(event) => { event.preventDefault(); context.open(runAddress(liveRunId)); }}>{t('knowledge.fillSetup.follow')}</TextLink></>}
              </AlertDescription>
            </Alert>
          ) : null}
          <Stack className="flex flex-wrap items-end gap-4">
            {requiresAgent ? (
              <FieldLabel className="grid gap-1 text-small">
                {t('knowledge.fillSetup.agent')}
                <Select
                  data-testid="fill-setup-agent"
                  disabled={locked}
                  value={agent ?? ''}
                  onChange={(event) => { setAgent(event.target.value === '' ? null : event.target.value); setFailure(null); }}
                  options={[{ value: '', label: t('knowledge.fillSetup.chooseAgent') }, ...(agents.data?.agents ?? []).map((offer) => ({ value: offer.id, label: offer.label }))]}
                />
              </FieldLabel>
            ) : null}
            {requiresAgent ? (
              <FieldLabel className="grid gap-1 text-small">
                {t('knowledge.fillSetup.cap')}
                <Input data-testid="fill-setup-cap" type="number" min={1} step={1} value={cap} disabled={locked} aria-invalid={!validCap} onInput={(event) => setCap(event.currentTarget.value)} />
              </FieldLabel>
            ) : null}
            <Paragraph className="m-0 text-small" data-testid="fill-setup-count">{t('knowledge.fillSetup.count', { selected: checked.size, dependencies: dependencies.size })}</Paragraph>
            {mode === 'run' ? (
              <Button variant="default" size="default" data-testid="fill-setup-run" disabled={locked || planBusy || checked.size === 0 || !validCap || missingAgent || errors.length > 0} onClick={run}>
                {t(busy ? 'knowledge.fillSetup.starting' : 'knowledge.fillSetup.run')}
              </Button>
            ) : null}
          </Stack>
          {requiresAgent && choices.data?.choices.model?.current !== null && choices.data?.choices.model?.current !== undefined ? (
            <Paragraph className="mt-2 text-small text-muted" data-testid="fill-setup-model">{t('knowledge.fillSetup.model', { model: choices.data.choices.model.current })}</Paragraph>
          ) : null}
          {requiresAgent && needsAgent.length > 0 ? (
            <Paragraph className="mt-2 text-small text-muted" data-testid="fill-setup-agent-needs">
              {t('knowledge.fillSetup.agentNeeds', { kinds: needsAgent.map((need) => labelOf(need.kind) ?? kindOf(need.kind)?.one ?? '').filter((label) => label !== '').join(', ') })}
            </Paragraph>
          ) : null}
          {missingAgent ? <Paragraph className="mt-2 text-small" data-testid="fill-setup-agent-required">{t('knowledge.fillSetup.chooseAgent')}</Paragraph> : null}
          {!validCap ? <Paragraph role="alert" className="mt-2 text-small">{t('knowledge.fillSetup.invalidCap')}</Paragraph> : null}
          {errors.map((error) => (
            <Alert key={error.kind} variant="problem" className="mt-3" data-testid="fill-setup-plan-error">
              <AlertDescription>{t('knowledge.fillSetup.planError', { kind: labelOf(error.kind) ?? error.kind, message: error.plugin === undefined ? error.message : t('knowledge.fillSetup.missingPlugin', { plugin: error.plugin }) })}</AlertDescription>
            </Alert>
          ))}
          {planRead.error === null ? null : <Alert variant="problem" className="mt-3"><AlertDescription>{planRead.error}</AlertDescription></Alert>}
          {failure === null ? null : <Alert variant="problem" className="mt-3"><AlertDescription>{failure}</AlertDescription></Alert>}
        </CardContent>
      </Card>

      <Card data-testid="fill-history">
        <CardHeader><CardTitle>{t('knowledge.fillRun.history')}</CardTitle></CardHeader>
        <CardContent>
          {runs.error !== null ? <Alert variant="problem"><AlertDescription>{runs.error}</AlertDescription></Alert> : null}
          {runs.data === null && runs.error === null ? <Skeleton className="h-6 w-64" /> : null}
          {runs.data !== null && runs.data.runs.length === 0 ? <Paragraph className="text-small text-muted">{t('knowledge.fillRun.noHistory')}</Paragraph> : null}
          {runs.data === null ? null : (
            <PlainList>
              {runs.data.runs.map((one) => {
                const kinds = (one.order ?? one.selected ?? []).map((kind) => labelOf(kind)).filter((label): label is string => label !== undefined);
                return (
                  <ListItem key={one.runId} className="mb-3" data-testid="fill-history-run">
                    <TextLink href={base + runAddress(one.runId)} onClick={(event) => { event.preventDefault(); context.open(runAddress(one.runId)); }}>
                      {new Date(one.startedAt).toLocaleString(language)}
                    </TextLink>
                    <Paragraph className="m-0 text-small">
                      {t(`knowledge.fillRun.state.${one.state}`, { defaultValue: one.state })}
                      {' · '}
                      {kinds.length === 0 ? t('knowledge.fillRun.selectionUnknown') : kinds.join(', ')}
                    </Paragraph>
                  </ListItem>
                );
              })}
            </PlainList>
          )}
        </CardContent>
      </Card>
    </Stack>
  );
}
