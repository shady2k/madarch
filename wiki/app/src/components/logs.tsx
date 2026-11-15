/**
 * The Logs page (madarch-64o5.88, part 3): every log madarch keeps for this product, read through one route with paging,
 * filters and a live tail, drawn by the kit's log viewer. Nothing here is graph data: the page reads `/api/logs`, and
 * its entries are the machine's evidence — a record's message, its place and its stack — in the reader's language for
 * the page's own words only, never for the logs' messages.
 */
import { useEffect, useRef, useState, type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, AlertDescription } from './ui/alert.js';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card.js';
import { LogViewer, type LogViewerEntry, type LogViewerFilters, type LogViewerLabels } from './ui/log-viewer.js';
import { Metadata, Paragraph, Stack, TextLink } from './ui/typography.js';
import { readLogs, type LogEntryView, type LogsAnswer } from './command.js';
import { runAddress } from '../address.js';
import type { SectionContext } from './types.js';

/** How often a live page reads again: one second, as the run page's own clock. */
const TAIL_MS = 1_000;
/** How many entries one page asks for. */
const PAGE = 200;

/** The moment a `datetime-local` value names, in epoch milliseconds. */
function momentOf(value: string): number | undefined {
  if (value === '') return undefined;
  const at = Date.parse(value);
  return Number.isFinite(at) ? at : undefined;
}

/** The run an address names, from its query: the run page's link opens this page filtered to one run. */
function runOf(): string {
  try { return new URLSearchParams(window.location.search).get('run') ?? ''; } catch { return ''; }
}

/** One page of the logs, with the kit's viewer. */
function LogsView({ base, initialRun, open }: { readonly base: string; readonly initialRun: string; readonly open?: (path: string) => void }): ReactElement {
  const { t } = useTranslation();
  const [filters, setFilters] = useState<LogViewerFilters>({ source: '', level: '', run: initialRun, from: '', to: '', query: '' });
  const [live, setLive] = useState(true);
  const [answer, setAnswer] = useState<LogsAnswer | null>(null);
  const [entries, setEntries] = useState<readonly LogEntryView[]>([]);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  // The page's own generation: a read that answers after the filters moved writes nothing (a log page is read as it is
  // now, never as it was a moment ago).
  const generation = useRef(0);
  // The text filter is typed into: its read waits for the typing to stop.
  useEffect(() => {
    const timer = setTimeout(() => { setQuery(filters.query.trim()); }, 250);
    return () => { clearTimeout(timer); };
  }, [filters.query]);
  const asked = (before?: number, since?: number): Parameters<typeof readLogs>[1] => ({
    ...(filters.source === '' ? {} : { sources: filters.source }),
    ...(filters.level === '' ? {} : { level: filters.level }),
    ...(filters.run === '' ? {} : { run: filters.run }),
    ...(query === '' ? {} : { q: query }),
    ...(momentOf(filters.from) === undefined ? {} : { since: momentOf(filters.from) }),
    ...(momentOf(filters.to) === undefined ? {} : { before: momentOf(filters.to) }),
    ...(before === undefined ? {} : { before }),
    ...(since === undefined ? {} : { since }),
    limit: PAGE,
  });
  // The filters moved: the list starts again from the newest page.
  useEffect(() => {
    const mine = generation.current += 1;
    setLoading(true);
    setFailure(null);
    const controller = new AbortController();
    readLogs(base, asked(), controller.signal).then(
      (held) => { if (generation.current === mine) { setAnswer(held); setEntries(held.entries); setLoading(false); } },
      (error: unknown) => { if (generation.current === mine) { setFailure(error instanceof Error ? error.message : String(error)); setLoading(false); } },
    );
    return () => { controller.abort(); };
  }, [base, filters.source, filters.level, filters.run, filters.from, filters.to, query]);
  // The live tail: the entries after the newest one this page holds are asked for each second and added to its end.
  useEffect(() => {
    if (!live) return;
    const controller = new AbortController();
    const timer = setInterval(() => {
      const newest = entries.reduce<number | undefined>((held, entry) => (entry.at === null ? held : held === undefined || entry.at > held ? entry.at : held), undefined);
      if (newest === undefined) return;
      const mine = generation.current;
      readLogs(base, asked(undefined, newest), controller.signal).then(
        (held) => {
          if (generation.current !== mine || held.entries.length === 0) return;
          setEntries((current) => {
            const known = new Set(current.map((entry) => entry.id));
            return [...current, ...held.entries.filter((entry) => !known.has(entry.id))];
          });
          setAnswer((current) => (current === null ? held : { ...current, scanned: held.scanned, truncated: held.truncated, more: current.more }));
        },
        () => undefined,
      );
    }, TAIL_MS);
    return () => { clearInterval(timer); controller.abort(); };
  }, [live, base, filters.source, filters.level, filters.run, filters.from, filters.to, query, entries.length]);
  const older = (): void => {
    const first = entries.find((entry) => entry.at !== null);
    if (first?.at === null || first?.at === undefined) return;
    const mine = generation.current;
    setLoading(true);
    readLogs(base, asked(first.at)).then(
      (held) => {
        if (generation.current !== mine) return;
        setEntries((current) => {
          const known = new Set(current.map((entry) => entry.id));
          return [...held.entries.filter((entry) => !known.has(entry.id)), ...current];
        });
        setAnswer((current) => (current === null ? held : { ...current, more: held.more, scanned: current.scanned + held.scanned, truncated: current.truncated || held.truncated }));
        setLoading(false);
      },
      (error: unknown) => { if (generation.current === mine) { setFailure(error instanceof Error ? error.message : String(error)); setLoading(false); } },
    );
  };
  const labels: LogViewerLabels = {
    source: t('logs.filters.source'), level: t('logs.filters.level'), run: t('logs.filters.run'),
    from: t('logs.filters.from'), to: t('logs.filters.to'), search: t('logs.filters.search'), all: t('logs.filters.all'),
    older: t('logs.filters.older'), empty: t('logs.empty'), loading: t('logs.loading'),
    follow: t('logs.filters.follow'), pause: t('logs.filters.pause'), copy: t('logs.filters.copy'), copied: t('logs.filters.copied'),
    context: t('logs.filters.context'), details: t('logs.filters.details'),
    levels: { debug: t('logs.level.debug'), info: t('logs.level.info'), warn: t('logs.level.warn'), error: t('logs.level.error') },
  };
  const view = (entry: LogEntryView): LogViewerEntry => ({
    id: entry.id,
    at: entry.at === null ? null : new Date(entry.at).toISOString(),
    level: entry.level,
    source: t(`logs.source.${entry.source}`, { defaultValue: entry.source }),
    run: entry.run,
    unit: entry.unit,
    message: entry.message,
    detail: entry.detail,
    fields: {
      ...(entry.file === null ? {} : { file: entry.line === null ? entry.file : `${entry.file}:${String(entry.line)}` }),
      ...(entry.path === null ? {} : { path: entry.path }),
      ...(entry.cut ? { cut: t('logs.cut') } : {}),
      ...entry.fields,
    },
  });
  const sources = (answer?.sources ?? []).map((source) => ({ value: source, label: t(`logs.source.${source}`, { defaultValue: source }) }));
  const runs = (answer?.runs ?? []).map((run) => ({ value: run, label: run }));
  const shown = answer === null ? 0 : entries.length;
  return (
    <Stack className="grid gap-4" data-testid="logs-page">
      <Card>
        <CardHeader><CardTitle>{t('logs.title')}</CardTitle></CardHeader>
        <CardContent>
          <Paragraph className="m-0 text-small text-muted">{t('logs.intro')}</Paragraph>
          {failure === null ? null : <Alert variant="problem" className="mt-2" data-testid="logs-failure"><AlertDescription>{t('logs.readFailed', { message: failure })}</AlertDescription></Alert>}
          {filters.run === '' ? null : <Metadata className="mt-2 block" data-testid="logs-run-link"><TextLink href={base + runAddress(filters.run)} onClick={(event) => {
            event.preventDefault();
            if (open === undefined) window.location.assign(base + runAddress(filters.run));
            else open(runAddress(filters.run));
          }}>{t('logs.openRun')}</TextLink></Metadata>}
          <LogViewer
            entries={entries.map(view)}
            filters={filters}
            onFilters={setFilters}
            sources={sources}
            runs={runs}
            labels={labels}
            live={live}
            onLive={setLive}
            loading={loading}
            more={answer?.more === true}
            onOlder={older}
            summary={`${t('logs.summary', { shown, scanned: answer?.scanned ?? 0 })}${answer?.truncated === true ? ` · ${t('logs.truncated')}` : ''}`}
          />
        </CardContent>
      </Card>
    </Stack>
  );
}

/** The Logs page as a product template (`/p/logs`). The address's `run` binds the page's own variable. */
export function LogsSection({ context }: { readonly context: SectionContext }): ReactElement {
  const bound = context.variables['run'];
  return <LogsView base={context.base} initialRun={typeof bound === 'string' ? bound : runOf()} open={context.open} />;
}

/** The Logs page as the frame's own page, for a product whose files hold no `logs` template yet. */
export function LogsPage({ base }: { readonly base: string }): ReactElement {
  return <LogsView base={base} initialRun={runOf()} />;
}
