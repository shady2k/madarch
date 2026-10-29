/**
 * «Заполнение» (madarch-m38l.23): the fill as a page of its own, like the page of a
 * CI run. It says who writes, since when and how long it has taken, how much of the
 * work is done, and each page the agent takes up by the kind's name the manifest
 * declares and the page's own title («Термин Capture», «Правило BR-3»), with its
 * state, a link to the page it wrote and to its journal where one exists. Paths and
 * call counts stand under «Подробности для инженера»: they are the engineer's.
 */
import { useState, type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert.js';
import { Badge } from '@/components/ui/badge.js';
import { Button } from '@/components/ui/button.js';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card.js';
import { KLink } from './blocks.js';
import { FailureNote } from './errors.js';
import { fillShare, fillWords } from './fill-words.js';
import { PlanList } from './loop.js';
import { addressOfEntity, addressOfJournal } from './routes.js';
import { startFill, UNIT_STATE_KEY, unitName } from './writer.js';
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
    <li className="border-b border-line py-2 last:border-b-0" data-testid="fill-unit" data-unit={unit.unit} data-state={unit.state} aria-current={current ? 'step' : undefined}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {written ? <KLink href={addressOfEntity(unit.page!)} className="text-ink hover:underline" testId="fill-unit-page">{name}</KLink> : <span className="text-ink" data-testid="fill-unit-name">{name}</span>}
        <Badge variant={unit.state === 'writing' ? 'solid' : 'outline'}>{unit.state === 'written' && unit.writeAttempts === 0 ? t('knowledge.writer.unitKept') : t(UNIT_STATE_KEY[unit.state])}</Badge>
        {/* The journal of the page, where one holds it: the runs that wrote it, and only then. */}
        {written && <KLink href={addressOfJournal(unit.page!)} className="text-small text-muted hover:text-ink" testId="fill-unit-journal">{t('journal.title')}</KLink>}
      </div>
      {unit.refusals !== undefined && unit.refusals.length > 0 && (
        <ul className="mb-0 mt-1 text-small" data-testid="fill-unit-refusals">
          {unit.refusals.map((refusal, index) => (
            <li key={index}>{t('knowledge.writer.refusal', { line: refusal.line, rule: refusal.rule, message: refusal.message })}</li>
          ))}
        </ul>
      )}
      <details className="mt-1 text-small text-muted" data-testid="fill-unit-engineer">
        <summary className="cursor-pointer">{t('knowledge.findingsDetails')}</summary>
        <p className="mb-0 mt-1"><code>{unit.path}</code></p>
        {unit.calls !== undefined && <p className="mb-0">{t('knowledge.writer.unitCalls', { calls: unit.calls, attempts: unit.writeAttempts ?? 0 })}</p>}
      </details>
    </li>
  );
}

/** The fill page: the run's facts, the progress of the code read and of the pages written, one row per page, and the plan. */
export function FillPage({ status, refresh }: { status: WikiStatus; refresh: () => void }): ReactElement {
  const { t, i18n } = useTranslation();
  const language = i18n.resolvedLanguage ?? 'en';
  const [retrying, setRetrying] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  const writer = status.writer;
  const fill = status.fill;
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
  const share = units.length === 0 ? 0 : written / units.length;
  const retry = (): void => {
    setRetrying(true);
    setRefused(null);
    startFill(writer.agent?.id).then(
      () => { setRetrying(false); refresh(); },
      (failure: unknown) => { setRetrying(false); setRefused(failure instanceof Error ? failure.message : String(failure)); },
    );
  };
  return (
    <section data-testid="fill-page" data-state={writer.state === 'idle' ? fill.state : writer.state}>
      <header className="mb-6">
        <h1 data-testid="fill-title">{t('knowledge.fillPage.title')}</h1>
        {facts.length > 0 && <p className="mb-0 text-small text-muted" data-testid="fill-facts">{facts.join(' · ')}</p>}
      </header>
      {fill.state === 'running' && (
        <Card className="mb-8" data-testid="fill-code" data-state="running">
          <CardHeader><CardTitle>{t('knowledge.fillRunningTitle')}</CardTitle></CardHeader>
          <CardContent>
            <p className="mb-3 mt-0 text-small text-muted" data-testid="fill-code-words">{fill.repository !== undefined ? t('knowledge.fillReading', { repository: fill.repository, what: fillWords(fill, t) }) : t('knowledge.fillOpening')}</p>
            <div className="h-2 w-full overflow-hidden rounded-full bg-[var(--surface-active)]" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(fillShare(fill) * 100)} aria-label={t('knowledge.fillRunningTitle')}>
              <div className="h-full rounded-full bg-ink transition-[width] duration-150 motion-reduce:transition-none" style={{ width: `${Math.round(fillShare(fill) * 100)}%` }} />
            </div>
          </CardContent>
        </Card>
      )}
      {units.length > 0 && (
        <Card className="mb-8" data-testid="fill-progress">
          <CardHeader>
            <CardTitle data-testid="fill-progress-text">{t('knowledge.fillPage.written', { done: written, total: units.length })}</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="h-2 w-full overflow-hidden rounded-full bg-[var(--surface-active)]" role="progressbar" aria-valuemin={0} aria-valuemax={units.length} aria-valuenow={written} aria-label={t('knowledge.fillPage.written', { done: written, total: units.length })}>
              <div className="h-full rounded-full bg-ink transition-[width] duration-150 motion-reduce:transition-none" style={{ width: `${Math.round(share * 100)}%` }} />
            </div>
            <ol className="m-0 mt-4 list-none p-0" data-testid="fill-units">
              {units.map((unit) => <UnitRow key={unit.unit} unit={unit} current={unit.unit === current} kinds={status.kinds} language={language} />)}
            </ol>
            {writer.state === 'running' && <p className="mb-0 mt-3 text-small text-muted">{t('knowledge.writer.live')}</p>}
          </CardContent>
        </Card>
      )}
      {writer.plan !== undefined && (
        <Card className="mb-8" data-testid="fill-plan">
          <CardHeader><CardTitle>{t('loop.plan.title')}</CardTitle></CardHeader>
          <CardContent><PlanList plan={writer.plan} /></CardContent>
        </Card>
      )}
      {writer.state === 'failed' && (
        <Alert variant="problem" data-testid="fill-failed">
          <AlertTitle>{writer.agent === null ? t('knowledge.fillFailedTitle') : t('knowledge.writer.failedTitle', { agent: writer.agent.label })}</AlertTitle>
          <AlertDescription>
            {writer.message !== undefined && <div data-testid="fill-message"><FailureNote scope="writer" code={writer.code} message={writer.message} /></div>}
            <p className="mb-0 mt-3"><Button variant="default" size="default" disabled={retrying} onClick={retry} data-testid="fill-retry">{t('knowledge.writer.retry')}</Button></p>
            {refused !== null && <p className="mb-0 mt-3 text-small" role="alert" data-testid="fill-refused">{refused}</p>}
          </AlertDescription>
        </Alert>
      )}
      {writer.state === 'idle' && fill.state !== 'running' && <p className="text-muted" data-testid="fill-idle">{t('knowledge.fillPage.idle')}</p>}
    </section>
  );
}
