
/**
 * The run page (decision 0036, sections 7 and 8): one fill run's progress per kind and plugin, its result, the reader's
 * pause and stop, and a log written for a person — no engine trace, no machine path and no internal id. The run is the
 * server's durable state (`/api/fill-runs?run=<id>`); the page follows it through `/api/events` and a one-second tick
 * while the run is live.
 */
import { useEffect, useState, type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { Alert, AlertDescription, AlertTitle } from './ui/alert.js';
import { Badge } from './ui/badge.js';
import { Button } from './ui/button.js';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card.js';
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog.js';
import { Disclosure, DisclosureSummary } from './ui/disclosure.js';
import { Progress } from './ui/progress.js';
import { Skeleton } from './ui/skeleton.js';
import { ListItem, Metadata, Paragraph, PlainList, Stack, Text, TextLink } from './ui/typography.js';
import { TechnicalText } from './ui/technical-text.js';
import {
  isOffline, pauseFillRun, readFillPlan, readFillRun, stopFillRun, useChangeStream, useCommandRead,
  type FillPlanView, type FillRunDetail, type FillRunGroup,
} from './command.js';
import { logsAddress, RUNS_PAGE } from '../address.js';
import { InlineCode } from './ui/inline-content.js';
import { OfflineAction } from './ui/offline-action.js';
import { useConnection } from '../connection.js';
import type { SectionContext } from './types.js';

const LIVE = ['queued', 'running', 'paused'];
const STOPPABLE = ['queued', 'running', 'paused'];

/** The words a run's own event kinds take; the events' trace text is never shown. */
const EVENT_WORDS: Readonly<Record<string, string>> = {
  'run-planned': 'planned',
  'run-started': 'started',
  'run-paused': 'paused',
  'run-resumed': 'resumed',
  'run-cancelling': 'cancelling',
  'run-cancelled': 'cancelled',
  'run-completed': 'completed',
  'run-completed-partial': 'partial',
  'run-failed': 'failed',
  'run-blocked': 'blocked',
  'stage-planned': 'stagePlanned',
  'stage-found-nothing': 'foundNothing',
  'unit-published': 'unitPublished',
  'unit-failed': 'unitFailed',
  'unit-blocked': 'unitBlocked',
  'unit-retried': 'unitRetried',
  'unit-planned': 'unitPlanned',
  'unit-skipped': 'unitSkipped',
};

/** The classes of failure the run journal can name, each with the next thing a person does about it. */
export type RunCause = 'sandbox' | 'plugin' | 'agent' | 'cap' | 'dependency' | 'timeout' | 'unknown';

/** What a failure's own words say about its cause: the classes the run journal names, never the raw summary. */
export function runCauseOf(summary: string): RunCause {
  const folded = [...summary].map((character) => character === 'ſ' ? 's' : character === 'K' ? 'k'
    : character >= 'A' && character <= 'Z' ? character.toLowerCase() : character).join('');
  if (['cgroup', 'subtree_control', 'madarch_plugin_sandbox', 'sandbox'].some((word) => folded.includes(word))) return 'sandbox';
  if (["plugin is pinned", 'closure', 'hashes to', "needs a person's approval", 'plugin'].some((word) => folded.includes(word))) return 'plugin';
  if (['token cap', 'token bound', 'tokens'].some((word) => folded.includes(word))) return 'cap';
  if (['agent', 'acp', 'auth', 'sign in', 'adapter'].some((word) => folded.includes(word))) return 'agent';
  if (['wait for a dependency', 'waits for a dependency', 'dependency', 'blocked'].some((word) => folded.includes(word))) return 'dependency';
  if (['deadline', 'timed out', 'timeout', 'heartbeat'].some((word) => folded.includes(word))) return 'timeout';
  return 'unknown';
}

/** The first failure the run recorded, as the cause the page names above its result. */
function failureCauseOf(run: FillRunDetail): RunCause | undefined {
  for (const event of run.events) {
    if (event.type !== 'unit-failed' && event.type !== 'unit-retried' && event.type !== 'unit-blocked' && event.type !== 'run-failed' && event.type !== 'run-blocked') continue;
    return runCauseOf(event.summary);
  }
  return undefined;
}

/** The group a run event belongs to: the unit's own id ends its stage's path (`plugin-turns/disk:code.file`). */
function groupOf(groups: readonly FillRunGroup[], text: string): FillRunGroup | undefined {
  const unit = text.slice(text.lastIndexOf('/') + 1);
  return groups.find((group) => {
    const prefix = `${group.plugin}:${group.kind}`;
    return unit === prefix || unit.startsWith(`${prefix}@`) || unit.startsWith(`${prefix}/`);
  });
}

/**
 * The kind and the plugin a run event names: its group's when the run recorded one, and else the unit id's own parts —
 * a unit is `<plugin>:<kind>` behind its stage's path, with `@<vertex>` or `#<hash>` after it. A run pressed outside the
 * page records no groups, and its failures still say which kind and which plugin they are about.
 */
function unitPartsOf(groups: readonly FillRunGroup[], text: string): { readonly kind: string; readonly plugin: string } | undefined {
  const group = groupOf(groups, text);
  if (group !== undefined) return { kind: group.kind, plugin: group.plugin };
  const unit = text.slice(text.lastIndexOf('/') + 1);
  const colon = unit.indexOf(':');
  if (colon <= 0) return undefined;
  const kind = (unit.slice(colon + 1).split('@')[0] ?? '').split('#')[0] ?? '';
  return kind === '' ? undefined : { kind, plugin: unit.slice(0, colon) };
}

function seconds(value: number): number {
  return Math.max(0, Math.round(value / 1000));
}

/**
 * What one group of a kind and a plugin came to, in entities (madarch-64o5.106): the run page counts what the producer
 * created and changed, never the engine's own work units. The producer's own answer supplies the cause when it wrote
 * nothing, and the agent's exchange says what it opened when it stated no reason of its own.
 */
export interface GroupResult {
  readonly created: number;
  readonly updated: number;
  /** Whether the plugin runs an agent, as the plan declares it. */
  readonly agent: boolean;
  /** The group's own phase: done, failed, skipped, cancelled, waiting or running. */
  readonly phase: string;
  /** The producer's own stated reason, when it stated one. */
  readonly reason?: string;
  /** The producer's own answer: completed, unchanged, empty, inapplicable, abstained or failed. */
  readonly outcome?: string;
  /** What the group's agent opened, how many files it was handed, and how many tool calls it made. */
  readonly opened?: number;
  readonly files?: number;
  readonly calls?: number;
}

export function groupResultOf(run: FillRunDetail, group: FillRunGroup, agentOf: (plugin: string) => boolean): GroupResult {
  const counted = (run.entities ?? []).find((one) => one.plugin === group.plugin && one.kind === group.kind);
  const outcomes = (run.outcomes ?? []).filter((one) => one.plugin === group.plugin && one.kind === group.kind);
  const exchange = (run.agentExchanges ?? []).find((one) => one.unit === `${group.plugin}:${group.kind}` || one.unit.startsWith(`${group.plugin}:${group.kind}@`) || one.unit.startsWith(`${group.plugin}:${group.kind}#`));
  const reason = outcomes.find((one) => one.reason !== undefined)?.reason;
  return {
    created: counted?.created ?? 0, updated: counted?.updated ?? 0,
    // The plan names which plugins run an agent, but it is read apart from the run and may be absent: the agent's own
    // exchange names its producer too.
    agent: agentOf(group.plugin) || exchange !== undefined, phase: group.phase,
    ...(reason === undefined ? {} : { reason }),
    ...(outcomes.at(-1) === undefined ? {} : { outcome: outcomes.at(-1)!.outcome }),
    ...(exchange === undefined ? {} : { opened: exchange.opened.length, files: exchange.given.filesTotal, calls: exchange.steps.filter((step) => step.kind === 'tool-call').length }),
  };
}

/**
 * What a producer created and changed of one kind, in the reader's words. The label stands first and the counts after
 * it, so no label needs a case the manifest does not declare: a kind's names are one and many, and «создано 3» reads the
 * same for any of them.
 */
export function writtenWords(kind: string, created: number, updated: number, t: TFunction): string {
  if (created > 0 && updated > 0) return t('knowledge.fillRun.result.kindCounts', { kind, created, updated });
  return created > 0 ? t('knowledge.fillRun.result.kindCreated', { kind, count: created }) : t('knowledge.fillRun.result.kindUpdated', { kind, count: updated });
}

/**
 * What a group's own work came to, in the reader's words: the entities it wrote, or why it wrote none. Only a group that
 * finished its own search says what it found: a failure, a stop, a skip, and a group whose run ended before it was
 * reached (it waits) are not a search that found nothing, so those groups state their phase and never «ничего не
 * создано».
 */
export function groupResultWords(result: GroupResult, kind: string, t: TFunction): string | null {
  if (result.created > 0 || result.updated > 0) return writtenWords(kind, result.created, result.updated, t);
  if (result.outcome === 'unchanged') return t('knowledge.fillRun.result.unchanged');
  if (result.phase !== 'done') return null;
  return t(result.agent ? 'knowledge.fillRun.result.nothingAgent' : 'knowledge.fillRun.result.nothingPlugin');
}

/** Why a group that wrote nothing wrote nothing, as the page states it beside its result. */
export function groupCauseWords(result: GroupResult, t: TFunction): string | null {
  if (result.created > 0 || result.updated > 0) return null;
  if (result.reason !== undefined && result.reason.trim() !== '') return t('knowledge.fillRun.result.reason', { reason: result.reason });
  // Only a producer that looked and found nothing says what it opened: a group that failed, was stopped, was skipped, was
  // never reached, or changed nothing is not one of them.
  if (result.outcome === 'unchanged' || result.phase !== 'done') return null;
  if (!result.agent) return null;
  if (result.calls === 0 && (result.opened ?? 0) === 0) return t('knowledge.fillRun.result.agentOpenedNone');
  if ((result.opened ?? 0) === 0 && (result.files ?? 0) > 0) return t('knowledge.fillRun.result.agentOpenedZero', { files: result.files });
  return null;
}

/** The run's own result, as its title states it: what it wrote, or that it wrote nothing and who found nothing. */
export function runResultWords(run: FillRunDetail, agentOf: (plugin: string) => boolean, labelOf: (kind: string) => string | undefined, t: TFunction): string {
  const counted = (run.entities ?? []).filter((one) => one.created + one.updated > 0);
  if (counted.length > 0) {
    const kinds = [...new Set(counted.map((one) => one.kind))];
    if (kinds.length === 1) {
      const kind = kinds[0]!;
      return writtenWords(labelOf(kind) ?? kind, counted.reduce((sum, one) => sum + one.created, 0), counted.reduce((sum, one) => sum + one.updated, 0), t);
    }
    const created = counted.reduce((sum, one) => sum + one.created, 0), updated = counted.reduce((sum, one) => sum + one.updated, 0);
    return [
      ...(created === 0 ? [] : [t('knowledge.fillRun.result.createdEntities', { count: created })]),
      // The first words of a title start with a capital: «Изменено 2 сущности», never «изменено 2 сущности».
      ...(updated === 0 ? [] : [t(created === 0 ? 'knowledge.fillRun.result.updatedEntitiesFirst' : 'knowledge.fillRun.result.updatedEntities', { count: updated })]),
    ].join(', ');
  }
  // A run that failed or was stopped wrote nothing because it did not finish, and its title says so, never that its
  // producers looked and found nothing.
  if (run.phase === 'failed' || run.phase === 'stopped') return t(`knowledge.fillRun.final.${run.phase}`);
  const outcomes = run.outcomes ?? [];
  if (outcomes.length > 0 && outcomes.every((one) => one.outcome === 'unchanged')) return t('knowledge.fillRun.result.unchanged');
  const producers = new Set(run.groups.filter((group) => group.total > 0).map((group) => groupResultOf(run, group, agentOf).agent ? 'agent' : 'plugin'));
  if (producers.size === 1) return t(producers.has('agent') ? 'knowledge.fillRun.result.nothingAgent' : 'knowledge.fillRun.result.nothingPlugin');
  return t('knowledge.fillRun.result.nothing');
}

/** A final run's ending as the reader reads it: day, month, hour and minute, never a second year line. */
function shortMoment(iso: string, language: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso.slice(0, 16).replace('T', ', ');
  return new Intl.DateTimeFormat(language, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(date);
}

/** One line of the run journal: what happened, and for a failure the cause's own words, the next action and the row. */
interface JournalLine {
  readonly at: string;
  readonly text: string;
  /** A failure's own text with its file and line, the next action's class, and the logs page narrowed to its row. */
  readonly cause: { readonly text: string; readonly next: RunCause; readonly link: string } | null;
  /** How many events of one kind and group the line stands for: a run that retries four times says so once. */
  readonly times: number;
}

/**
 * A failure's own cause, as the event's summary states it: the innermost `file:line: …` a person can act on (the
 * plugin's message, not the engine's sentence around it), and the event's whole text when it names no place.
 */
export function causeTextOf(summary: string): string {
  let fromAt = 0;
  for (let at = 0; at < summary.length; at += 1) {
    if (at !== 0 && summary[at]!.trim() !== '') continue;
    const start = summary[at]!.trim() === '' ? at + 1 : at;
    let colon = start;
    while (colon < summary.length && summary[colon] !== ':' && summary[colon]!.trim() !== '') colon += 1;
    if (summary[colon] !== ':') continue;
    const file = summary.slice(start, colon);
    const dot = file.lastIndexOf('.');
    const extension = file.slice(dot + 1);
    if (dot < 0 || extension === '' || [...extension].some((character) =>
      !((character >= 'A' && character <= 'Z') || (character >= 'a' && character <= 'z') || (character >= '0' && character <= '9')))) continue;
    let end = colon + 1;
    while (end < summary.length && summary[end]! >= '0' && summary[end]! <= '9') end += 1;
    if (end === colon + 1 || summary.slice(end, end + 2) !== ': ') continue;
    fromAt = at + (summary[at] === ' ' ? 1 : 0);
    at = end + 1;
  }
  const from = summary.slice(fromAt);
  // The engine's own retry tail is bookkeeping, not the cause. Like the original suffix match, a tail ends at no
  // intervening line terminator; whitespace between the semicolon and the opening may itself span lines.
  let text = from;
  for (let at = from.indexOf(';'); at >= 0; at = from.indexOf(';', at + 1)) {
    let opening = at + 1;
    while (opening < from.length && from[opening]!.trim() === '') opening += 1;
    if (!from.slice(opening, opening + 'the attempt is retried'.length).replaceAll('ſ', 's').replaceAll('K', 'k').toLowerCase().startsWith('the attempt is retried')) continue;
    const tail = from.slice(opening + 'the attempt is retried'.length);
    if ([...tail].some((character) => '\n\r\u2028\u2029'.includes(character))) continue;
    text = from.slice(0, at);
    break;
  }
  return text.length <= 300 ? text : `${text.slice(0, 300)}…`;
}

/** The unit a failure names, short: `<plugin>:<kind>` behind its stage's path and its vertex or child marks. */
function unitLabelOf(unitId: string): string {
  const unit = unitId.slice(unitId.lastIndexOf('/') + 1);
  return (unit.split('@')[0] ?? '').split('#')[0] ?? '';
}

/**
 * The run's journal as a person reads it (madarch-64o5.88, part 3): the key transitions of the run and its work per kind,
 * never the engine's own sentences. A run of the same event type and group in a row is one line with its count, and every
 * failure carries its cause and the next action in words — the raw summary stays in the detailed logs, which the page links.
 */
function journalLines(run: FillRunDetail, groups: readonly FillRunGroup[], labelOf: (kind: string) => string | undefined, pluginName: (name: string) => string | undefined, t: TFunction, language: string): JournalLine[] {
  const runId = run.runId;
  const lines: JournalLine[] = [];

  for (const event of run.events.slice(-200)) {
    const word = EVENT_WORDS[event.type];
    // A unit being planned is the run's bookkeeping, not a transition a person reads: the journal keeps the work.
    if (word === undefined || word === 'unitPlanned') continue;
    const parts = unitPartsOf(groups, event.unitId !== '' ? event.unitId : event.stage);
    let text: string;
    if (word.startsWith('unit') || word === 'stagePlanned' || word === 'foundNothing') {
      if (parts === undefined) continue;
      const kind = labelOf(parts.kind);
      if (kind === undefined) continue;
      text = t(`knowledge.fillRun.event.${word}`, { kind, plugin: pluginName(parts.plugin) ?? parts.plugin });
    } else {
      text = t(`knowledge.fillRun.event.${word}`);
    }
    const failure = word === 'unitFailed' || word === 'unitBlocked' || word === 'unitRetried' || word === 'failed' || word === 'blocked';
    const cause = failure ? {
      text: causeTextOf(event.summary),
      next: runCauseOf(event.summary),
      // The row a failure states is found by the unit's own name and the error level; the page opens on it.
      link: logsAddress(runId, { ...(event.unitId === '' ? {} : { q: unitLabelOf(event.unitId) }), level: 'error' }),
    } : null;
    const last = lines[lines.length - 1];
    // A repeat of the same line is the same line: the count is what a reader needs, not four identical rows.
    if (last !== undefined && last.text === text) {
      lines[lines.length - 1] = { ...last, at: event.at, times: last.times + 1, cause: last.cause ?? cause };
      continue;
    }
    lines.push({ at: event.at, text, cause, times: 1 });
  }
  return lines.map((line) => ({ ...line, at: new Date(line.at).toLocaleTimeString(language) }));
}

/** The newest event of a run as words, for the home's last-fill line (madarch-64o5.133). */
export function latestEventWords(run: FillRunDetail, labelOf: (kind: string) => string | undefined, pluginName: (name: string) => string | undefined, t: TFunction): string | undefined {
  return journalLines(run, run.groups, labelOf, pluginName, t, 'en').at(-1)?.text;
}

/** One fill run. */
export function RunSection({ context }: { readonly context: SectionContext }): ReactElement {
  const { t, i18n } = useTranslation();
  const connection = useConnection();
  const language = context.language !== undefined && context.language !== '' ? context.language : (i18n.resolvedLanguage ?? 'en').startsWith('ru') ? 'ru' : 'en';
  const parameter = typeof context.section.params['runVariable'] === 'string' ? context.section.params['runVariable'] : 'run';
  const bound = context.variables[parameter];
  const runId = typeof bound === 'string' ? bound : '';
  const read = useCommandRead<{ run: FillRunDetail }>(`fill-run:${runId}`, (signal) => readFillRun(context.base, runId, signal), runId !== '');
  const run = read.data?.run ?? null;
  const orderKey = (run?.order ?? run?.selected ?? []).join(',');
  const plan = useCommandRead<{ plan: FillPlanView }>(`run-plan-labels:${orderKey}`, (signal) => readFillPlan(context.base, run?.order ?? run?.selected ?? [], signal), run !== null && orderKey !== '');
  useChangeStream(context.base, () => { read.reload(); });
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const live = run !== null && LIVE.includes(run.phase);
  useEffect(() => {
    if (!live) return;
    // The run's own state moves while a fill writes; the change stream may not say so, so the page reads it again each
    // second. The clock drives the elapsed line between reads.
    const timer = setInterval(() => { setNow(Date.now()); read.reload(); }, 1000);
    return () => clearInterval(timer);
  }, [live, read.reload]);

  const catalogue = context.navigation?.kinds ?? [];
  const groups = context.navigation?.groups ?? [];
  const cause = run === null ? undefined : failureCauseOf(run);
  const pluginName = (name: string): string | undefined => {
    const labels = plan.data?.plan.plugins?.find((plugin) => plugin.name === name)?.labels;
    return labels?.[language] ?? labels?.['en'];
  };
  const labelOf = (kind: string): string | undefined => catalogue.find((one) => one.kind === kind)?.many;
  // The plan declares which plugins run an agent, so the page names the producer that found nothing as it is.
  const agentOf = (plugin: string): boolean => plan.data?.plan.plugins?.find((one) => one.name === plugin)?.agent === true;
  const groupLabelOf = (kind: string): string | undefined => {
    const held = catalogue.find((one) => one.kind === kind);
    if (held?.group === null || held?.group === undefined) return undefined;
    const group = groups.find((one) => one.name === held.group);
    return group?.labels[language] ?? group?.labels['en'] ?? held.group;
  };
  const names = (run?.order ?? run?.selected ?? []).map((kind) => labelOf(kind)).filter((label): label is string => label !== undefined);
  const lines = run === null ? [] : journalLines(run, run.groups, labelOf, pluginName, t, language);

  const act = (action: 'pause' | 'stop'): void => {
    if (connection.offline || run === null) return;
    setBusy(true);
    setFailure(null);
    const work = action === 'pause' ? pauseFillRun(context.base, run.runId) : stopFillRun(context.base, run.runId);
    work.then(
      () => { setBusy(false); setConfirming(false); read.reload(); },
      (error: unknown) => { setBusy(false); setFailure(isOffline(error) ? null : error instanceof Error ? error.message : String(error)); },
    );
  };

  if (runId === '') return <Alert variant="problem" data-testid="fill-run-missing"><AlertDescription>{t('knowledge.fillRun.noRun')}</AlertDescription></Alert>;
  if (read.error !== null) return <Alert variant="problem" data-testid="fill-run-error"><AlertDescription>{read.error}</AlertDescription></Alert>;
  if (run === null) return <Skeleton className="h-10 w-80" data-testid="fill-run-loading" />;

  const started = new Date(run.startedAt);
  const elapsed = live ? Math.max(run.elapsedMs, now - started.getTime()) : run.elapsedMs;
  const terminal = run.final || ['succeeded', 'partial', 'failed', 'stopped'].includes(run.phase);
  const emptyWords = t(terminal ? 'knowledge.fillRun.noUnits' : 'knowledge.fillRun.planning');
  // The run's own headline is what it wrote in entities, never the engine's work units (madarch-64o5.106).
  const resultWords = run.units.length === 0 ? emptyWords : terminal ? runResultWords(run, agentOf, labelOf, t) : t('knowledge.fillRun.active');
  const agentUsage = run.agentUsage;
  const finished = run.finishedAt === null ? null : shortMoment(run.finishedAt, language);
  const liveRun = run;

  return (
    <Stack className="grid gap-6" data-testid="fill-run-page" data-state={run.state} data-phase={run.phase}>
      <Card>
        <CardHeader>
          <Stack className="flex flex-wrap items-center gap-2" data-testid="fill-run-status" data-phase={run.phase}>
            <Badge variant={terminal ? 'solid' : 'outline'} className="px-2 py-0.5 text-small" data-testid="fill-run-status-badge">{t(`knowledge.fillRun.status.${run.phase}`, { defaultValue: run.phase })}</Badge>
            {finished === null ? null : <Text className="text-small text-muted" data-testid="fill-run-ended">{finished}{t('common.separator')}{t('knowledge.fillRun.duration', { seconds: seconds(elapsed) })}</Text>}
          </Stack>
          <CardTitle data-testid="fill-run-result-title">{resultWords}</CardTitle>
          {terminal && (run.phase === 'partial' || run.phase === 'failed') ? (
            <Alert variant="problem" className="mt-2" data-testid="fill-run-final" data-phase={run.phase}>
              <AlertTitle data-testid="fill-run-final-title">{t('knowledge.fillRun.attention')}</AlertTitle>
              <AlertDescription>
                <Paragraph className="m-0">{cause === undefined ? t(`knowledge.fillRun.final.${run.phase}`) : t(`knowledge.fillRun.cause.${cause}`)}</Paragraph>
                <Paragraph className="m-0">{t('knowledge.fillRun.next.retry')}</Paragraph>
                <Button variant="default" size="sm" className="mt-2" data-testid="fill-run-retry" onClick={() => context.open('/p/catalogue?select=1')}>{t('knowledge.fillRun.next.retryAction')}</Button>
              </AlertDescription>
            </Alert>
          ) : null}
          {names.length === 0 ? null : <Paragraph className="m-0 text-small text-muted" data-testid="fill-run-selection">{names.join(', ')}</Paragraph>}
        </CardHeader>
        <CardContent>
          {run.units.length > 0 && !terminal ? <Progress value={run.publishedUnits} max={run.units.length} aria-label={t('knowledge.fillRun.progress')} /> : null}
          <Paragraph className="mt-3 text-small" data-testid="fill-run-time">
            {t('knowledge.fillRun.elapsed', { seconds: seconds(elapsed) })}{terminal ? null : <>{t('common.separator')}{run.remainingMs === null ? t('knowledge.fillRun.remainingUnknown') : t('knowledge.fillRun.remaining', { seconds: seconds(run.remainingMs) })}</>}
          </Paragraph>
          <Paragraph className="m-0 text-small" data-testid="fill-run-tokens">{agentUsage === null ? t('knowledge.fillRun.tokensUnknown') : t('knowledge.fillRun.tokens', { input: agentUsage.inputTokens, output: agentUsage.outputTokens, cacheWrite: agentUsage.cachedWriteTokens, cacheRead: agentUsage.cachedReadTokens, total: agentUsage.totalTokens })}</Paragraph>
          <Paragraph className="m-0 text-small" data-testid="fill-run-records">{t('knowledge.fillRun.records', { count: run.records })}</Paragraph>
          <Stack className="mt-4 flex flex-wrap gap-2">
            {run.phase === 'running' ? (
              <OfflineAction offline={connection.offline}>
                <Button variant="default" size="default" disabled={connection.offline || busy} disabledReason={connection.offline ? t('connection.actionsDisabled') : t('common.actionInProgress')} onClick={() => act('pause')} data-testid="run-pause">{t('knowledge.fillPage.pause')}</Button>
              </OfflineAction>
            ) : null}
            {STOPPABLE.includes(run.phase) ? (
              <OfflineAction offline={connection.offline}>
                <Button size="default" disabled={connection.offline || busy || run.state === 'cancelling'} disabledReason={connection.offline ? t('connection.actionsDisabled') : run.state === 'cancelling' ? t('knowledge.fillPage.runStates.cancelling') : t('common.actionInProgress')} onClick={() => setConfirming(true)} data-testid="run-stop">{t('knowledge.fillPage.stop')}</Button>
              </OfflineAction>
            ) : null}
          </Stack>
          {failure === null ? null : <Paragraph role="alert" className="mt-2 text-small">{failure}</Paragraph>}
        </CardContent>
      </Card>

      <Card data-testid="fill-run-groups">
        <CardHeader><CardTitle>{t('knowledge.fillRun.resultTitle')}</CardTitle></CardHeader>
        <CardContent>
          <PlainList className="m-0 list-none p-0">
            {liveRun.groups.filter((group) => group.total > 0).map((group) => {
              const kind = labelOf(group.kind);
              if (kind === undefined) return null;
              const area = groupLabelOf(group.kind);
              const result = groupResultOf(liveRun, group, agentOf);
              const settled = group.state === 'published' || terminal;
              const words = groupResultWords(result, kind, t);
              const because = groupCauseWords(result, t);
              return (
                <ListItem key={`${group.kind}:${group.plugin}`} className="mb-3" data-testid="fill-run-group" data-created={result.created} data-updated={result.updated}>
                  <Paragraph className="m-0">
                    {area === undefined || area === kind ? null : <Text className="text-muted">{area}{t('common.separator')}</Text>}
                    {kind}{t('common.separator')}{pluginName(group.plugin) === undefined ? <InlineCode>{group.plugin}</InlineCode> : pluginName(group.plugin)}
                  </Paragraph>
                  <Paragraph className="m-0 text-small text-muted" data-testid="fill-run-group-result">
                    {settled && words !== null ? <>{words}{t('common.separator')}</> : null}{t(`knowledge.fillRun.phase.${group.phase}`, { defaultValue: group.phase })}
                  </Paragraph>
                  {because === null ? null : <Paragraph className="m-0 text-small text-muted" data-testid="fill-run-group-cause">{because}</Paragraph>}
                  {group.total > 0 ? <Progress value={group.done} max={group.total} aria-label={kind} /> : null}
                </ListItem>
              );
            })}
          </PlainList>
          {terminal && liveRun.units.some((unit) => unit.phase === 'failed' || unit.phase === 'skipped') ? (
            <PlainList className="m-0 mt-3 list-none p-0" data-testid="fill-run-units">
              {liveRun.units.filter((unit) => unit.phase === 'failed' || unit.phase === 'skipped').map((unit) => {
                const group = groupOf(liveRun.groups, unit.unitId);
                const unitKind = group === undefined ? undefined : labelOf(group.kind);
                const unitPlugin = group === undefined ? undefined : pluginName(group.plugin) ?? group.plugin;
                const words = unitKind === undefined ? undefined : `${unitKind}${unitPlugin === undefined ? '' : ` · ${unitPlugin}`}`;
                const because = unit.skippedBecause?.startsWith('unit ') === true && unit.skippedBecause.endsWith(' failed')
                  ? (() => {
                    const failedId = unit.skippedBecause.slice('unit '.length, -' failed'.length);
                    const failedGroup = groupOf(liveRun.groups, failedId);
                    const failedKind = failedGroup === undefined ? undefined : labelOf(failedGroup.kind);
                    const failedPlugin = failedGroup === undefined ? undefined : pluginName(failedGroup.plugin) ?? failedGroup.plugin;
                    return failedKind === undefined ? t('knowledge.fillRun.phase.skippedBecauseRunEnded') : t('knowledge.fillRun.phase.skippedBecause', { unit: `${failedKind}${failedPlugin === undefined ? '' : ` · ${failedPlugin}`}` });
                  })()
                  : unit.phase === 'skipped' ? t('knowledge.fillRun.phase.skippedBecauseRunEnded') : null;
                return (
                  <ListItem key={`${unit.unitId}@${String(unit.generation)}:${unit.scope}`} className="text-small" data-testid="fill-run-unit">
                    {t(`knowledge.fillRun.phase.${unit.phase}`, { defaultValue: unit.phase })}{words === undefined ? null : ` · ${words}`}
                    {because === null ? null : ` — ${because}`}
                  </ListItem>
                );
              })}
            </PlainList>
          ) : null}
        </CardContent>
      </Card>


      {liveRun.agentExchanges === undefined ? null : (
        <Card data-testid="fill-run-agents">
          <CardHeader><CardTitle>{t('knowledge.fillRun.agents.title')}</CardTitle></CardHeader>
          <CardContent>
            {liveRun.agentExchanges.length === 0 ? <Paragraph className="m-0 text-small text-muted">{t('knowledge.fillRun.agents.empty')}</Paragraph> : (
              <PlainList className="m-0 list-none p-0">
                {liveRun.agentExchanges.map((exchange) => {
                  const colon = exchange.unit.indexOf(':');
                  const plugin = colon < 0 ? exchange.unit : exchange.unit.slice(0, colon);
                  const heldKind = (colon < 0 ? '' : exchange.unit.slice(colon + 1)).split('@')[0] ?? '';
                  const kind = labelOf(heldKind) ?? heldKind;
                  const usage = exchange.usage;
                  const answered = exchange.returned === null ? null : exchange.returned.text;
                  return (
                    <ListItem key={exchange.unit} className="mb-3" data-testid="agent-unit">
                      <Disclosure data-testid="agent-details">
                        <DisclosureSummary data-testid="agent-summary">
                          {kind} · {pluginName(plugin) ?? plugin} · {t(`knowledge.fillRun.agents.state.${exchange.state}`, { defaultValue: exchange.state })} · {t('knowledge.fillRun.agents.details')}
                        </DisclosureSummary>
                        <Stack className="mt-2 grid gap-3">
                          <Metadata data-testid="agent-facts">
                            {t('knowledge.fillRun.agents.model', { model: exchange.model ?? '—' })} · {t('knowledge.fillRun.agents.agent', { agent: exchange.agent })} · {t('knowledge.fillRun.agents.time', { seconds: seconds(exchange.durationMs) })}
                          </Metadata>
                          <Stack className="grid gap-1">
                            <Text className="font-medium">{t('knowledge.fillRun.agents.given')}</Text>
                            <Metadata>{t('knowledge.fillRun.agents.givenFiles', { count: exchange.given.filesTotal })} · {t('knowledge.fillRun.agents.opened', { count: exchange.opened.length })}</Metadata>
                            <TechnicalText data-testid="agent-prompt">{exchange.given.prompt}</TechnicalText>
                            {exchange.given.cut ? <Metadata>{t('knowledge.fillRun.agents.cut')} · {t('knowledge.fillRun.agents.bytes', { count: exchange.given.bytes })}</Metadata> : null}
                          </Stack>
                          <Stack className="grid gap-1">
                            <Text className="font-medium">{t('knowledge.fillRun.agents.opened', { count: exchange.opened.length })}</Text>
                            {exchange.opened.length === 0 ? <Paragraph className="m-0 text-small text-muted">{t('knowledge.fillRun.agents.openedEmpty')}</Paragraph> : (
                              <PlainList className="m-0 list-none p-0" data-testid="agent-opened">
                                {exchange.opened.map((open, at) => (
                                  <ListItem key={`${String(at)}:${open.repository}/${open.path}`} className="text-small">
                                    <TextLink href={`${context.base}/api/source?${new URLSearchParams({ repo: open.repository, path: open.path }).toString()}`}>{`${open.repository}: ${open.path}`}</TextLink>
                                    <Metadata>{open.line === undefined ? '' : ` · ${t('knowledge.fillRun.agents.line', { line: open.line })}`} · {t('knowledge.fillRun.agents.bytes', { count: open.bytes })}</Metadata>
                                  </ListItem>
                                ))}
                              </PlainList>
                            )}
                            {exchange.openedDropped === 0 ? null : <Metadata>{t('knowledge.fillRun.agents.openedDropped', { count: exchange.openedDropped })}</Metadata>}
                          </Stack>
                          <Stack className="grid gap-1">
                            <Text className="font-medium">{t('knowledge.fillRun.agents.steps')}</Text>
                            {exchange.steps.length === 0 ? <Paragraph className="m-0 text-small text-muted">{t('knowledge.fillRun.agents.stepsEmpty')}</Paragraph> : (
                              <PlainList className="m-0 list-none p-0" data-testid="agent-steps">
                                {exchange.steps.map((step, at) => (
                                  <ListItem key={`${String(at)}:${step.at}`} className="mb-2 text-small">
                                    <Metadata>{new Date(step.at).toLocaleTimeString(language)} · {t(`knowledge.fillRun.agents.step.${step.kind}`, { defaultValue: step.sessionUpdate })}</Metadata>
                                    {step.title === undefined ? null : <Text> · {step.title}</Text>}
                                    {step.status === undefined ? null : <Metadata> · {step.status}</Metadata>}
                                    {step.path === undefined ? null : <Metadata> · <InlineCode>{step.path}</InlineCode></Metadata>}
                                    {step.text === undefined ? null : <TechnicalText>{step.text}</TechnicalText>}
                                    {step.detail === undefined ? null : <TechnicalText>{step.detail}</TechnicalText>}
                                  </ListItem>
                                ))}
                              </PlainList>
                            )}
                            {exchange.stepsDropped === 0 ? null : <Metadata>{t('knowledge.fillRun.agents.stepsDropped', { count: exchange.stepsDropped })}</Metadata>}
                          </Stack>
                          <Stack className="grid gap-1">
                            <Text className="font-medium">{t('knowledge.fillRun.agents.returned')}</Text>
                            {answered === null ? <Paragraph className="m-0 text-small text-muted">{t('knowledge.fillRun.agents.returnedMissing')}</Paragraph>
                              : answered.trim() === '' ? <Paragraph className="m-0 text-small text-muted">{t('knowledge.fillRun.agents.returnedEmpty')}</Paragraph>
                                : <TechnicalText data-testid="agent-answer">{answered}</TechnicalText>}
                            {exchange.returned !== null && exchange.returned.cut ? <Metadata>{t('knowledge.fillRun.agents.cut')} · {t('knowledge.fillRun.agents.bytes', { count: exchange.returned.bytes })}</Metadata> : null}
                          </Stack>
                          <Metadata data-testid="agent-tokens">
                            {usage === null || !usage.reported ? t('knowledge.fillRun.tokensUnknown') : t('knowledge.fillRun.tokens', { input: usage.inputTokens ?? 0, output: usage.outputTokens ?? 0, cacheWrite: usage.cachedWriteTokens ?? 0, cacheRead: usage.cachedReadTokens ?? 0, total: usage.totalTokens ?? 0 })}
                            {usage?.context === undefined ? null : <> · {t('knowledge.fillRun.agents.context', { used: usage.context.used, size: usage.context.size })}</>}
                          </Metadata>
                          {exchange.failure === null ? null : <Paragraph className="m-0 text-small" data-testid="agent-failure">{t('knowledge.fillRun.agents.failure')}: {exchange.failure}</Paragraph>}
                          <Disclosure data-testid="agent-raw">
                            <DisclosureSummary>{t('knowledge.fillRun.agents.raw')}</DisclosureSummary>
                            <TechnicalText>{JSON.stringify(exchange, null, 2)}</TechnicalText>
                          </Disclosure>
                        </Stack>
                      </Disclosure>
                    </ListItem>
                  );
                })}
              </PlainList>
            )}
          </CardContent>
        </Card>
      )}

      <Card data-testid="fill-run-journal">
        <CardHeader><CardTitle>{t('knowledge.fillRun.log')}</CardTitle></CardHeader>
        <CardContent>
          {lines.length === 0 ? <Paragraph className="m-0 text-small text-muted">{t('knowledge.fillRun.logEmpty')}</Paragraph> : (
            <PlainList className="m-0 list-none p-0">
              {lines.map((line, at) => (
                <ListItem key={`${String(at)}:${line.at}`} className="mb-2 text-small" data-testid="fill-run-journal-line">
                  <Metadata>{line.at} · </Metadata>{line.text}{line.times > 1 ? ` ×${String(line.times)}` : ''}
                  {line.cause === null ? null : (
                    <Stack className="mt-1 grid gap-1" data-testid="fill-run-journal-cause">
                      <TechnicalText>{line.cause.text}</TechnicalText>
                      <Metadata>{t(`knowledge.fillRun.next.${line.cause.next}`)} <TextLink href={context.base + line.cause.link} onClick={(event) => { event.preventDefault(); context.open(line.cause!.link); }} data-testid="fill-run-and-logs">{t('knowledge.fillRun.logRow')}</TextLink></Metadata>
                    </Stack>
                  )}
                </ListItem>
              ))}
            </PlainList>
          )}
          {liveRun.summary === undefined || liveRun.summary.steps.length === 0 ? null : (
            <Stack className="mt-3 grid gap-1" data-testid="fill-run-stage-times">
              <Text className="font-medium">{t('knowledge.fillRun.stageTimes')}</Text>
              {liveRun.summary.steps.map((step) => (
                <Metadata key={step.step}>{t(`knowledge.fillRun.stage.${step.step}`, { defaultValue: t('knowledge.fillRun.stageOther') })} · {t('knowledge.fillRun.agents.time', { seconds: seconds(step.wallMs) })}</Metadata>
              ))}
            </Stack>
          )}
          <Paragraph className="mt-3"><TextLink href={context.base + logsAddress(runId)} onClick={(event) => { event.preventDefault(); context.open(logsAddress(runId)); }} data-testid="fill-run-logs-link">{t('knowledge.fillRun.logsLink')}</TextLink></Paragraph>
        </CardContent>
      </Card>

      <Paragraph><TextLink href={context.base + RUNS_PAGE} onClick={(event) => { event.preventDefault(); context.open(RUNS_PAGE); }}>{t('runs.back')}</TextLink></Paragraph>

      <Dialog open={confirming} onOpenChange={(open) => { if (!busy) setConfirming(open); }}>
        <DialogContent data-testid="stop-dialog" closeLabel={t('knowledge.fillPage.stopCancel')} closeDisabledReason={busy ? t('common.actionInProgress') : null}>
          <DialogHeader><DialogTitle>{t('knowledge.fillPage.stopTitle')}</DialogTitle></DialogHeader>
          <DialogBody><DialogDescription>{t('knowledge.fillRun.stopWords')}</DialogDescription></DialogBody>
          <DialogFooter>
            <Button variant="default" size="default" disabled={connection.offline || busy} disabledReason={connection.offline ? t('connection.actionsDisabled') : t('common.actionInProgress')} onClick={() => act('stop')} data-testid="stop-confirm">{t('knowledge.fillPage.stopConfirm')}</Button>
            <Button size="default" disabled={busy} disabledReason={t('common.actionInProgress')} onClick={() => setConfirming(false)}>{t('knowledge.fillPage.stopCancel')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Stack>
  );
}
