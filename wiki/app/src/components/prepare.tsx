
/**
 * The preparation panel (the design change of madarch-64o5.71): the product and its repositories, the final set the server
 * plans, which fields each plugin fills and which the agent fills, who fills the set and the token cap when the plan holds
 * the agent, and one final press. «Кто заполнит» shows every installed agent beside «Только плагины» as one choice
 * (madarch-64o5.90): the product's saved agent stands until the person picks another, else plugins-only, which plans the
 * deterministic part only and says which fields stay unfilled. The page is separate and full width on a phone; a wide
 * screen keeps it in a reading column.
 */
import { useEffect, useRef, useState, type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, AlertDescription } from './ui/alert.js';
import { Badge } from './ui/badge.js';
import { Button } from './ui/button.js';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card.js';
import { ChoiceCard } from './ui/choice-card.js';
import { Disclosure, DisclosureSummary } from './ui/disclosure.js';
import { Input } from './ui/input.js';
import { RadioGroup, RadioGroupItem } from './ui/radio-group.js';
import { Select } from './ui/select.js';
import { Skeleton } from './ui/skeleton.js';
import { FieldLabel, InlineGroup, ListItem, Paragraph, PlainList, Stack, Text, TextLink } from './ui/typography.js';
import { InlineCode } from './ui/inline-content.js';
import { agentUsable } from './agent-words.js';
import {
  chooseAgent, CommandError, readAgentChoices, readAgents, readFillPlan, readFillStatus, readProduct, readProductSettings, saveProductSettings, startFillSelection, useCommandRead,
  type AgentChoicesAnswer, type AgentsAnswer, type FillPlanView, type FillStatusAnswer, type ProductSettingsAnswer,
} from './command.js';
import { fieldLabel, filledBy, planKindOf } from './plan-words.js';
import { fillEstimate } from './prepare-estimate.js';
import { PluginNames } from './plugin-names.js';
import type { Navigation } from '../client.js';
import { catalogueSelectionAddress, PAGE_ADDRESSES, runAddress } from '../address.js';
import type { SectionContext } from './types.js';

const PLUGINS_ONLY = 'plugins-only';
const labelOf = (navigation: Navigation | null, kind: string): string => navigation?.kinds.find((one) => one.kind === kind)?.many ?? kind;
export function PrepareSection({ context }: { readonly context: SectionContext }): ReactElement {
  const { t, i18n } = useTranslation();
  const language = (context.language !== undefined && context.language !== '' ? context.language : (i18n.resolvedLanguage ?? 'en').startsWith('ru') ? 'ru' : 'en');
  const navigation = context.navigation;
  const base = context.base;
  const requested = (typeof context.variables['kinds'] === 'string' ? context.variables['kinds'] : '').split(',').filter((kind) => kind !== '').sort();
  const wizard = context.variables['wizard'] === '1';
  // «Кто заполнит» is one radio choice: an installed agent, or «Только плагины». Until the person picks, the product's
  // saved agent stands, else plugins-only: the agents are always visible, and no agent spend happens without a pick.
  const [picked, setPicked] = useState<string | null>(null);
  const lastVars = useRef(`${String(context.variables['kinds'] ?? '')}\u0000${String(context.variables['pluginsOnly'] ?? '')}`);
  // The token cap as typed: `null` until the person changes the product's default, which the field offers.
  const [cap, setCap] = useState<string | null>(null);
  // The model and reasoning level this run asks of its agent (madarch-64o5.90): `null` until the person picks one.
  const [model, setModel] = useState<string | null>(null);
  const [reasoning, setReasoning] = useState<string | null>(null);
  const [savedDefaults, setSavedDefaults] = useState<'idle' | 'saving' | 'saved' | 'failed'>('idle');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const key = requested.join(',');
  const agents = useCommandRead<AgentsAnswer>('prepare-agents', (signal) => readAgents(base, signal));
  const savedWho = agents.data?.chosen?.id ?? null;
  const who = picked ?? (context.variables['pluginsOnly'] === '1' ? PLUGINS_ONLY : savedWho ?? PLUGINS_ONLY);
  const pluginsOnly = who === PLUGINS_ONLY;
  const agent = pluginsOnly ? null : who;
  const planRead = useCommandRead<{ plan: FillPlanView }>(`prepare-plan:${key}:${String(pluginsOnly)}`, (signal) => readFillPlan(base, requested, signal, pluginsOnly), requested.length > 0);
  const product = useCommandRead<{ readonly id: string; readonly name: string; readonly folder?: string }>('prepare-product', (signal) => readProduct(base, signal));
  const status = useCommandRead<FillStatusAnswer>('prepare-status', (signal) => readFillStatus(base, signal));
  const settings = useCommandRead<ProductSettingsAnswer>('prepare-settings', (signal) => readProductSettings(base, signal));
  const plan = planRead.data?.plan;
  const needsAgent = plan?.needsAgent ?? [];
  const requiresAgent = needsAgent.length > 0;
  const errors = plan?.errors ?? [];
  const skipped = plan?.skipped ?? [];
  const emptyFields = needsAgent.reduce((total, need) => total + need.fields.length, 0);
  const runnable = (plan?.order.length ?? 0) > 0;
  // The product's default cap fills the field until the person types another (madarch-64o5.90): an empty field is the
  // default, never a refusal, and a typed cap is this run's alone.
  const defaultCap = settings.data?.tokenCap ?? null;
  const capText = cap ?? (defaultCap === null ? '' : String(defaultCap));
  const capNumber = capText.trim() === '' ? null : Number(capText);
  const capInvalid = capText.trim() !== '' && !(capNumber !== null && Number.isSafeInteger(capNumber) && capNumber > 0);
  const validCap = !capInvalid;
  const pickedOffer = agents.data?.agents.find((offer) => offer.id === agent) ?? null;
  const choices = useCommandRead<AgentChoicesAnswer>(`prepare-choices:${agent ?? ''}`, (signal) => readAgentChoices(base, agent as string, signal), !pluginsOnly && requiresAgent && agent !== null && pickedOffer !== null && agentUsable(pickedOffer));
  // The product's saved model stands for the agent it was chosen for; another agent starts from what it reports.
  const savedPair = settings.data?.chosenAgent != null && settings.data.chosenAgent.id === agent ? settings.data.chosenAgent : null;
  const modelChoice = choices.data?.choices.model ?? null;
  const reasoningChoice = choices.data?.choices.reasoning ?? null;
  const modelValue = model ?? savedPair?.model ?? modelChoice?.current ?? '';
  const reasoningValue = reasoning ?? savedPair?.reasoning ?? reasoningChoice?.current ?? '';

  // A link with another selection or mode, or the back button, starts the panel from that address again.
  useEffect(() => {
    const held = `${String(context.variables['kinds'] ?? '')}\u0000${String(context.variables['pluginsOnly'] ?? '')}`;
    if (held !== lastVars.current) {
      lastVars.current = held;
      setPicked(null);
    }
  }, [context.variables]);

  const sync = (only: boolean): void => {
    const query = new URLSearchParams({ kinds: key });
    if (only) query.set('pluginsOnly', '1');
    try { window.history.replaceState({}, '', `${base}/p/prepare?${query.toString()}`); } catch { /* no history */ }
  };
  const choose = (next: string): void => {
    setPicked(next);
    // Another agent reports its own models, so a pair picked for one agent is not carried to another.
    setModel(null);
    setReasoning(null);
    setSavedDefaults('idle');
    sync(next === PLUGINS_ONLY);
  };
  // «Сохранить по умолчанию»: the picked agent becomes the product's, with the model and reasoning level beside it.
  const saveDefaults = (): void => {
    if (agent === null) return;
    setSavedDefaults('saving');
    setFailure(null);
    const remember = settings.data?.chosenAgent?.id === agent ? Promise.resolve() : chooseAgent(base, agent, true);
    remember.then(() => saveProductSettings(base, { model: modelValue === '' ? null : modelValue, reasoning: reasoningValue === '' ? null : reasoningValue }))
      .then(() => { setSavedDefaults('saved'); settings.reload(); }, (error: unknown) => { setSavedDefaults('failed'); setFailure(error instanceof Error ? error.message : String(error)); });
  };
  const run = (): void => {
    if (plan === undefined || planRead.busy || errors.length > 0 || !validCap || !runnable) return;
    setBusy(true);
    setFailure(null);
    startFillSelection(base, {
      selected: plan.requestedKinds.length > 0 ? plan.requestedKinds : requested,
      agent: pluginsOnly || !requiresAgent ? null : agent,
      model: pluginsOnly || !requiresAgent || modelValue === '' ? null : modelValue,
      reasoning: pluginsOnly || !requiresAgent || reasoningValue === '' ? null : reasoningValue,
      tokenCap: pluginsOnly || !requiresAgent ? null : capNumber,
      pluginsOnly,
    }).then(
      (answer) => { setBusy(false); context.open(runAddress(answer.runId)); },
      (error: unknown) => {
        setBusy(false);
        const code = error instanceof CommandError ? error.code : undefined;
        setFailure(code === 'fill/agent-required' ? t('prepare.agentRequired') : code === 'fill/token-cap' ? t('prepare.capRequired') : error instanceof Error ? error.message : String(error));
      },
    );
  };

  if (requested.length === 0) return <Alert variant="problem" data-testid="prepare-empty"><AlertDescription>{t('prepare.noKinds')}</AlertDescription></Alert>;
  if (planRead.error !== null) return <Alert variant="problem" data-testid="prepare-error"><AlertDescription>{planRead.error}</AlertDescription></Alert>;
  if (plan === undefined) return <Skeleton className="h-10 w-80" data-testid="prepare-loading" />;

  const added = new Map(plan.added.map((entry) => [entry.kind, entry.neededBy]));
  // The estimate beside the press: time, and the most the run may spend when it runs an agent.
  const minutes = fillEstimate(plan.units.length, requiresAgent && !pluginsOnly ? needsAgent.length : 0);
  const spendCap = capNumber ?? defaultCap;
  const estimate = !pluginsOnly && requiresAgent && spendCap !== null
    ? t('prepare.estimate', { minutes, tokens: new Intl.NumberFormat(language).format(spendCap) })
    : t('prepare.estimateTime', { minutes });
  return (
    <Stack layout="reading" className="grid gap-5" data-testid="prepare-panel">
      {wizard ? <Alert data-testid="prepare-wizard"><AlertDescription>{t('prepare.wizardIntro')}</AlertDescription></Alert> : null}
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
          {agents.data === null && agents.error === null ? <Skeleton className="h-16 w-full" data-testid="prepare-agents-loading" /> : null}
          {agents.error === null ? null : <Paragraph role="alert" className="mt-0 text-small" data-testid="prepare-agents-error">{agents.error}</Paragraph>}
          {agents.data === null ? null : (
            <RadioGroup value={who} onValueChange={choose} aria-label={t('prepare.who')} className="mb-3" data-testid="prepare-who">
              {agents.data.agents.map((offer) => (
                <ChoiceCard key={offer.id} data-testid={`prepare-agent-${offer.id}`} data-chosen={agent === offer.id ? 'true' : 'false'} data-available={agentUsable(offer) ? 'true' : 'false'}>
                  <RadioGroupItem value={offer.id} aria-label={offer.label} disabled={!agentUsable(offer)} />
                  <Text className="min-w-0 flex-1 text-small">
                    <Text className="block font-medium">{offer.label}</Text>
                    <Text className="block text-muted" data-testid={`prepare-agent-state-${offer.id}`}>
                    {!offer.installed ? (
                      <>{t('prepare.agentNotInstalled')} <TextLink href={PAGE_ADDRESSES.settings} onClick={(event) => { event.preventDefault(); context.open(PAGE_ADDRESSES.settings); }} data-testid={`prepare-agent-install-${offer.id}`}>{t('prepare.agentInstall')}</TextLink></>
                    ) : offer.login === 'signed-in' ? t('prepare.agentSignedIn') : offer.login === 'not-signed-in' ? t('prepare.agentNotSignedIn', { agent: offer.label }) : null}
                  </Text>
                  </Text>
                </ChoiceCard>
              ))}
              <ChoiceCard data-testid="prepare-plugins-only-choice" data-chosen={pluginsOnly ? 'true' : 'false'}>
                <RadioGroupItem value={PLUGINS_ONLY} aria-label={t('prepare.pluginsOnly')} data-testid="prepare-plugins-only" />
                <Text className="min-w-0 flex-1 text-small">
                  <Text className="block font-medium">{t('prepare.pluginsOnly')}</Text>
                  <Text className="block text-muted">{t('prepare.pluginsOnlyNote')}</Text>
                </Text>
              </ChoiceCard>
            </RadioGroup>
          )}
          {pluginsOnly && needsAgent.length > 0 ? (
            <Disclosure className="mb-3" data-testid="prepare-unfilled">
              <DisclosureSummary className="cursor-pointer text-small text-muted" data-testid="prepare-unfilled-summary">
                {t('prepare.unfilledSummary', { fields: t('prepare.fieldsN', { count: emptyFields }), kinds: t('prepare.kindsN', { count: needsAgent.length }) })}
              </DisclosureSummary>
              <PlainList className="m-0 mt-2 list-none p-0">
                {needsAgent.map((need) => (
                  <ListItem key={need.kind} className="text-small text-muted" data-testid="prepare-unfilled-kind">
                    {t('prepare.unfilledKind', { kind: labelOf(navigation, need.kind), fields: need.fields.map((field) => fieldLabel(plan, need.kind, field, language)).join(', ') })}
                  </ListItem>
                ))}
              </PlainList>
            </Disclosure>
          ) : null}
          {!pluginsOnly && requiresAgent ? (
            <Stack className="flex flex-wrap items-end gap-4">
              {modelChoice === null ? null : (
                <FieldLabel className="grid gap-1 text-small">{t('prepare.modelChoice')}
                  <Select data-testid="prepare-model" value={modelValue} onChange={(event) => { setModel(event.target.value); setSavedDefaults('idle'); }} options={modelChoice.values.map((entry) => ({ value: entry.value, label: entry.name }))} />
                </FieldLabel>
              )}
              {reasoningChoice === null ? null : (
                <FieldLabel className="grid gap-1 text-small">{t('prepare.reasoningChoice')}
                  <Select data-testid="prepare-reasoning" value={reasoningValue} onChange={(event) => { setReasoning(event.target.value); setSavedDefaults('idle'); }} options={reasoningChoice.values.map((entry) => ({ value: entry.value, label: entry.name }))} />
                </FieldLabel>
              )}
              <FieldLabel className="grid gap-1 text-small">{t('prepare.cap')}
                <Input data-testid="prepare-cap" type="number" min={1} step={1} value={capText} aria-invalid={!validCap} onInput={(event) => setCap(event.currentTarget.value)} />
              </FieldLabel>
              {modelChoice === null && reasoningChoice === null ? null : (
                <Button variant="default" size="default" disabled={savedDefaults === 'saving'} onClick={saveDefaults} data-testid="prepare-save-defaults">{t(savedDefaults === 'saved' ? 'prepare.savedDefaults' : 'prepare.saveDefaults')}</Button>
              )}
            </Stack>
          ) : null}
          {!pluginsOnly && requiresAgent ? <Paragraph className="mt-2 text-small text-muted" data-testid="prepare-cap-note">{t('prepare.capNote')}</Paragraph> : null}
          {!pluginsOnly && requiresAgent && capNumber === null && defaultCap !== null ? <Paragraph className="mt-1 text-small text-muted" data-testid="prepare-cap-default">{t('prepare.capDefault', { cap: new Intl.NumberFormat(language).format(defaultCap) })}</Paragraph> : null}
          {capInvalid ? <Paragraph role="alert" className="mt-2 text-small" data-testid="prepare-invalid-cap">{t('prepare.invalidCap')}</Paragraph> : null}
          {errors.map((error) => <Alert key={error.kind} variant="problem" className="mt-3" data-testid="prepare-plan-error"><AlertDescription>{t('prepare.planError', { kind: labelOf(navigation, error.kind), message: error.plugin === undefined ? error.message : t('prepare.missingPlugin', { plugin: error.plugin }) })}</AlertDescription></Alert>)}
          {failure === null ? null : <Alert variant="problem" className="mt-3"><AlertDescription>{failure}</AlertDescription></Alert>}
          <Stack className="mt-4 flex flex-wrap items-center gap-3">
            <Button variant="default" size="default" disabled={busy || planRead.busy || errors.length > 0 || !validCap || !runnable} onClick={run} data-testid="prepare-run">
              {t(busy ? 'prepare.starting' : 'prepare.run')}
            </Button>
            {runnable ? <Text className="text-small text-muted" data-testid="prepare-estimate">{estimate}</Text> : <Text className="text-small text-muted" data-testid="prepare-nothing">{t('prepare.nothingToRun')}</Text>}
          </Stack>
        </CardContent>
      </Card>
    </Stack>
  );
}
