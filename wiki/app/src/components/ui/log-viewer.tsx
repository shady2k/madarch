/**
 * The log viewer (madarch-64o5.88, decision 0020): rows of time, level, source and message from a log, in the kit's
 * own parts — a level marker, monospace technical text, filters, a text search with highlights, a live tail with its
 * pause, copy, and a detail area for an error's whole text, its stack and its context. The list is virtualised: the
 * rows outside the viewport are not drawn, so a log of many thousands of rows scrolls as one page does.
 *
 * The words are the caller's (`labels`), so the component is the kit's and the pages keep the reader's language; the
 * entries are the caller's too — a page reads them from its own API and hands the component what it shows.
 */
import { Fragment, useEffect, useRef, useState, type ReactElement } from 'react';
import { CopyIcon, PauseIcon, PlayIcon } from 'lucide-react';
import { Badge } from './badge.js';
import { Button } from './button.js';
import { FilterBar, FilterField } from './filter-bar.js';
import { Input } from './input.js';
import { Select } from './select.js';
import { Skeleton } from './skeleton.js';
import { TechnicalText } from './technical-text.js';
import { Toggle } from './toggle.js';
import { DefinitionList, DefinitionTerm, DefinitionValue, Metadata, Paragraph, Stack } from './typography.js';

/** One entry the viewer draws, as a page reads it from its log: the levels, where it happened and its own words. */
export interface LogViewerEntry {
  readonly id: string;
  /** The moment, ISO 8601, or null for a log whose writer kept no time. */
  readonly at: string | null;
  readonly level: 'debug' | 'info' | 'warn' | 'error';
  /** The log's name, in the reader's language. */
  readonly source: string;
  readonly run: string | null;
  readonly unit: string | null;
  readonly message: string;
  /** The whole text: a stack, a plugin's raw output, an answer. */
  readonly detail: string | null;
  /** The entry's own context, already free of secrets. */
  readonly fields?: Readonly<Record<string, string>>;
}

/** What the viewer's filters ask for; the page answers them by reading again. */
export interface LogViewerFilters {
  readonly source: string;
  readonly level: string;
  readonly run: string;
  readonly from: string;
  readonly to: string;
  readonly query: string;
}

/** The words the viewer draws. */
export interface LogViewerLabels {
  readonly source: string;
  readonly level: string;
  readonly run: string;
  readonly from: string;
  readonly to: string;
  readonly search: string;
  readonly all: string;
  readonly older: string;
  readonly empty: string;
  readonly loading: string;
  readonly follow: string;
  readonly pause: string;
  readonly copy: string;
  readonly copied: string;
  readonly context: string;
  readonly details: string;
  readonly levels: Readonly<Record<LogViewerEntry['level'], string>>;
}

export interface LogViewerProps {
  readonly entries: readonly LogViewerEntry[];
  readonly filters: LogViewerFilters;
  readonly onFilters: (filters: LogViewerFilters) => void;
  readonly sources: readonly { readonly value: string; readonly label: string }[];
  readonly runs: readonly { readonly value: string; readonly label: string }[];
  readonly labels: LogViewerLabels;
  /** Whether the list follows its end as the log grows. */
  readonly live: boolean;
  readonly onLive: (live: boolean) => void;
  readonly loading?: boolean;
  /** Whether entries older than the list stand behind it. */
  readonly more?: boolean;
  readonly onOlder?: () => void;
  /** A sentence about what stands in the list and what the read kept, in the reader's language. */
  readonly summary?: string;
  /** The list's height in pixels: a log keeps its own scroll, never the page's. */
  readonly height?: number;
  /** The entry drawn open, for a page that shows a state without a reader's click. */
  readonly initialSelectedId?: string;
}

/** One row's height: the virtual list draws whole rows only, so a row is one line. */
const ROW_HEIGHT = 26;
/** How many rows beyond the viewport are drawn, so a fast scroll is filled before it is seen. */
const OVERSCAN = 10;

/** The level's marker: the level's word in a badge, filled for an error and outlined for the rest. */
function levelBadge(level: LogViewerEntry['level'], word: string): ReactElement {
  const variant = level === 'error' ? 'solid' : 'outline';
  return <Badge variant={variant} data-level={level} data-testid="log-level">{word}</Badge>;
}

/** The time of one entry, to the millisecond when it is known. */
function timeOf(at: string | null): string {
  if (at === null) return '—';
  const held = new Date(at);
  return `${held.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}.${String(held.getMilliseconds()).padStart(3, '0')}`;
}

/** The text around a search's matches: the matches are drawn as `<mark>`, everything else as it stands. */
function highlighted(text: string, query: string): ReactElement {
  const needle = query.trim().toLowerCase();
  if (needle === '') return <>{text}</>;
  const out: ReactElement[] = [];
  let at = 0;
  for (;;) {
    const found = text.toLowerCase().indexOf(needle, at);
    if (found < 0) break;
    if (found > at) out.push(<span key={`text-${String(at)}`}>{text.slice(at, found)}</span>);
    out.push(<mark key={`mark-${String(found)}`} className="bg-[var(--surface-active)] text-ink">{text.slice(found, found + needle.length)}</mark>);
    at = found + needle.length;
  }
  if (out.length === 0) return <>{text}</>;
  if (at < text.length) out.push(<span key={`text-${String(at)}`}>{text.slice(at)}</span>);
  return <>{out}</>;
}

/** The whole row as one text, for the copy control: its time, its level, its source and its words, then its detail. */
export function logRowText(entry: LogViewerEntry, level: string): string {
  const head = `${timeOf(entry.at)} ${level} ${entry.source}${entry.unit === null ? '' : ` ${entry.unit}`}: ${entry.message}`;
  return entry.detail === null ? head : `${head}\n${entry.detail}`;
}

/** Copies a text, answering whether the clipboard took it; a browser without the API falls back to a selection. */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const area = document.createElement('textarea');
      area.value = text;
      area.setAttribute('readonly', '');
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.append(area);
      area.select();
      const copied = document.execCommand('copy');
      area.remove();
      return copied;
    } catch {
      return false;
    }
  }
}

export function LogViewer({ entries, filters, onFilters, sources, runs, labels, live, onLive, loading = false, more = false, onOlder, summary, height = 360, initialSelectedId }: LogViewerProps): ReactElement {
  const list = useRef<HTMLDivElement | null>(null);
  const [top, setTop] = useState(0);
  const [selected, setSelected] = useState<string | null>(initialSelectedId ?? null);
  const [copied, setCopied] = useState<string | null>(null);
  const change = (part: keyof LogViewerFilters, value: string): void => { onFilters({ ...filters, [part]: value }); };
  const shown = entries.find((entry) => entry.id === selected) ?? null;
  // A live list stands at its end: the newest line is the one a reader follows. Scrolling up is the reader's own, and
  // the pause stops the list from moving under them.
  useEffect(() => {
    if (!live || list.current === null) return;
    list.current.scrollTop = list.current.scrollHeight;
    setTop(list.current.scrollTop);
  }, [entries, live]);
  const first = Math.max(0, Math.floor(top / ROW_HEIGHT) - OVERSCAN);
  const visible = Math.ceil(height / ROW_HEIGHT) + OVERSCAN * 2;
  const rows = entries.slice(first, first + visible);
  const copy = async (entry: LogViewerEntry): Promise<void> => {
    const took = await copyText(logRowText(entry, labels.levels[entry.level]));
    setCopied(took ? entry.id : null);
    if (took) setTimeout(() => { setCopied(null); }, 1_500);
  };
  return (
    <Stack className="grid gap-2" data-testid="log-viewer" data-live={live ? 'true' : 'false'}>
      <FilterBar data-testid="log-filters">
        <FilterField>{labels.source}
          <Select aria-label={labels.source} value={filters.source} onChange={(event) => { change('source', event.target.value); }} options={[{ value: '', label: labels.all }, ...sources]} />
        </FilterField>
        <FilterField>{labels.level}
          <Select aria-label={labels.level} value={filters.level} onChange={(event) => { change('level', event.target.value); }} options={[{ value: '', label: labels.all }, ...(['error', 'warn', 'info', 'debug'] as const).map((level) => ({ value: level, label: labels.levels[level] }))]} />
        </FilterField>
        <FilterField>{labels.run}
          <Select aria-label={labels.run} value={filters.run} onChange={(event) => { change('run', event.target.value); }} options={[{ value: '', label: labels.all }, ...runs]} />
        </FilterField>
        <FilterField>{labels.from}
          <Input type="datetime-local" aria-label={labels.from} value={filters.from} onInput={(event) => { change('from', event.currentTarget.value); }} />
        </FilterField>
        <FilterField>{labels.to}
          <Input type="datetime-local" aria-label={labels.to} value={filters.to} onInput={(event) => { change('to', event.currentTarget.value); }} />
        </FilterField>
        <FilterField>{labels.search}
          <Input type="search" aria-label={labels.search} value={filters.query} onInput={(event) => { change('query', event.currentTarget.value); }} />
        </FilterField>
        <Toggle pressed={live} onPressedChange={onLive} aria-label={live ? labels.pause : labels.follow} data-testid="log-follow" className="h-9 gap-1.5 px-3 text-small">
          {live ? <><PauseIcon aria-hidden="true" size={14} />{labels.pause}</> : <><PlayIcon aria-hidden="true" size={14} />{labels.follow}</>}
        </Toggle>
      </FilterBar>
      {summary === undefined ? null : <Metadata data-testid="log-summary">{summary}</Metadata>}
      {more && onOlder !== undefined ? <Stack><Button size="sm" variant="default" onClick={onOlder} data-testid="log-older">{labels.older}</Button></Stack> : null}
      <div
        ref={list}
        data-testid="log-rows"
        role="list"
        aria-label={labels.details}
        className="overflow-auto rounded-[var(--radius-code)] border border-line bg-[var(--surface-code)]"
        style={{ height: `${String(height)}px` }}
        onScroll={(event) => { setTop(event.currentTarget.scrollTop); }}
      >
        {loading && entries.length === 0 ? (
          <Stack className="grid gap-1 p-2" data-testid="log-loading" aria-busy="true"><Metadata>{labels.loading}</Metadata>{[0, 1, 2, 3, 4, 5].map((row) => <Skeleton key={row} className="h-4 w-full" />)}</Stack>
        ) : entries.length === 0 ? (
          <Paragraph className="m-0 p-3 text-small text-muted" data-testid="log-empty">{labels.empty}</Paragraph>
        ) : (
          <div style={{ height: `${String(entries.length * ROW_HEIGHT)}px`, position: 'relative' }}>
            <div style={{ position: 'absolute', insetInline: 0, top: `${String(first * ROW_HEIGHT)}px` }} data-testid="log-window">
              {rows.map((entry) => {
                const active = entry.id === selected;
                return (
                  <div
                    key={entry.id}
                    role="listitem"
                    tabIndex={0}
                    data-testid="log-row"
                    data-level={entry.level}
                    data-active={active ? 'true' : 'false'}
                    onClick={() => { setSelected(active ? null : entry.id); }}
                    onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setSelected(active ? null : entry.id); } }}
                    className={`group flex h-[26px] cursor-pointer items-center gap-2 px-2 font-mono text-[0.8125rem] leading-6 ${active ? 'bg-[var(--surface-active)]' : 'hover:bg-[var(--surface-hover)]'}`}
                  >
                    <Metadata className="w-[86px] shrink-0 font-mono tabular-nums">{timeOf(entry.at)}</Metadata>
                    {levelBadge(entry.level, labels.levels[entry.level])}
                    <Metadata className="w-[92px] shrink-0 truncate">{entry.source}</Metadata>
                    {entry.unit === null ? null : <Metadata className="w-[120px] shrink-0 truncate">{entry.unit}</Metadata>}
                    <span className="min-w-0 flex-1 truncate" data-testid="log-message">{highlighted(entry.message, filters.query)}</span>
                    <Button size="icon-sm" variant="ghost" aria-label={labels.copy} data-testid="log-copy" onClick={(event) => { event.stopPropagation(); void copy(entry); }}>
                      <CopyIcon aria-hidden="true" size={13} />
                    </Button>
                    {copied === entry.id ? <Metadata data-testid="log-copied">{labels.copied}</Metadata> : null}
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
      {shown === null ? null : (
        <Stack className="grid gap-1 rounded-[var(--radius-code)] border border-line p-3" data-testid="log-detail">
          <Stack className="flex items-center justify-between gap-2">
            <Metadata>{timeOf(shown.at)} · {labels.levels[shown.level]} · {shown.source}{shown.run === null ? '' : ` · ${shown.run}`}{shown.unit === null ? '' : ` · ${shown.unit}`}</Metadata>
            <Button size="icon-sm" variant="ghost" aria-label={labels.copy} data-testid="log-detail-copy" onClick={() => { const picked = window.getSelection()?.toString().trim() ?? ''; void copyText(picked === '' ? logRowText(shown, labels.levels[shown.level]) : picked); }}>
              <CopyIcon aria-hidden="true" size={13} />
            </Button>
          </Stack>
          <TechnicalText className="m-0 max-h-40 overflow-auto whitespace-pre-wrap break-all" data-testid="log-detail-message">{shown.message}</TechnicalText>
          {shown.detail === null ? null : <TechnicalText className="m-0 max-h-56 overflow-auto whitespace-pre-wrap break-all" data-testid="log-detail-raw">{shown.detail}</TechnicalText>}
          {shown.fields === undefined || Object.keys(shown.fields).length === 0 ? null : (
            <Stack className="grid gap-1" data-testid="log-detail-context">
              <Metadata>{labels.context}</Metadata>
              <DefinitionList columns>
                {Object.keys(shown.fields).sort((left, right) => (left < right ? -1 : left > right ? 1 : 0)).map((key) => (
                  <Fragment key={key}><DefinitionTerm>{key}</DefinitionTerm><DefinitionValue>{shown.fields![key]}</DefinitionValue></Fragment>
                ))}
              </DefinitionList>
            </Stack>
          )}
        </Stack>
      )}
    </Stack>
  );
}
