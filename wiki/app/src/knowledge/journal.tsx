import { Checkbox } from '@/components/ui/checkbox.js';
import { OrderedList } from '@/components/ui/ordered-list.js';
import { Disclosure, DisclosureSummary } from '@/components/ui/disclosure.js';
import { InlineCode } from '@/components/ui/inline-content.js';
import { FieldLabel, ListItem, PageHeader, PageSection, PageTitle, Paragraph, PlainList, Preformatted, SectionTitle, Stack, Text } from '@/components/ui/typography.js';
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
    <ListItem className="border-b border-line py-2 last:border-b-0" data-testid="journal-row" data-tool={record.tool} data-outcome={record.outcome} data-kind={record.kind}>
      <Disclosure>
        <DisclosureSummary className="flex cursor-pointer flex-wrap items-center gap-x-3 gap-y-1">
          <Text className="w-6 text-right text-small text-muted" aria-hidden="true">{index + 1}</Text>
          <Text className="text-small text-muted">{clock(record.time)}</Text>
          <InlineCode className="font-medium">{record.tool}</InlineCode>
          <Badge variant={bad ? 'solid' : 'outline'} data-testid="journal-outcome">{t(`journal.outcome.${record.outcome}`)}</Badge>
          {record.kind === 'refusal' && <Badge>{t('journal.kind.refusal')}</Badge>}
          {record.kind === 'editorial-finding' && <Badge>{t('journal.kind.editorial-finding')}</Badge>}
          {record.kind === 'revision-request' && <Badge>{t('journal.kind.revision-request')}</Badge>}
          {record.kind === 'editorial-skip' && <Badge>{t('journal.kind.editorial-skip')}</Badge>}
          {record.kind === 'editorial-warning' && <Badge>{t('journal.kind.editorial-warning')}</Badge>}
          <Text className="min-w-0 max-w-full truncate text-small text-muted">{glance(record)}</Text>
          <Text className="ml-auto text-small text-muted">{t('journal.ms', { ms: record.durationMs })} · {t('journal.size', { count: record.responseBytes })}</Text>
        </DisclosureSummary>
        <Stack className="mt-2 grid gap-3 pl-9">
          {record.reason !== null && (
            <Stack data-testid="journal-reason">
              <Stack className="text-small font-medium">{t('journal.reason')}</Stack>
              <Preformatted className="journal-pre">{record.reason}</Preformatted>
            </Stack>
          )}
          <Stack>
            <Stack className="text-small font-medium">{t('journal.arguments')}</Stack>
            <Preformatted className="journal-pre" data-testid="journal-arguments">{pretty(record.arguments)}</Preformatted>
          </Stack>
          <Stack>
            <Stack className="text-small font-medium">{t('journal.response')}</Stack>
            {record.response === null ? <Paragraph className="text-small text-muted">{t('journal.noResponse')}</Paragraph> : <Preformatted className="journal-pre" data-testid="journal-response">{responseText(record.response)}</Preformatted>}
            {record.truncated && <Paragraph className="text-small text-muted" data-testid="journal-cut">{t('journal.cut', { count: record.responseBytes })}</Paragraph>}
          </Stack>
        </Stack>
      </Disclosure>
    </ListItem>
  );
}

function Fact({ label, value, testId }: { label: string; value: string; testId?: string }): ReactElement {
  return (
    <Stack className="min-w-32">
      <Stack className="text-small text-muted">{label}</Stack>
      <Stack className="font-medium" data-testid={testId}>{value}</Stack>
    </Stack>
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
    return <Alert variant="problem" data-testid="journal-error"><AlertTitle>{t('journal.failed')}</AlertTitle><AlertDescription><Paragraph>{error}</Paragraph></AlertDescription></Alert>;
  }
  const calls = data.records.filter((record) => record.kind === 'tool-call');
  const refused = data.records.filter((record) => record.outcome !== 'ok');
  const spent = data.records.reduce((sum, record) => sum + record.durationMs, 0);
  const first = data.records[0];
  const shown = onlyRefused ? refused : data.records;
  return (
    <PageSection data-testid="journal-page" data-entity={id}>
      <PageHeader className="mb-6">
        <Paragraph className="mb-2 text-small"><KLink href={addressOfEntity(id)}>{t('journal.back')}</KLink></Paragraph>
        <PageTitle>{t('journal.title')}</PageTitle>
        <Paragraph className="text-muted">{t('journal.intro')}</Paragraph>
      </PageHeader>
      {data.problems.length > 0 && (
        <Alert variant="problem" className="mb-4" data-testid="journal-problems">
          <AlertTitle>{t('journal.unreadable')}</AlertTitle>
          <AlertDescription><PlainList>{data.problems.map((problem) => <ListItem key={problem}><InlineCode className="text-small">{problem}</InlineCode></ListItem>)}</PlainList></AlertDescription>
        </Alert>
      )}
      {data.run === null || first === undefined ? <Paragraph className="text-muted" data-testid="journal-empty">{t('journal.none')}</Paragraph> : (
        <>
          <Stack className="mb-6 flex flex-wrap gap-x-8 gap-y-3 border-y border-line py-3" data-testid="journal-summary">
            <Fact label={t('journal.run')} value={data.run} />
            <Fact label={t('journal.agent')} value={first.agent} />
            <Fact label={t('journal.model')} value={first.model ?? t('journal.notReported')} />
            <Fact label={t('journal.session')} value={first.session ?? t('journal.notReported')} />
            <Fact label={t('journal.calls')} value={String(calls.length)} testId="journal-calls" />
            <Fact label={t('journal.refusals')} value={String(refused.length)} testId="journal-refusals" />
            <Fact label={t('journal.time')} value={t('journal.ms', { ms: spent })} />
          </Stack>
          {data.runs.length > 1 && (
            <Paragraph className="mb-4 text-small text-muted" data-testid="journal-runs">
              {t('journal.otherRuns')}: {data.runs.filter((other) => other !== data.run).map((other, index) => <Text key={other}>{index > 0 && ', '}<KLink href={addressOfJournal(id, other)}>{other}</KLink></Text>)}
            </Paragraph>
          )}
          <Stack className="mb-3 flex flex-wrap items-baseline gap-4">
            <SectionTitle className="m-0">{t('journal.records')}</SectionTitle>
            <FieldLabel className="flex items-center gap-2 text-small">
              <Checkbox checked={onlyRefused} onChange={(event) => setOnlyRefused(event.target.checked)} data-testid="journal-only-refused" />
              {t('journal.onlyRefused')}
            </FieldLabel>
          </Stack>
          <OrderedList className="m-0 list-none p-0" data-testid="journal-list">
            {shown.map((record, index) => <RecordRow key={`${record.time}\0${index}`} record={record} index={data.records.indexOf(record)} />)}
          </OrderedList>
        </>
      )}
    </PageSection>
  );
}
