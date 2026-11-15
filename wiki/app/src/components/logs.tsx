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
import { Metadata, Stack, TextLink } from './ui/typography.js';
import { logsOf, type LogEntryView, type LogsAnswer } from './logs-query.js';
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

/**
 * What an address asks the page for, from its query: the run page's journal opens the page filtered to one run, a text
 * and a level, so the row a failure names is the one the reader lands on.
 */
function askedOf(): { readonly run: string; readonly query: string; readonly level: string } {
  try {
    const query = new URLSearchParams(window.location.search);
    return { run: query.get('run') ?? '', query: query.get('q') ?? '', level: query.get('level') ?? '' };
  } catch {
    return { run: '', query: '', level: '' };
  }
}

/** One page of the logs, with the kit's viewer. */
function LogsView({ base, initialRun, open, locale, title }: { readonly base: string; readonly initialRun: string; readonly open?: (path: string) => void; readonly locale: string; readonly title: boolean }): ReactElement {
  const { t } = useTranslation();
  const [filters, setFilters] = useState<LogViewerFilters>(() => {
    const asked = askedOf();
    return { source: '', level: asked.level, run: initialRun === '' ? asked.run : initialRun, from: '', to: '', query: asked.query };
  });
  const [live, setLive] = useState(true);
  const [answer, setAnswer] = useState<LogsAnswer | null>(null);
  const [entries, setEntries] = useState<readonly LogEntryView[]>([]);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState<string | null>(null);
  const [query, setQuery] = useState(() => askedOf().query);
  // The page's own generation: a read that answers after the filters moved writes nothing (a log page is read as it is
  // now, never as it was a moment ago).
  const generation = useRef(0);
  // The text filter is typed into: its read waits for the typing to stop.
  useEffect(() => {
    const timer = setTimeout(() => { setQuery(filters.query.trim()); }, 250);
    return () => { clearTimeout(timer); };
  }, [filters.query]);
  const asked = (before?: number, after?: number): Parameters<typeof logsOf>[1] => ({
    ...(filters.source === '' ? {} : { sources: filters.source }),
    ...(filters.level === '' ? {} : { level: filters.level }),
    ...(filters.run === '' ? {} : { run: filters.run }),
    ...(query === '' ? {} : { q: query }),
    ...(momentOf(filters.from) === undefined ? {} : { from: momentOf(filters.from) }),
    ...(momentOf(filters.to) === undefined ? {} : { before: momentOf(filters.to) }),
    ...(before === undefined ? {} : { before }),
    ...(after === undefined ? {} : { from: after }),
    limit: PAGE,
  });
  // The filters moved: the list starts again from the newest page.
  useEffect(() => {
    const mine = generation.current += 1;
    setLoading(true);
    setFailure(null);
    const controller = new AbortController();
    logsOf(base, asked(), controller.signal).then(
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
      logsOf(base, asked(undefined, newest), controller.signal).then(
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
    logsOf(base, asked(first.at)).then(
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
    context: t('logs.filters.context'), details: t('logs.filters.details'), quoted: t('logs.quoted'),
    dateTime: {
      none: t('logs.dateTime.none'), title: t('logs.dateTime.title'), clear: t('logs.dateTime.clear'), done: t('logs.dateTime.done'),
      hour: t('logs.dateTime.hour'), minute: t('logs.dateTime.minute'), second: t('logs.dateTime.second'),
      previous: t('logs.dateTime.previous'), next: t('logs.dateTime.next'), close: t('logs.dateTime.close'),
    },
    levels: { debug: t('logs.level.debug'), info: t('logs.level.info'), warn: t('logs.level.warn'), error: t('logs.level.error') },
  };
  const view = (entry: LogEntryView): LogViewerEntry => {
    // The engine sends an event's code and its arguments: the page words it. Any other text — a plugin's standard
    // error, the store's log, an engine message no locale covers — stands as it was written and is drawn as a quotation.
    const worded = entry.code == null ? '' : t(`logs.event.${entry.code}`, { ...entry.arguments, defaultValue: '' });
    return {
      id: entry.id,
      at: entry.at === null ? null : new Date(entry.at).toISOString(),
      level: entry.level,
      source: t(`logs.source.${entry.source}`, { defaultValue: entry.source }),
      run: entry.run,
      unit: entry.unit,
      message: worded === '' ? entry.message : worded,
      ...(worded === '' || worded === entry.message ? {} : { raw: entry.message }),
      quoted: entry.quoted === true,
      detail: entry.detail,
      fields: {
        ...(entry.file === null ? {} : { file: entry.line === null ? entry.file : `${entry.file}:${String(entry.line)}` }),
        ...(entry.path === null ? {} : { path: entry.path }),
        ...(entry.cut ? { cut: t('logs.cut') } : {}),
        ...entry.fields,
      },
    };
  };
  const sources = (answer?.sources ?? []).map((source) => ({ value: source, label: t(`logs.source.${source}`, { defaultValue: source }) }));
  const runs = (answer?.runs ?? []).map((run) => ({ value: run, label: run }));
  const shown = answer === null ? 0 : entries.length;
  return (
    <Stack layout="page" data-testid="logs-page">
      <Card>
        {title ? <CardHeader><CardTitle>{t('logs.title')}</CardTitle></CardHeader> : null}
        <CardContent>
          <Metadata>{t('logs.intro')}</Metadata>
          {failure === null ? null : <Alert variant="problem" data-testid="logs-failure"><AlertDescription>{t('logs.readFailed', { message: failure })}</AlertDescription></Alert>}
          {filters.run === '' ? null : <Metadata data-testid="logs-run-link"><TextLink href={base + runAddress(filters.run)} onClick={(event) => {
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
            locale={locale}
          />
        </CardContent>
      </Card>
    </Stack>
  );
}

/** The reader's language, as the page draws its own words and its moments in it. */
function languageOf(given: string | undefined, resolved: string | undefined): string {
  if (given !== undefined && given !== '') return given;
  return (resolved ?? 'en').startsWith('ru') ? 'ru' : 'en';
}

/** The Logs page as a product template (`/p/logs`). The address's `run` binds the page's own variable. */
export function LogsSection({ context }: { readonly context: SectionContext }): ReactElement {
  const { i18n } = useTranslation();
  const bound = context.variables['run'];
  return <LogsView base={context.base} initialRun={typeof bound === 'string' ? bound : askedOf().run} open={context.open} locale={languageOf(context.language, i18n.resolvedLanguage)} title={false} />;
}

/** The Logs page as the frame's own page, for a product whose files hold no `logs` template yet. */
export function LogsPage({ base }: { readonly base: string }): ReactElement {
  const { i18n } = useTranslation();
  return <LogsView base={base} initialRun={askedOf().run} locale={languageOf(undefined, i18n.resolvedLanguage)} title />;
}
