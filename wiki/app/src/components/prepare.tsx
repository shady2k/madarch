
/**
 * The preparation panel (the design change of madarch-64o5.71): the product and its repositories, the final set the server
 * plans, which fields each plugin fills and which the agent fills, the agent and its token cap when the plan holds the
 * agent, and one final press. «Только плагины» plans the deterministic part only and says which fields stay unfilled. The
 * page is separate and full width on a phone; a wide screen keeps it in a reading column.
 */
import { useEffect, useRef, useState, type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, AlertDescription } from './ui/alert.js';
import { Badge } from './ui/badge.js';
import { Button } from './ui/button.js';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card.js';
import { Checkbox } from './ui/checkbox.js';
import { Input } from './ui/input.js';
import { Select } from './ui/select.js';
import { Skeleton } from './ui/skeleton.js';
import { FieldLabel, InlineGroup, ListItem, Paragraph, PlainList, Stack, Text, TextLink } from './ui/typography.js';
import { InlineCode } from './ui/inline-content.js';
import {
  readAgentChoices, readAgents, readFillPlan, readFillStatus, readProduct, startFillSelection, useCommandRead,
  type AgentChoicesAnswer, type AgentsAnswer, type FillPlanNeed, type FillPlanView, type FillStatusAnswer,
} from './command.js';
import { fieldLabel, filledBy, planKindOf } from './plan-words.js';
import { PluginNames } from './plugin-names.js';
import type { Navigation } from '../client.js';
import { catalogueSelectionAddress, runAddress } from '../address.js';
import type { SectionContext } from './types.js';

const labelOf = (navigation: Navigation | null, kind: string): string => navigation?.kinds.find((one) => one.kind === kind)?.many ?? kind;
/** One kind and the fields the agent leaves unfilled when only plugins run. */
function unfilledWords(needs: readonly FillPlanNeed[], navigation: Navigation | null, plan: FillPlanView | undefined, language: string): string {
  return needs.map((need) => `${labelOf(navigation, need.kind)}${need.fields.length === 0 ? '' : ` (${need.fields.map((field) => fieldLabel(plan, need.kind, field, language)).join(', ')})`}`).join(' · ');
}

export function PrepareSection({ context }: { readonly context: SectionContext }): ReactElement {
  const { t, i18n } = useTranslation();
  const language = (context.language !== undefined && context.language !== '' ? context.language : (i18n.resolvedLanguage ?? 'en').startsWith('ru') ? 'ru' : 'en');
  const navigation = context.navigation;
  const base = context.base;
  const requested = (typeof context.variables['kinds'] === 'string' ? context.variables['kinds'] : '').split(',').filter((kind) => kind !== '').sort();
  const wizard = context.variables['wizard'] === '1';
  const [pluginsOnly, setPluginsOnly] = useState(context.variables['pluginsOnly'] === '1');
  const lastVars = useRef(`${String(context.variables['kinds'] ?? '')}\u0000${String(context.variables['pluginsOnly'] ?? '')}`);
  const [agent, setAgent] = useState<string | null>(null);
  const chosen = useRef(false);
  const [cap, setCap] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const key = requested.join(',');
  const planRead = useCommandRead<{ plan: FillPlanView }>(`prepare-plan:${key}:${String(pluginsOnly)}`, (signal) => readFillPlan(base, requested, signal, pluginsOnly), requested.length > 0);
  const agents = useCommandRead<AgentsAnswer>('prepare-agents', (signal) => readAgents(base, signal));
  const product = useCommandRead<{ readonly id: string; readonly name: string; readonly folder?: string }>('prepare-product', (signal) => readProduct(base, signal));
  const status = useCommandRead<FillStatusAnswer>('prepare-status', (signal) => readFillStatus(base, signal));
  const plan = planRead.data?.plan;
  const needsAgent = plan?.needsAgent ?? [];
  const requiresAgent = needsAgent.length > 0;
  const errors = plan?.errors ?? [];
  const skipped = plan?.skipped ?? [];
  const runnable = (plan?.order.length ?? 0) > 0;
  const validCap = cap.trim() === '' || (Number.isSafeInteger(Number(cap)) && Number(cap) > 0);
  const missingAgent = !pluginsOnly && requiresAgent && agent === null;
  const choices = useCommandRead<AgentChoicesAnswer>(`prepare-choices:${agent ?? ''}`, (signal) => readAgentChoices(base, agent as string, signal), !pluginsOnly && requiresAgent && agent !== null);

  useEffect(() => {
    if (chosen.current || agents.data === null) return;
    chosen.current = true;
    if (agents.data.chosen !== null) setAgent(agents.data.chosen.id);
  }, [agents.data]);
  // A link with another selection or mode, or the back button, starts the panel from that address again.
  useEffect(() => {
    const held = `${String(context.variables['kinds'] ?? '')}\u0000${String(context.variables['pluginsOnly'] ?? '')}`;
    if (held !== lastVars.current) {
      lastVars.current = held;
      setPluginsOnly(context.variables['pluginsOnly'] === '1');
    }
  }, [context.variables]);

  const sync = (only: boolean): void => {
    const query = new URLSearchParams({ kinds: key });
    if (only) query.set('pluginsOnly', '1');
    try { window.history.replaceState({}, '', `${base}/p/prepare?${query.toString()}`); } catch { /* no history */ }
  };
  const setOnly = (only: boolean): void => {
    setPluginsOnly(only);
    sync(only);
  };
  // A person with no agent configured gets the plugins-only choice, not a dead press: the plan's agent fields are named
  // as left unfilled, and the run is one press. Choosing an agent or unchecking the box is still theirs.
  const onlyChosen = useRef(false);
  useEffect(() => {
    if (onlyChosen.current || agents.data === null || !requiresAgent) return;
    if (agents.data.chosen === null) {
      onlyChosen.current = true;
      setOnly(true);
    }
  }, [agents.data, requiresAgent]);
  const run = (): void => {
    if (plan === undefined || planRead.busy || errors.length > 0 || missingAgent || !validCap || !runnable) return;
    setBusy(true);
    setFailure(null);
    startFillSelection(base, {
      selected: plan.requestedKinds.length > 0 ? plan.requestedKinds : requested,
      agent: pluginsOnly || !requiresAgent ? null : agent,
      tokenCap: pluginsOnly || !requiresAgent || cap.trim() === '' ? null : Number(cap),
      pluginsOnly,
    }).then(
      (answer) => { setBusy(false); context.open(runAddress(answer.runId)); },
      (error: unknown) => { setBusy(false); setFailure(error instanceof Error ? error.message : String(error)); },
    );
  };

  if (requested.length === 0) return <Alert variant="problem" data-testid="prepare-empty"><AlertDescription>{t('prepare.noKinds')}</AlertDescription></Alert>;
  if (planRead.error !== null) return <Alert variant="problem" data-testid="prepare-error"><AlertDescription>{planRead.error}</AlertDescription></Alert>;
  if (plan === undefined) return <Skeleton className="h-10 w-80" data-testid="prepare-loading" />;

  const added = new Map(plan.added.map((entry) => [entry.kind, entry.neededBy]));
  return (
    <Stack layout="reading" className="grid gap-5" data-testid="prepare-panel">
      {wizard ? <Alert data-testid="prepare-wizard"><AlertDescription>{t('prepare.wizardIntro', { count: plan.selectedKinds.length })}</AlertDescription></Alert> : null}
      <Stack className="flex flex-wrap items-center justify-between gap-3">
        <Paragraph className="m-0 text-secondary">{t('prepare.intro')}</Paragraph>
        <TextLink href={base + catalogueSelectionAddress(plan.requestedKinds.length > 0 ? plan.requestedKinds : requested)} onClick={(event) => { event.preventDefault(); context.open(catalogueSelectionAddress(plan.requestedKinds.length > 0 ? plan.requestedKinds : requested)); }} data-testid="prepare-change">
          {t('prepare.change')}
        </TextLink>
      </Stack>

      <Card data-testid="prepare-product">
        <CardHeader><CardTitle>{t('prepare.product')}</CardTitle></CardHeader>
        <CardContent>
          <InlineGroup className="mb-2"><Text className="font-medium">{status.data?.product?.name ?? navigation?.product ?? t('brand.product')}</Text></InlineGroup>
          <PlainList className="m-0 list-none p-0">
            <ListItem className="flex flex-wrap items-center gap-2 border-b border-line py-1.5" data-testid="prepare-product-repository">
              <Text className="font-medium">{t('prepare.productRepository')}</Text>
              <Text>{product.data?.name ?? status.data?.product?.name ?? navigation?.product ?? ''}</Text>
              {product.data?.folder === undefined ? null : <InlineCode>{product.data.folder}</InlineCode>}
            </ListItem>
            {(status.data?.repositories ?? []).map((repository) => (
              <ListItem key={repository.name} className="flex flex-wrap items-center gap-2 border-b border-line py-1.5 last:border-b-0" data-testid="prepare-repository">
                <Text>{repository.name}</Text>
                <Badge variant={repository.filled ? 'solid' : 'outline'}>{t(repository.filled ? 'prepare.repositoryFilled' : 'prepare.repositoryNotFilled')}</Badge>
              </ListItem>
            ))}
          </PlainList>
          {status.data === null ? <Skeleton className="h-5 w-48" /> : null}
        </CardContent>
      </Card>

      <Card data-testid="prepare-set">
        <CardHeader><CardTitle>{t('prepare.finalSet')}</CardTitle></CardHeader>
        <CardContent>
          <PlainList className="m-0 grid list-none gap-2 p-0">
            {plan.selectedKinds.map((kind, at) => {
              const filled = filledBy(planKindOf(plan, kind));
              const needed = added.get(kind);
              return (
                <ListItem key={kind} className="border-b border-line py-2 last:border-b-0" data-testid="prepare-kind">
                  <Stack className="flex flex-wrap items-baseline gap-x-2">
                    <Text className="font-medium">{at + 1}. {labelOf(navigation, kind)}</Text>
                    {needed === undefined ? null : <Text className="text-small text-muted">· {t('prepare.neededFor', { kind: labelOf(navigation, needed) })}</Text>}
                  </Stack>
                  {filled.plugins.length === 0 ? null : <Paragraph className="m-0 text-small text-muted" data-testid="prepare-plugins">{t('prepare.pluginsLine')} <PluginNames names={filled.plugins} plan={plan} language={language} /></Paragraph>}
                  {filled.agent.length === 0 ? null : <Paragraph className="m-0 text-small text-muted" data-testid="prepare-agent-fields">{t('prepare.agentLine', { fields: filled.agent.map((field) => fieldLabel(plan, kind, field, language)).join(', ') })}</Paragraph>}
                  {filled.plugins.length === 0 && filled.agent.length === 0 ? <Paragraph className="m-0 text-small text-muted">{t('prepare.noFields')}</Paragraph> : null}
                </ListItem>
              );
            })}
          </PlainList>
          {skipped.length === 0 ? null : (
            <Stack className="mt-3 grid gap-2" data-testid="prepare-skipped">
              <Text className="text-small font-medium">{t('prepare.skippedTitle')}</Text>
              <PlainList className="m-0 list-none p-0">
                {skipped.map((entry) => (
                  <ListItem key={`${entry.kind}:${entry.fields.join(',')}`} className="text-small text-muted">
                    {labelOf(navigation, entry.kind)} · {entry.reason === 'no producer in the manifest' ? t('prepare.noProducer') : entry.reason}
                  </ListItem>
                ))}
              </PlainList>
            </Stack>
          )}
        </CardContent>
      </Card>

      <Card data-testid="prepare-controls">
        <CardHeader><CardTitle>{t('prepare.who')}</CardTitle></CardHeader>
        <CardContent>
          <FieldLabel className="mb-3 flex items-start gap-2 text-small">
            <Checkbox checked={pluginsOnly} onChange={() => setOnly(!pluginsOnly)} data-testid="prepare-plugins-only" />
            <Text><Text className="block font-medium">{t('prepare.pluginsOnly')}</Text><Text className="block text-muted">{t('prepare.pluginsOnlyNote')}</Text></Text>
          </FieldLabel>
          {pluginsOnly ? (
            <Alert className="mb-3" data-testid="prepare-unfilled"><AlertDescription>{t('prepare.unfilled', { what: unfilledWords(needsAgent, navigation, plan, language) || t('prepare.nothing') })}</AlertDescription></Alert>
          ) : null}
          {!pluginsOnly && requiresAgent ? (
            <Stack className="flex flex-wrap items-end gap-4">
              <FieldLabel className="grid gap-1 text-small">{t('prepare.agent')}
                <Select data-testid="prepare-agent" value={agent ?? ''} onChange={(event) => setAgent(event.target.value === '' ? null : event.target.value)} options={[{ value: '', label: t('prepare.chooseAgent') }, ...(agents.data?.agents ?? []).map((offer) => ({ value: offer.id, label: offer.label }))]} />
              </FieldLabel>
              <FieldLabel className="grid gap-1 text-small">{t('prepare.cap')}
                <Input data-testid="prepare-cap" type="number" min={1} step={1} value={cap} aria-invalid={!validCap} onInput={(event) => setCap(event.currentTarget.value)} />
              </FieldLabel>
            </Stack>
          ) : null}
          {!pluginsOnly && requiresAgent && choices.data?.choices.model?.current !== null && choices.data?.choices.model?.current !== undefined ? <Paragraph className="mt-2 text-small text-muted">{t('prepare.model', { model: choices.data.choices.model.current })}</Paragraph> : null}
          {!pluginsOnly && requiresAgent ? <Paragraph className="mt-2 text-small text-muted" data-testid="prepare-cap-note">{t('prepare.capNote')}</Paragraph> : null}
          {missingAgent ? <Paragraph className="mt-2 text-small" data-testid="prepare-agent-required">{t('prepare.chooseAgent')}</Paragraph> : null}
          {!validCap ? <Paragraph role="alert" className="mt-2 text-small">{t('prepare.invalidCap')}</Paragraph> : null}
          {errors.map((error) => <Alert key={error.kind} variant="problem" className="mt-3" data-testid="prepare-plan-error"><AlertDescription>{t('prepare.planError', { kind: labelOf(navigation, error.kind), message: error.plugin === undefined ? error.message : t('prepare.missingPlugin', { plugin: error.plugin }) })}</AlertDescription></Alert>)}
          {failure === null ? null : <Alert variant="problem" className="mt-3"><AlertDescription>{failure}</AlertDescription></Alert>}
          <Stack className="mt-4 flex flex-wrap items-center gap-3">
            <Button variant="default" size="default" disabled={busy || planRead.busy || errors.length > 0 || missingAgent || !validCap || !runnable} onClick={run} data-testid="prepare-run">
              {t(busy ? 'prepare.starting' : 'prepare.run')}
            </Button>
            {runnable ? <Text className="text-small text-muted">{t('prepare.onePress')}</Text> : <Text className="text-small text-muted" data-testid="prepare-nothing">{t('prepare.nothingToRun')}</Text>}
          </Stack>
        </CardContent>
      </Card>
    </Stack>
  );
}
