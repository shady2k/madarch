/**
 * A file's text (madarch-u3vw.16, decision 0037): the page asks for line ranges, and the server answers them by the blob
 * id the graph holds — read from git's object store through the git plugin, never from a working copy. A Markdown file
 * opens rendered by the same component the Sources page draws documents with, with a Rendered / Source switch the reader
 * keeps; every other text file opens as source with line numbers, a soft-wrap switch and the page's full width, loaded in
 * ranges as the reader scrolls, with the whole file one press away.
 *
 * The ranges are pinned to one revision (the owner's review of madarch-u3vw.16): the first answer names the blob, every
 * later request names it too, and an answer from another blob restarts the view and says so. A range the server cut at its
 * byte bound says where it continues, and the page asks from there; nothing is dropped silently. The loaded text belongs
 * to the file it was read for: navigating to another file starts the view again.
 */
import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from './ui/button.js';
import { InlineGroup, Metadata, Paragraph, Stack } from './ui/typography.js';
import { SegmentedChoice } from './ui/segmented-choice.js';
import { FileSource } from './ui/drawing.js';
import { postQuery } from '../client.js';
import { grammarOf, highlightLines, plainLines, type HighlightedLine } from './file-highlight.js';
import { at, localized } from './format.js';
import { TextSection } from './text.js';
import type { SectionContext } from './types.js';

/** The view a Markdown file opens in, kept per reader. */
const VIEW_KEY = 'madarch-file-text-view';
/** The most lines a range asks for. */
const FIRST_LINES = 400;

function storedView(): 'rendered' | 'source' {
  try {
    const held = window.localStorage.getItem(VIEW_KEY);
    return held === 'source' ? 'source' : 'rendered';
  } catch {
    return 'rendered';
  }
}

/** The text of one file as the graph answers it (decision 0037): the lines asked for, and the blob they stand on. */
interface FileTextAnswer {
  readonly text: string;
  readonly lines: number;
  readonly bytes: number;
  readonly binary: boolean;
  readonly blob: string;
  readonly from: number;
  readonly language?: string;
  readonly complete: boolean;
  readonly moved?: boolean;
  readonly next: { readonly line: number; readonly column: number } | null;
}

/** One file's text, asked of the graph: a page's data is read through the one read API. */
const SOURCE_QUERY = `query Source($repository: String!, $path: String!, $from: Int, $to: Int, $fromColumn: Int, $blob: String) {
  source(repository: $repository, path: $path, from: $from, to: $to, fromColumn: $fromColumn, blob: $blob) {
    text lines bytes binary blob from language complete moved next { line column }
  }
}`;

async function sourceText(base: string, ask: { readonly repository: string; readonly path: string; readonly from: number; readonly to?: number; readonly fromColumn?: number; readonly blob?: string }): Promise<FileTextAnswer> {
  const answer = await postQuery<{ source: FileTextAnswer | null }>(base, SOURCE_QUERY, {
    repository: ask.repository, path: ask.path, from: ask.from,
    ...(ask.to === undefined ? {} : { to: ask.to }),
    ...(ask.fromColumn === undefined ? {} : { fromColumn: ask.fromColumn }),
    ...(ask.blob === undefined ? {} : { blob: ask.blob }),
  });
  if (answer.offline === true) throw new Error('offline');
  const held = answer.errors[0]?.message;
  if (held !== undefined) throw new Error(held);
  if (answer.data?.source == null) throw new Error('the graph holds no text of this file');
  return answer.data.source;
}

/** Whether a path names a Markdown file: its own suffix, never a pattern over the whole path. */
const isMarkdown = (path: string): boolean => ['.md', '.markdown', '.mdx'].some((suffix) => path.toLowerCase().endsWith(suffix));

/** Where the next range continues: a line, and inside it a column when a line was cut at the byte bound. */
interface Cursor {
  readonly line: number;
  readonly column: number;
}

export function FileTextSection({ context }: { readonly context: SectionContext }): ReactElement {
  const { t } = useTranslation();
  const repository = at(context.data, context.section.params['repositoryPath']);
  const path = at(context.data, context.section.params['pathPath']);
  // The graph's language decides the grammar; a file the graph names no language for falls back to its path's extension.
  const graphLanguage = at(context.data, context.section.params['languagePath']);
  const chunk = typeof context.section.params['chunk'] === 'number' ? context.section.params['chunk'] : FIRST_LINES;
  const [answer, setAnswer] = useState<FileTextAnswer | null>(null);
  const [lines, setLines] = useState<readonly HighlightedLine[]>([]);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [moved, setMoved] = useState(false);
  const [view, setView] = useState<'rendered' | 'source'>(storedView);
  const [wrap, setWrap] = useState(true);
  const box = useRef<HTMLDivElement | null>(null);
  /** The text loaded so far, as the server answered it: ranges continue exactly where the last one stopped. */
  const loaded = useRef('');
  /** The blob the view is pinned to: the first answer names it, and every later request names it too. */
  const blob = useRef<string | null>(null);
  /** Where the next range continues, or null when the blob is loaded to its end. */
  const cursor = useRef<Cursor | null>(null);
  /** The load in flight, so a scroll never asks twice for the same range. */
  const inFlight = useRef(false);
  /** A generation of one file's view: a highlight that answers for an older one does not replace the lines. */
  const generation = useRef(0);
  const markdown = typeof path === 'string' && isMarkdown(path);

  const reset = useCallback((): void => {
    generation.current += 1;
    loaded.current = '';
    blob.current = null;
    cursor.current = null;
    inFlight.current = false;
    setAnswer(null);
    setLines([]);
    setFailure(null);
    setMoved(false);
  }, []);

  const load = useCallback(async (from: number, column: number, restart: boolean): Promise<void> => {
    if (typeof repository !== 'string' || typeof path !== 'string') return;
    if (inFlight.current) return;
    inFlight.current = true;
    const view_ = generation.current;
    setBusy(true);
    try {
      const held = await sourceText(context.base, {
        repository, path, from, fromColumn: column === 1 ? undefined : column, to: from + chunk - 1,
        ...(blob.current === null ? {} : { blob: blob.current }),
      });
      if (view_ !== generation.current) return;
      // A cut range names where it continues; a whole range ends the blob.
      const cut = held.complete === false && held.next !== null && held.next !== undefined ? held.next : null;
      const starts = restart || held.moved === true || held.from === 1;
      loaded.current = starts ? held.text : loaded.current + held.text;
      blob.current = held.blob;
      cursor.current = cut;
      setAnswer(held);
      setMoved(held.moved === true);
      setFailure(null);
      // The lines stand at once, plain; the highlighter's tokens replace the whole view when it has answered.
      setLines(plainLines(loaded.current));
      const language = grammarOf(typeof graphLanguage === 'string' ? graphLanguage : held.language, path);
      const highlighted = await highlightLines(loaded.current, language);
      if (view_ !== generation.current) return;
      setLines(highlighted);
    } catch (error) {
      if (view_ !== generation.current) return;
      setFailure(error instanceof Error ? error.message : String(error));
      cursor.current = null;
    } finally {
      if (view_ === generation.current) { inFlight.current = false; setBusy(false); }
    }
  }, [context.base, repository, path, chunk, graphLanguage]);

  // The view belongs to one file: another file of the same page starts at its first range, with nothing of the old one.
  useEffect(() => {
    reset();
    void load(1, 1, true);
  }, [load, reset]);

  // A reader who scrolls near the end of what is loaded asks for the next range: the page never asks for a whole file.
  const more = (): void => {
    const next = cursor.current;
    if (next === null || busy) return;
    void load(next.line, next.column, false);
  };

  if (typeof repository !== 'string' || typeof path !== 'string') {
    return <Paragraph data-testid="file-text-unaddressed">{t('knowledge.fileText.unaddressed')}</Paragraph>;
  }
  if (failure !== null) {
    return <Paragraph role="alert" data-testid="file-text-error">{failure}</Paragraph>;
  }
  if (answer === null) return <Metadata data-testid="file-text-loading">{t('knowledge.fileText.loading')}</Metadata>;
  if (answer.binary) {
    return <Paragraph data-testid="file-text-binary">{t('knowledge.fileText.binary', { path, bytes: new Intl.NumberFormat(context.language).format(answer.bytes) })}</Paragraph>;
  }
  const download = async (): Promise<void> => {
    // The whole file is one press away, read in the same bounded ranges rather than one unbounded answer.
    let text = '';
    let from = 1;
    let column: number | undefined;
    for (;;) {
      const held = await sourceText(context.base, { repository, path, from, ...(column === undefined ? {} : { fromColumn: column }) });
      text += held.text;
      if (held.complete !== false || held.next === null || held.next === undefined) break;
      from = held.next.line;
      column = held.next.column === 1 ? undefined : held.next.column;
    }
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = path.split('/').at(-1) ?? 'file.txt';
    anchor.click();
    URL.revokeObjectURL(url);
  };
  return (
    <Stack layout="text" data-testid="file-text">
      <InlineGroup>
        {markdown ? (
          <SegmentedChoice
            label={t('knowledge.fileText.view')}
            testId="file-text-view"
            value={view}
            options={[{ value: 'rendered', label: t('knowledge.fileText.rendered'), testId: 'file-text-view-rendered' }, { value: 'source', label: t('knowledge.fileText.source'), testId: 'file-text-view-source' }]}
            onChange={(next) => { const held = next === 'source' ? 'source' : 'rendered'; setView(held); try { window.localStorage.setItem(VIEW_KEY, held); } catch { /* no storage */ } }}
          />
        ) : null}
        <Button variant="default" size="sm" onClick={() => setWrap(!wrap)} data-testid="file-text-wrap">{t(wrap ? 'knowledge.fileText.noWrap' : 'knowledge.fileText.wrap')}</Button>
        <Button variant="default" size="sm" onClick={() => void download()} data-testid="file-text-download">{t('knowledge.fileText.download')}</Button>
        <Metadata data-testid="file-text-count">{t('knowledge.fileText.count', { shown: new Intl.NumberFormat(context.language).format(lines.length), total: new Intl.NumberFormat(context.language).format(answer.lines) })}</Metadata>
      </InlineGroup>
      {moved ? <Metadata data-testid="file-text-moved">{t('knowledge.fileText.moved')}</Metadata> : null}
      {markdown && view === 'rendered' ? (
        <Stack data-testid="file-text-rendered">
          {/* The very component the Sources page draws a document with, fed the file's text (madarch-u3vw.16). */}
          <TextSection context={{ ...context, data: { text: answer.text }, section: { ...context.section, params: { path: 'text' } } }} />
        </Stack>
      ) : (
        <FileSource
          ref={box}
          lines={lines}
          wrap={wrap}
          data-testid="file-text-source"
          onScroll={(event) => { const held = event.currentTarget; if (held.scrollHeight - held.scrollTop - held.clientHeight < 400) more(); }}
        />
      )}
      {answer.complete === false && cursor.current !== null ? (
        <Metadata data-testid="file-text-cut">{t('knowledge.fileText.cut', { line: new Intl.NumberFormat(context.language).format(cursor.current.line), column: new Intl.NumberFormat(context.language).format(cursor.current.column) })}</Metadata>
      ) : null}
      {busy && !(markdown && view === 'rendered') ? <Metadata>{t('knowledge.fileText.loading')}</Metadata> : null}
      {answer.text.trim() === '' && lines.length === 0 ? <Paragraph data-testid="file-text-empty">{localized(context.section.params['emptyText'], context.language) ?? t('knowledge.fileText.empty')}</Paragraph> : null}
    </Stack>
  );
}
