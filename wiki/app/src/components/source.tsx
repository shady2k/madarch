/** Source citations and the source template read the graph's pinned file text, never the raw HTTP source endpoint. */
import { useCallback, useEffect, useRef, useState, type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { decodeCitation } from '../../../../src/page-contract/citation.js';
import { Button } from './ui/button.js';
import { Badge } from './ui/badge.js';
import { Card, CardHeader, CardContent } from './ui/card.js';
import { FileSource } from './ui/drawing.js';
import { SyntaxToken } from './ui/syntax-token.js';
import { TechnicalText } from './ui/technical-text.js';
import { InlineGroup, Metadata, Paragraph, Stack, TextLink } from './ui/typography.js';
import { entityAddress, sourceAddress } from '../address.js';
import { postQuery } from '../client.js';
import { grammarOf, highlightLines, plainLines, type HighlightedLine } from './file-highlight.js';
import { at } from './format.js';
import type { SectionContext } from './types.js';

interface SourceText {
  readonly text: string;
  readonly blob: string;
  readonly moved?: boolean;
  readonly fileId?: string;
  readonly fileKind?: string;
  readonly language: string | null;
  readonly lines: number;
  readonly binary: boolean;
  readonly from: number;
  readonly complete: boolean;
  readonly next: { readonly line: number; readonly column: number } | null;
}
const QUERY = `query Citation($repository: String!, $path: String!, $from: Int, $to: Int, $blob: String, $fromColumn: Int) {
  file: entityByKey(kind: "code.file", key: { repository: $repository, path: $path }) { id kind }
  source(repository: $repository, path: $path, from: $from, to: $to, blob: $blob, fromColumn: $fromColumn) {
    text blob moved language lines binary from complete next { line column }
  }
}`;

function useSource(base: string, repository: unknown, path: unknown, from: number, to?: number) {
  const [answer, setAnswer] = useState<SourceText | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [lines, setLines] = useState<readonly HighlightedLine[]>([]);
  const [busy, setBusy] = useState(false);
  const [moved, setMoved] = useState(false);
  const current = useRef<SourceText | null>(null);
  const generation = useRef(0);
  const loading = useRef(false);
  const load = useCallback(async (next: boolean): Promise<void> => {
    if (typeof repository !== 'string' || typeof path !== 'string' || loading.current) return;
    const previous = next ? current.current : null;
    if (next && previous?.next == null) return;
    const version = generation.current;
    loading.current = true;
    setBusy(true); setFailure(null);
    try {
      const held = await postQuery<{ source: SourceText | null; file: { readonly id: string; readonly kind: string } | null }>(base, QUERY, {
        repository, path, from: previous?.next?.line ?? from,
        ...(to === undefined ? {} : { to }),
        ...(previous === null ? {} : { blob: previous.blob, fromColumn: previous.next?.column }),
      });
      if (version !== generation.current) return;
      if (held.errors.length > 0) throw new Error(held.errors.map((error) => error.message).join('; '));
      if (held.data?.source == null) { setFailure('unavailable'); return; }
      const source = held.data.source;
      const changed = source.moved === true || (previous !== null && source.blob !== previous.blob);
      const combined = { ...source, fileId: held.data.file?.id, fileKind: held.data.file?.kind, text: previous === null || changed ? source.text : previous.text + source.text };
      current.current = combined;
      setAnswer(combined); setMoved(changed);
      setLines(plainLines(combined.text));
      const highlighted = await highlightLines(combined.text, grammarOf(source.language ?? undefined, path));
      if (version === generation.current) setLines(highlighted);
    } catch (error) { if (version === generation.current) setFailure(error instanceof Error ? error.message : String(error)); }
    finally { if (version === generation.current) { loading.current = false; setBusy(false); } }
  }, [base, repository, path, from, to]);
  useEffect(() => {
    generation.current += 1; loading.current = false; current.current = null;
    setAnswer(null); setFailure(null); setLines([]); setMoved(false);
    void load(false);
    return () => { generation.current += 1; };
  }, [load]);
  return { answer, failure, lines, busy, moved, more: () => load(true) };
}

export function SourceSection({ context }: { readonly context: SectionContext }): ReactElement {
  const { t } = useTranslation();
  const evidence = at(context.data, context.section.params['path']);
  const held = evidence === null || evidence === undefined ? null : decodeCitation(evidence, 'wiki/app/src/components/source.tsx:88');
  const repository = held?.repository;
  const path = held?.path;
  const start = held?.lineStart ?? 1;
  const end = held?.lineEnd ?? undefined;
  const { answer, failure, lines } = useSource(context.base, repository, path, start, end);
  if (typeof path !== 'string' || typeof repository !== 'string') return <Metadata>{t('knowledge.source.missing')}</Metadata>;
  const href = `${context.base}${answer?.fileId === undefined || answer.fileKind === undefined ? sourceAddress(repository, path, start) : `${entityAddress(answer.fileKind, answer.fileId)}#L${String(start)}`}`;
  const location = `${repository}: ${path}:${String(start)}${end === undefined || end === start ? '' : `-${String(end)}`}`;
  let web: URL | null = null;
  const url = at(evidence, context.section.params['urlPath']);
  if (typeof url === 'string') {
    try { const candidate = new URL(url); if (candidate.protocol === 'https:' || candidate.protocol === 'http:') web = candidate; } catch { /* An invalid graph URL is not a link. */ }
  }
  const shown = answer === null || answer.text === '' ? 0 : plainLines(answer.text).length;
  const total = end === undefined ? answer?.lines ?? 0 : end - start + 1;
  return <Card data-testid="source-card">
    <CardHeader><InlineGroup>
      <TextLink href={href}>{location}</TextLink>
      {answer?.language == null ? null : <Badge>{answer.language}</Badge>}
      {web === null ? null : <TextLink href={web.href} target="_blank" rel="noreferrer noopener">{t('knowledge.source.openOnHost', { host: web.hostname })}</TextLink>}
    </InlineGroup></CardHeader>
    <CardContent>
      {failure !== null ? <Paragraph role="alert">{failure === 'unavailable' ? t('knowledge.source.unavailable') : t('knowledge.source.failed', { message: failure })}</Paragraph>
        : answer === null ? <Metadata>{t('knowledge.source.loading')}</Metadata>
        : answer.binary ? <Metadata>{t('knowledge.source.binary')}</Metadata>
        : <TechnicalText data-testid="source-excerpt">{lines.map((line, index) => <SyntaxToken key={index} colors={{}} fontStyle={0}>{`${String(answer.from + index)}  `}{line.map((token, at) => <SyntaxToken key={at} colors={token.color === undefined ? {} : { color: token.color }} fontStyle={token.fontStyle ?? 0}>{token.content}</SyntaxToken>)}{'\n'}</SyntaxToken>)}</TechnicalText>}
      {answer !== null && !answer.binary && (shown < total || answer.next !== null) ? <Paragraph data-testid="source-cut">{t('knowledge.source.cut', { shown, total })} <TextLink href={href}>{t('knowledge.source.open')}</TextLink></Paragraph> : null}
    </CardContent>
  </Card>;
}

/** The dedicated source address is composed from this template section, not a separate legacy page. */
export function SourcePageSection({ context }: { readonly context: SectionContext }): ReactElement {
  const { t } = useTranslation();
  const repository = context.variables[String(context.section.params['repoVariable'])];
  const path = context.variables[String(context.section.params['pathVariable'])];
  const { answer, failure, lines, busy, moved, more } = useSource(context.base, repository, path, 1);
  const box = useRef<HTMLDivElement | null>(null);
  if (typeof repository !== 'string' || typeof path !== 'string') return <Metadata>{t('knowledge.source.missing')}</Metadata>;
  if (failure !== null) return <Paragraph role="alert">{failure === 'unavailable' ? t('knowledge.source.unavailable') : t('knowledge.source.failed', { message: failure })}</Paragraph>;
  if (answer === null) return <Metadata>{t('knowledge.source.loading')}</Metadata>;
  return <Stack data-testid="source-page">
    <InlineGroup><Badge>{repository}</Badge>{answer.language === null ? null : <Badge>{answer.language}</Badge>}<Metadata>{t('knowledge.source.count', { count: answer.lines })}</Metadata></InlineGroup>
    <Metadata>{path}</Metadata>
    {moved ? <Metadata>{t('knowledge.source.moved')}</Metadata> : null}
    {answer.binary ? <Paragraph>{t('knowledge.source.binary')}</Paragraph> : <FileSource ref={box} lines={lines} wrap />}
    {answer.next === null ? null : <Stack><Metadata>{t('knowledge.fileText.cut', { line: answer.next.line, column: answer.next.column })}</Metadata><Button disabled={busy} disabledReason={t('knowledge.source.loading')} onClick={() => void more()}>{t('knowledge.source.more')}</Button>{busy ? <Metadata>{t('knowledge.source.loading')}</Metadata> : null}</Stack>}
  </Stack>;
}
