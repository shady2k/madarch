
/**
 * The fill page (decision 0036, sections 7 and 8): the catalogue's areas and kinds to choose, the dependency order and
 * the fields of a plan, the agent and its token cap when the plan holds the agent, and the press that starts the run.
 * Everything it shows is the server's plan (`/api/fill-plan`) and its agents (`/api/agents`); the page computes no plan.
 */
import { useEffect, useRef, useState, type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, AlertDescription } from './ui/alert.js';
import { Badge } from './ui/badge.js';
import { Button } from './ui/button.js';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/card.js';
import { Checkbox } from './ui/checkbox.js';
import { Input } from './ui/input.js';
import { Select } from './ui/select.js';
import { Skeleton } from './ui/skeleton.js';
import { FieldLabel, ListItem, Paragraph, PlainList, SmallTitle, Stack, Text, TextLink } from './ui/typography.js';
import {
  readAgentChoices, readAgents, readFillPlan, readFillRuns, readFillStatus, startFillSelection, useChangeStream, useCommandRead,
  type AgentChoicesAnswer, type AgentsAnswer, type FillPlanAnswer, type FillPlanKind, type FillRunDetail, type FillStatusAnswer,
} from './command.js';
import { runAddress } from '../address.js';
import type { SectionContext } from './types.js';

/** The area one kind stands in, for the page's sections. */
interface Area {
  readonly id: string;
  readonly label: string;
  readonly kinds: readonly FillPlanKind[];
}

/** The areas of a plan in the order the plan lists their first kind. */
function areasOf(catalogue: readonly FillPlanKind[], keep: (kind: FillPlanKind) => boolean): Area[] {
  const areas: { id: string; label: string; kinds: FillPlanKind[] }[] = [];
  for (const kind of catalogue) {
    if (!keep(kind)) continue;
    const id = kind.group?.name ?? '';
    const label = kind.group?.label ?? '';
    let area = areas.find((one) => one.id === id);
    if (area === undefined) { area = { id, label, kinds: [] }; areas.push(area); }
    area.kinds.push(kind);
  }
  return areas;
}

const lower = (text: string, language: string): string => text.toLocaleLowerCase(language);

/** The page's selection and the plan the server answers for it. */
export function FillSection({ context }: { readonly context: SectionContext }): ReactElement {
  const { t, i18n } = useTranslation();
  const language = context.language !== undefined && context.language !== '' ? context.language : (i18n.resolvedLanguage ?? 'en').startsWith('ru') ? 'ru' : 'en';
  const mode = context.section.params['mode'] === 'choose' ? 'choose' : 'run';
  const base = context.base;
  const [checked, setChecked] = useState<Set<string>>(() => new Set());
  const [search, setSearch] = useState('');
  const [agent, setAgent] = useState<string | null>(null);
  const [cap, setCap] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const chosenSet = useRef(false);
  const selected = [...checked].sort();
  const selectedKey = selected.join(',');
  const plan = useCommandRead<FillPlanAnswer>(`fill-plan:${language}:${selectedKey}`, (signal) => readFillPlan(base, language, selected, signal));
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

  const fromPlan = plan.data;
  const catalogue = fromPlan?.catalogue ?? [];
  const dependencies = new Map<string, string>();
  for (const kind of fromPlan?.kinds ?? []) if (kind.reason === 'dependency' && kind.namedBy !== undefined) dependencies.set(kind.kind, kind.namedBy);
  const active = new Set([...checked, ...dependencies.keys()]);
  const requiresAgent = fromPlan?.requiresAgent === true;
  const unproduced = fromPlan?.unproduced ?? [];
  const refusal = fromPlan?.refusal ?? null;
  const settled = status.data?.fill.state;
  const live = settled === 'running' || settled === 'paused';
  const liveRunId = status.data?.fill.runId;
  const locked = live || busy || plan.busy || mode === 'choose';
  const validCap = cap.trim() === '' || (Number.isSafeInteger(Number(cap)) && Number(cap) > 0);
  const missingAgent = requiresAgent && agent === null;
  const choices = useCommandRead<AgentChoicesAnswer>(`fill-agent-choices:${agent ?? ''}`, (signal) => readAgentChoices(base, agent as string, signal), requiresAgent && agent !== null);
  // Every known kind's label, so a dependency and a past run name their kinds the catalogue's way and never by id.
  const labelOf = (kind: string): string | undefined => catalogue.find((one) => one.kind === kind)?.labels.many;

  const toggle = (ids: readonly string[], add: boolean): void => {
    setChecked((held) => {
      const next = new Set(held);
      for (const id of ids) { if (add) next.add(id); else next.delete(id); }
      return next;
    });
    setFailure(null);
  };
  const run = (): void => {
    if (locked || plan.busy || checked.size === 0 || !validCap || missingAgent || refusal !== null || unproduced.length > 0) return;
    setBusy(true);
    setFailure(null);
    startFillSelection(base, { selected, agent: requiresAgent ? agent : null, tokenCap: requiresAgent && cap.trim() !== '' ? Number(cap) : null }).then(
      (answer) => { setBusy(false); setChecked(new Set()); context.open(runAddress(answer.runId)); },
      (error: unknown) => { setBusy(false); setFailure(error instanceof Error ? error.message : String(error)); },
    );
  };

  const needle = search.trim();
  const matches = (kind: FillPlanKind): boolean => needle === '' || lower(`${kind.labels.one} ${kind.labels.many}`, language).includes(lower(needle, language));
  const areas = areasOf(catalogue, matches);

  return (
    <Stack className="grid gap-6" data-testid="fill-setup">
      <Card>
        <CardHeader>
          <CardTitle>{t('knowledge.fillSetup.title')}</CardTitle>
          <CardDescription>{t('knowledge.fillSetup.intro')}</CardDescription>
        </CardHeader>
        <CardContent>
          {plan.error !== null ? <Alert variant="problem"><AlertDescription>{plan.error}</AlertDescription></Alert> : null}
          {plan.data === null && plan.error === null ? <Skeleton className="h-8 w-72" /> : null}
          {fromPlan === null ? null : (
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
                        aria-label={t('knowledge.fillSetup.section', { section: area.label === '' ? t('knowledge.fillSetup.other') : area.label })}
                        checked={all}
                        ref={(input) => { if (input !== null) input.indeterminate = activeInArea > 0 && !all; }}
                        disabled={locked}
                        onChange={() => toggle(area.kinds.filter((kind) => !dependencies.has(kind.kind)).map((kind) => kind.kind), !all)}
                      />
                      {area.label === '' ? t('knowledge.fillSetup.other') : area.label}
                    </SmallTitle>
                    {area.kinds.map((kind) => {
                      const needed = dependencies.get(kind.kind);
                      const neededLabel = needed === undefined ? undefined : labelOf(needed);
                      return (
                        <Stack key={kind.kind} className="grid gap-1 text-small">
                          <FieldLabel className="flex items-start gap-2">
                            <Checkbox
                              data-testid={`fill-setup-check-${kind.kind}`}
                              checked={active.has(kind.kind)}
                              disabled={locked || needed !== undefined}
                              onChange={() => toggle([kind.kind], !checked.has(kind.kind))}
                            />
                            <Text>
                              {kind.labels.many}
                              {kind.agent ? <> <Badge variant="outline">{t('knowledge.fillSetup.agent')}</Badge></> : null}
                              {neededLabel === undefined ? null : <Text className="block text-muted" data-testid="fill-setup-needed">{t('knowledge.fillSetup.neededBy', { kind: neededLabel })}</Text>}
                            </Text>
                          </FieldLabel>
                          <Paragraph className="m-0 text-small text-muted" data-testid="fill-setup-plugins">
                            {kind.plugins.join(', ') || t('knowledge.catalogueNoPlugin')}
                          </Paragraph>
                          {kind.fields.some((field) => field.plugins.length > 0 || field.agent) ? (
                            <Paragraph className="m-0 text-small text-muted" data-testid="fill-setup-fields">
                              {t('knowledge.fillSetup.fields')}: {kind.fields.filter((field) => field.plugins.length > 0 || field.agent).map((field) => `${field.field} — ${field.agent ? t('knowledge.fillSetup.fieldsAgent') : field.plugins.join(', ')}`).join(' · ')}
                            </Paragraph>
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

      {checked.size === 0 || fromPlan === null ? null : (
        <Card data-testid="fill-setup-order-card">
          <CardHeader><CardTitle>{t('knowledge.fillSetup.order')}</CardTitle></CardHeader>
          <CardContent>
            <PlainList data-testid="fill-setup-order">
              {fromPlan.kinds.map((kind, at) => (
                <ListItem key={kind.kind} className="mb-1 text-small">
                  {at + 1}. {kind.labels.many} · {kind.plugins.join(', ') || t('knowledge.catalogueNoPlugin')}
                  {kind.reason === 'dependency' ? <Text className="text-muted"> · {t('knowledge.fillSetup.dependency')}</Text> : null}
                </ListItem>
              ))}
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
              <Button variant="default" size="default" data-testid="fill-setup-run" disabled={locked || plan.busy || checked.size === 0 || !validCap || missingAgent || refusal !== null || unproduced.length > 0} onClick={run}>
                {t(busy ? 'knowledge.fillSetup.starting' : 'knowledge.fillSetup.run')}
              </Button>
            ) : null}
          </Stack>
          {requiresAgent && choices.data?.choices.model?.current !== null && choices.data?.choices.model?.current !== undefined ? (
            <Paragraph className="mt-2 text-small text-muted" data-testid="fill-setup-model">{t('knowledge.fillSetup.model', { model: choices.data.choices.model.current })}</Paragraph>
          ) : null}
          {missingAgent ? <Paragraph className="mt-2 text-small" data-testid="fill-setup-agent-required">{t('knowledge.fillSetup.chooseAgent')}</Paragraph> : null}
          {!validCap ? <Paragraph role="alert" className="mt-2 text-small">{t('knowledge.fillSetup.invalidCap')}</Paragraph> : null}
          {unproduced.length === 0 ? null : <Paragraph className="mt-2 text-small" data-testid="fill-setup-unproduced">{t('knowledge.fillSetup.unproduced', { kinds: unproduced.map((kind) => labelOf(kind) ?? t('knowledge.fillRun.selectionUnknown')).join(', ') })}</Paragraph>}
          {refusal === null ? null : <Alert variant="problem" className="mt-3"><AlertDescription>{refusal}</AlertDescription></Alert>}
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
