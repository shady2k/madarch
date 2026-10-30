/**
 * «Как агент писал эту страницу» (madarch-m38l.13): the core's journal of what
 * the agent did while it wrote one page, read from the machine-local store.
 * Every call is a row with its tool, its outcome and its duration; a row opens
 * to the full arguments and the full response; a refusal says why. The numbers
 * at the top are counted from the same rows, so the page and the progress
 * block's «вызовов инструментов» tell the same count.
 */
import { useState, type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert.js';
import { Badge } from '@/components/ui/badge.js';
import { getJournal } from './api.js';
import { KLink } from './blocks.js';
import { useRead } from './live.js';
import { PageSkeleton } from './skeleton.js';
import { useTabTitle } from './tabs.js';
import { addressOfEntity, addressOfJournal } from './routes.js';
import type { JournalRecord } from './types.js';

/** Whether a page is one an agent writes, and so has a journal. */
export const hasJournal = (id: string): boolean => /^(product|domain):[a-z][a-z0-9-]*$/.test(id);

function pretty(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? 'null';
  } catch {
    return String(value);
  }
}

/** The response text, indented when it is JSON (it is the tool's answer as the agent read it). */
function responseText(response: string): string {
  try {
    return JSON.stringify(JSON.parse(response), null, 2);
  } catch {
    return response;
  }
}

/** A short line for a row: the first thing the arguments say. */
function glance(record: JournalRecord): string {
  const args = record.arguments;
  if (args === null || typeof args !== 'object') return '';
  const held = args as Record<string, unknown>;
  for (const key of ['key', 'path', 'text', 'kind', 'title', 'method']) if (typeof held[key] === 'string') return `${key}: ${String(held[key])}`;
  if (typeof held['markdown'] === 'string') return `${(held['markdown'] as string).split('\n').length} lines`;
  return '';
}

function clock(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toISOString().slice(11, 19);
}

function RecordRow({ record, index }: { record: JournalRecord; index: number }): ReactElement {
  const { t } = useTranslation();
  const bad = record.outcome !== 'ok';
  return (
    <li className="border-b border-line py-2 last:border-b-0" data-testid="journal-row" data-tool={record.tool} data-outcome={record.outcome} data-kind={record.kind}>
      <details>
        <summary className="flex cursor-pointer flex-wrap items-center gap-x-3 gap-y-1">
          <span className="w-6 text-right text-small text-muted" aria-hidden="true">{index + 1}</span>
          <span className="text-small text-muted">{clock(record.time)}</span>
          <code className="font-medium">{record.tool}</code>
          <Badge variant={bad ? 'solid' : 'outline'} data-testid="journal-outcome">{t(`journal.outcome.${record.outcome}`)}</Badge>
          {record.kind === 'refusal' && <Badge>{t('journal.kind.refusal')}</Badge>}
          {record.kind === 'editorial-finding' && <Badge>{t('journal.kind.editorial-finding')}</Badge>}
          {record.kind === 'revision-request' && <Badge>{t('journal.kind.revision-request')}</Badge>}
          {record.kind === 'editorial-skip' && <Badge>{t('journal.kind.editorial-skip')}</Badge>}
          {record.kind === 'editorial-warning' && <Badge>{t('journal.kind.editorial-warning')}</Badge>}
          <span className="min-w-0 max-w-full truncate text-small text-muted">{glance(record)}</span>
          <span className="ml-auto text-small text-muted">{t('journal.ms', { ms: record.durationMs })} · {t('journal.size', { size: record.responseBytes })}</span>
        </summary>
        <div className="mt-2 grid gap-3 pl-9">
          {record.reason !== null && (
            <div data-testid="journal-reason">
              <div className="text-small font-medium">{t('journal.reason')}</div>
              <pre className="journal-pre">{record.reason}</pre>
            </div>
          )}
          <div>
            <div className="text-small font-medium">{t('journal.arguments')}</div>
            <pre className="journal-pre" data-testid="journal-arguments">{pretty(record.arguments)}</pre>
          </div>
          <div>
            <div className="text-small font-medium">{t('journal.response')}</div>
            {record.response === null ? <p className="text-small text-muted">{t('journal.noResponse')}</p> : <pre className="journal-pre" data-testid="journal-response">{responseText(record.response)}</pre>}
            {record.truncated && <p className="text-small text-muted" data-testid="journal-cut">{t('journal.cut', { size: record.responseBytes })}</p>}
          </div>
        </div>
      </details>
    </li>
  );
}

function Fact({ label, value, testId }: { label: string; value: string; testId?: string }): ReactElement {
  return (
    <div className="min-w-[8rem]">
      <div className="text-small text-muted">{label}</div>
      <div className="font-medium" data-testid={testId}>{value}</div>
    </div>
  );
}

/** The journal of one page: its summary, then every record in the order the core wrote it. */
export function JournalPage({ id, run, version }: { id: string; run: string | null; version: number }): ReactElement {
  const { t } = useTranslation();
  const [onlyRefused, setOnlyRefused] = useState(false);
  const { data, error } = useRead(`journal\0${id}\0${run ?? ''}`, version, (signal) => getJournal(id, run, signal));
  useTabTitle(t('journal.title'));
  if (data === null && error === null) return <PageSkeleton testId="journal-loading" rows />;
  if (data === null) {
    return <Alert variant="problem" data-testid="journal-error"><AlertTitle>{t('journal.failed')}</AlertTitle><AlertDescription><p>{error}</p></AlertDescription></Alert>;
  }
  const calls = data.records.filter((record) => record.kind === 'tool-call');
  const refused = data.records.filter((record) => record.outcome !== 'ok');
  const spent = data.records.reduce((sum, record) => sum + record.durationMs, 0);
  const first = data.records[0];
  const shown = onlyRefused ? refused : data.records;
  return (
    <section data-testid="journal-page" data-entity={id}>
      <header className="mb-6">
        <p className="mb-2 text-small"><KLink href={addressOfEntity(id)}>{t('journal.back')}</KLink></p>
        <h1>{t('journal.title')}</h1>
        <p className="text-muted">{t('journal.intro')}</p>
      </header>
      {data.problems.length > 0 && (
        <Alert variant="problem" className="mb-4" data-testid="journal-problems">
          <AlertTitle>{t('journal.unreadable')}</AlertTitle>
          <AlertDescription><ul>{data.problems.map((problem) => <li key={problem}><code className="text-small">{problem}</code></li>)}</ul></AlertDescription>
        </Alert>
      )}
      {data.run === null || first === undefined ? <p className="text-muted" data-testid="journal-empty">{t('journal.none')}</p> : (
        <>
          <div className="mb-6 flex flex-wrap gap-x-8 gap-y-3 border-y border-line py-3" data-testid="journal-summary">
            <Fact label={t('journal.run')} value={data.run} />
            <Fact label={t('journal.agent')} value={first.agent} />
            <Fact label={t('journal.model')} value={first.model ?? t('journal.notReported')} />
            <Fact label={t('journal.session')} value={first.session ?? t('journal.notReported')} />
            <Fact label={t('journal.calls')} value={String(calls.length)} testId="journal-calls" />
            <Fact label={t('journal.refusals')} value={String(refused.length)} testId="journal-refusals" />
            <Fact label={t('journal.time')} value={t('journal.ms', { ms: spent })} />
          </div>
          {data.runs.length > 1 && (
            <p className="mb-4 text-small text-muted" data-testid="journal-runs">
              {t('journal.otherRuns')}: {data.runs.filter((other) => other !== data.run).map((other, index) => <span key={other}>{index > 0 && ', '}<KLink href={addressOfJournal(id, other)}>{other}</KLink></span>)}
            </p>
          )}
          <div className="mb-3 flex flex-wrap items-baseline gap-4">
            <h2 style={{ margin: 0 }}>{t('journal.records')}</h2>
            <label className="flex items-center gap-2 text-small">
              <input type="checkbox" checked={onlyRefused} onChange={(event) => setOnlyRefused(event.target.checked)} data-testid="journal-only-refused" />
              {t('journal.onlyRefused')}
            </label>
          </div>
          <ol style={{ listStyle: 'none', margin: 0, padding: 0 }} data-testid="journal-list">
            {shown.map((record, index) => <RecordRow key={`${record.time}\0${index}`} record={record} index={data.records.indexOf(record)} />)}
          </ol>
        </>
      )}
    </section>
  );
}
