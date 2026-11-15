/**
 * A file's text (madarch-u3vw.16, decision 0037): the page asks for line ranges, and the server answers them by the blob
 * id the graph holds — read from git's object store through the git plugin, never from a working copy. A Markdown file
 * opens rendered by the same component the Sources page draws documents with, with a Rendered / Source switch the reader
 * keeps; every other text file opens as source with line numbers, a soft-wrap switch and the page's full width, loaded in
 * chunks as the reader scrolls, with the whole file one press away.
 */
import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from './ui/button.js';
import { InlineGroup, Metadata, Paragraph, Stack } from './ui/typography.js';
import { SegmentedChoice } from './ui/segmented-choice.js';
import { FileSource } from './ui/drawing.js';
import { readFileText, type FileTextAnswer } from './command.js';
import { grammarOf, highlightLines, plainLines, type HighlightedLine } from './file-highlight.js';
import { at, localized } from './format.js';
import { TextSection } from './text.js';
import type { SectionContext } from './types.js';

/** The view a Markdown file opens in, kept per reader. */
const VIEW_KEY = 'madarch-file-text-view';
/** The most lines a first answer asks for. */
const FIRST_LINES = 400;

function storedView(): 'rendered' | 'source' {
  try {
    const held = window.localStorage.getItem(VIEW_KEY);
    return held === 'source' ? 'source' : 'rendered';
  } catch {
    return 'rendered';
  }
}

const isMarkdown = (path: string): boolean => /\.(md|markdown|mdx)$/iu.test(path);

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
  const [view, setView] = useState<'rendered' | 'source'>(storedView);
  const [wrap, setWrap] = useState(true);
  const box = useRef<HTMLDivElement | null>(null);
  const asked = useRef(0);
  const markdown = typeof path === 'string' && isMarkdown(path);

  const load = useCallback(async (from: number): Promise<void> => {
    if (typeof repository !== 'string' || typeof path !== 'string') return;
    if (asked.current >= from) return;
    asked.current = from;
    setBusy(true);
    try {
      const held = await readFileText(context.base, { repository, path, from, to: from + chunk - 1 });
      setAnswer(held);
      // The lines stand at once, plain; the highlighter's tokens replace them when it has answered.
      const plain = plainLines(held.text);
      setLines((current) => from === 1 ? plain : [...current, ...plain]);
      setFailure(null);
      const language = grammarOf(typeof graphLanguage === 'string' ? graphLanguage : held.language, path);
      const highlighted = await highlightLines(held.text, language);
      setLines((current) => from === 1 ? highlighted : [...current, ...highlighted]);
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error));
      asked.current = 0;
    } finally {
      setBusy(false);
    }
  }, [context.base, repository, path, chunk, graphLanguage]);

  useEffect(() => { void load(1); }, [load]);

  // A reader who scrolls near the end of what is loaded asks for the next range: the page never asks for a whole file.
  const more = (): void => {
    if (answer === null || busy) return;
    if (lines.length < answer.lines) void load(lines.length + 1);
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
    const whole = await readFileText(context.base, { repository, path });
    const url = URL.createObjectURL(new Blob([whole.text], { type: 'text/plain;charset=utf-8' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = path.split('/').at(-1) ?? 'file.txt';
    anchor.click();
    URL.revokeObjectURL(url);
  };
  return (
    <Stack className="grid gap-3" data-testid="file-text">
      <InlineGroup className="mb-0">
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
      {markdown && view === 'rendered' ? (
        <div data-testid="file-text-rendered">
          {/* The very component the Sources page draws a document with, fed the file's text (madarch-u3vw.16). */}
          <TextSection context={{ ...context, data: { text: answer.text }, section: { ...context.section, params: { path: 'text' } } }} />
        </div>
      ) : (
        <FileSource
          ref={box}
          lines={lines}
          wrap={wrap}
          data-testid="file-text-source"
          onScroll={(event) => { const held = event.currentTarget; if (held.scrollHeight - held.scrollTop - held.clientHeight < 400) more(); }}
        />
      )}
      {busy && !(markdown && view === 'rendered') ? <Metadata>{t('knowledge.fileText.loading')}</Metadata> : null}
      {answer.text.trim() === '' && lines.length === 0 ? <Paragraph data-testid="file-text-empty">{localized(context.section.params['emptyText'], context.language) ?? t('knowledge.fileText.empty')}</Paragraph> : null}
    </Stack>
  );
}
