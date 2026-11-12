import { Stack, Text, PageSection, PageHeader, PageTitle, Paragraph, PlainList, ListItem } from '@/components/ui/typography.js';
import { Disclosure, DisclosureSummary } from '@/components/ui/disclosure.js';
import { InlineCode } from '@/components/ui/inline-content.js';
import { OrderedList } from '@/components/ui/ordered-list.js';
import { Progress } from '@/components/ui/progress.js';
/**
 * «Заполнение» (madarch-m38l.23): the fill as a page of its own, like the page of a
 * CI run. It says who writes, since when and how long it has taken, how much of the
 * work is done, and each page the agent takes up by the kind's name the manifest
 * declares and the page's own title («Термин Capture», «Правило BR-3»), with its
 * state, a link to the page it wrote and to its journal where one exists. Paths, call
 * counts and the plan stand under «Подробности для инженера»: they are the engineer's.
 */
import type { ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert.js';
import { Badge } from '@/components/ui/badge.js';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card.js';
import { KLink } from './blocks.js';
import { FailureNote } from './errors.js';
import { fillShare, fillWords } from './fill-words.js';
import { PlanList } from './loop.js';
import { addressOfEntity, addressOfJournal, WIKI_RUN } from './routes.js';
import { kindNameOf } from './kind-names.js';
import { RunControls, runIsPaused, runIsStopped } from './run-controls.js';
import { UNIT_STATE_KEY, unitName } from './writer.js';
import { FillSetup } from './fill-setup.js';
import { useTabTitle } from './tabs.js';
import type { WikiStatus, WriterUnit } from './types.js';

/** A run's time of day in the reader's language, or nothing when the run did not say when it was. */
function clockOf(iso: string | undefined, language: string): string | null {
  if (iso === undefined) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleTimeString(language, { hour: '2-digit', minute: '2-digit' });
}

/** The whole minutes between two moments of a run, or nothing when either is unknown. */
function minutesBetween(start: string | undefined, end: string | undefined): number | null {
  if (start === undefined || end === undefined) return null;
  const from = new Date(start).getTime();
  const to = new Date(end).getTime();
  if (Number.isNaN(from) || Number.isNaN(to)) return null;
  return Math.max(0, Math.round((to - from) / 60_000));
}

/** One page the agent takes up: its name, its state, the links a reader follows, and its refusals in one line each. */
function UnitRow({ unit, current, kinds, language }: { unit: WriterUnit; current: boolean; kinds: WikiStatus['kinds']; language: string }): ReactElement {
  const { t } = useTranslation();
  const name = unitName(unit, kinds, language);
  const written = unit.state === 'written' && unit.page !== undefined;
  return (
    <ListItem className="border-b border-line py-2 last:border-b-0" data-testid="fill-unit" data-unit={unit.unit} data-state={unit.state} aria-current={current ? 'step' : undefined}>
      <Stack className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {written ? <KLink href={addressOfEntity(unit.page!)} className="text-ink hover:underline" testId="fill-unit-page">{name}</KLink> : <Text className="text-ink" data-testid="fill-unit-name">{name}</Text>}
        <Badge variant={unit.state === 'writing' ? 'solid' : 'outline'}>{unit.state === 'written' && unit.writeAttempts === 0 ? t('knowledge.writer.unitKept') : t(UNIT_STATE_KEY[unit.state])}</Badge>
        {/* The journal of the page, where one holds it: the runs that wrote it, and only then. A page written by a run
            whose journal this machine does not hold — an older run, a journal since removed — has no link to a page that
            would tell a reader nothing. */}
        {written && unit.journal === true && <KLink href={addressOfJournal(unit.page!)} className="text-small text-muted hover:text-ink" testId="fill-unit-journal">{t('journal.title')}</KLink>}
      </Stack>
      {unit.refusals !== undefined && unit.refusals.length > 0 && (
        <PlainList className="mb-0 mt-1 text-small" data-testid="fill-unit-refusals">
          {unit.refusals.map((refusal, index) => (
            <ListItem key={index}>{t('knowledge.writer.refusal', { line: refusal.line, rule: refusal.rule, message: refusal.message })}</ListItem>
          ))}
        </PlainList>
      )}
      <Disclosure className="mt-1 text-small text-muted" data-testid="fill-unit-engineer">
        <DisclosureSummary className="cursor-pointer">{t('knowledge.findingsDetails')}</DisclosureSummary>
        <Paragraph className="mb-0 mt-1"><InlineCode>{unit.path}</InlineCode></Paragraph>
        {unit.calls !== undefined && <Paragraph className="mb-0">{t('knowledge.writer.unitCalls', { calls: unit.calls, attempts: unit.writeAttempts ?? 0 })}</Paragraph>}
      </Disclosure>
    </ListItem>
  );
}

/** The fill page: the run's facts, the progress of the code read and of the pages written, one row per page, and the plan. */
export function FillPage({ status, refresh }: { status: WikiStatus; refresh: () => void }): ReactElement {
  const { t, i18n } = useTranslation();
  const language = i18n.resolvedLanguage ?? 'en';
  useTabTitle(t('knowledge.fillPage.title'));
  const writer = status.writer;
  const fill = status.fill;
  const run = fill.run;
  const units = writer.units;
  const written = units.filter((unit) => unit.state === 'written').length;
  const current = writer.current ?? units.find((unit) => unit.state === 'writing')?.unit;
  const start = clockOf(writer.startedAt ?? fill.startedAt, language);
  const took = minutesBetween(writer.startedAt ?? fill.startedAt, writer.finishedAt ?? fill.finishedAt);
  const agent = writer.agent?.label ?? status.chosenAgent?.label;
  const facts = [
    agent === undefined ? null : t('knowledge.fillPage.agent', { agent }),
    start === null ? null : t('knowledge.fillPage.started', { time: start }),
    took === null ? null : t('knowledge.fillPage.took', { minutes: took }),
  ].filter((fact): fact is string => fact !== null);
  // How much is left is counted against what the run means to write in total, not against what it has taken up:
  // «Записано 12 из 18». Until the writer counts the pages, the count stands alone.
  const total = writer.total;
  return (
    <PageSection data-testid="fill-page" data-state={writer.state === 'idle' ? fill.state : writer.state}>
      <PageHeader className="mb-6">
        <PageTitle data-testid="fill-title">{t('knowledge.fillPage.title')}</PageTitle>
        {facts.length > 0 && <Paragraph className="mb-0 text-small text-muted" data-testid="fill-facts">{facts.join(' · ')}</Paragraph>}
      </PageHeader>
      {run !== undefined && (
        <Card className="mb-8" data-testid="fill-last-run">
          <CardHeader><CardTitle>{t('knowledge.fillPage.lastRun')}</CardTitle></CardHeader>
          <CardContent>
            <Paragraph className="mt-0" data-testid="fill-run-when">{t('knowledge.fillPage.when', { time: new Date(run.startedAt).toLocaleString(language) })}</Paragraph>
            {run.finishedAt !== undefined && <Paragraph data-testid="fill-run-finished">{t('knowledge.fillPage.finished', { time: new Date(run.finishedAt).toLocaleString(language) })}</Paragraph>}
            <Paragraph data-testid="fill-run-selection">{run.selection === undefined
              ? t('knowledge.fillPage.selectionNotRecorded')
              : run.selection === null
              ? t('knowledge.fillPage.wholeSelection')
              : t('knowledge.fillPage.selection', { kinds: run.selection.kinds.map((kind) => kindNameOf(status.kinds, kind, 'many', language)).join(', '), vertex: run.selection.vertex === undefined ? '' : ` · ${run.selection.vertex}` })}</Paragraph>
            <Paragraph data-testid="fill-run-result">{t('knowledge.fillPage.result', { state: t(`knowledge.fillPage.runStates.${run.state}`) })}</Paragraph>
            <KLink href={`${WIKI_RUN}?${new URLSearchParams({ run: run.runId })}`} className="text-small hover:underline" testId="fill-run-link">{t('knowledge.fillPage.runDetails', { run: run.runId })}</KLink>
          </CardContent>
        </Card>
      )}
      <FillSetup refresh={refresh} disabled={fill.state === 'running' || writer.state === 'running' || runIsPaused(status)} />
      {/* The run a person holds or ended (madarch-m38l.17): where it stands, that its pages stay, and the two controls. */}
      {runIsPaused(status) && (
        <Card className="mb-8" data-testid="fill-run" data-state="paused">
          <CardContent className="pt-6">
            <Paragraph className="mb-0 mt-0 text-small text-ink" data-testid="fill-run-words">{total === undefined ? t('knowledge.fillPage.paused') : t('knowledge.fillPage.pausedCount', { done: written, total })}</Paragraph>
            <RunControls status={status} refresh={refresh} where="page" />
          </CardContent>
        </Card>
      )}
      {runIsStopped(status) && (
        <Paragraph className="mb-6 mt-0 text-small text-ink" data-testid="fill-run-words" data-state="stopped">{total === undefined ? t('knowledge.fillPage.stopped') : t('knowledge.fillPage.stoppedCount', { done: written, total })}</Paragraph>
      )}
      {fill.state === 'running' && (
        <Card className="mb-8" data-testid="fill-code" data-state="running">
          <CardHeader><CardTitle>{t('knowledge.fillRunningTitle')}</CardTitle></CardHeader>
          <CardContent>
            <Paragraph className="mb-3 mt-0 text-small text-muted" data-testid="fill-code-words">{fill.repository !== undefined ? t('knowledge.fillReading', { repository: fill.repository, what: fillWords(fill, t) }) : t('knowledge.fillOpening')}</Paragraph>
            <Progress value={Math.round(fillShare(fill) * 100)} aria-label={t('knowledge.fillRunningTitle')} />
            {/* The graph is being read before any page is counted: the run is live, so its two presses stand here. Where
                the progress card shows them under the pages' figures, it alone shows them (madarch-m38l.17). */}
            {total === undefined && units.length === 0 && <RunControls status={status} refresh={refresh} where="page" />}
          </CardContent>
        </Card>
      )}
      {(total !== undefined || units.length > 0) && (
        <Card className="mb-8" data-testid="fill-progress">
          <CardHeader>
            <CardTitle data-testid="fill-progress-text">{total === undefined ? t('knowledge.fillPage.writtenCount', { done: written }) : t('knowledge.fillPage.written', { done: written, total })}</CardTitle>
          </CardHeader>
          <CardContent>
            {total !== undefined && (
              <Progress value={Math.min(written, total)} max={total} aria-label={t('knowledge.fillPage.written', { done: written, total })} />
            )}
            <OrderedList className="m-0 mt-4 list-none p-0" data-testid="fill-units">
              {units.map((unit) => <UnitRow key={unit.unit} unit={unit} current={unit.unit === current} kinds={status.kinds} language={language} />)}
            </OrderedList>
            {writer.state === 'running' && <Paragraph className="mb-0 mt-3 text-small text-muted">{t('knowledge.writer.live')}</Paragraph>}
            {/* While the run is under way, the two presses stand under the figures they act on. */}
            <RunControls status={status} refresh={refresh} where="page" />
          </CardContent>
        </Card>
      )}
      {/* The plan names the paths the run will touch: the engineer's, behind the same summary the unit rows use.
          The reader's figure is the progress above, counted against the same total, so «План» repeats nothing. */}
      {writer.plan !== undefined && (
        <Disclosure className="mb-8 text-small text-muted" data-testid="fill-plan">
          <DisclosureSummary className="cursor-pointer">{t('knowledge.findingsDetails')}</DisclosureSummary>
          <Stack className="mt-2"><PlanList plan={writer.plan} /></Stack>
        </Disclosure>
      )}
      {writer.state === 'failed' && (
        <Alert variant="problem" data-testid="fill-failed">
          <AlertTitle>{writer.agent === null ? t('knowledge.fillFailedTitle') : t('knowledge.writer.failedTitle', { agent: writer.agent.label })}</AlertTitle>
          <AlertDescription>
            {writer.message !== undefined && <Stack data-testid="fill-message"><FailureNote scope="writer" code={writer.code} message={writer.message} /></Stack>}
          </AlertDescription>
        </Alert>
      )}
      {run === undefined && writer.state === 'idle' && fill.state !== 'running' && <Paragraph className="text-muted" data-testid="fill-idle">{t('knowledge.fillPage.idle')}</Paragraph>}
    </PageSection>
  );
}
