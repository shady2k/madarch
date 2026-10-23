/**
 * The block library as the app draws it (decision 0029): every block arrives
 * read from the graph or the Markdown, and these components lay it out with the
 * wiki's shell parts — the table, the card, the badge, the alert — and its
 * existing renderers (Mermaid for the diagrams). Nothing here knows a kind.
 *
 * Every reference to code is a link that opens the source at its line; every
 * mention of an entity that has a page is a link to the page; a reference that
 * does not resolve is shown as broken, with its reason.
 */
import { createElement, useContext, useEffect, useState, type ReactElement, type ReactNode } from 'react';
import ReactMarkdown, { defaultUrlTransform, type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useTranslation } from 'react-i18next';
import { ExternalLinkIcon, FileCode2Icon } from 'lucide-react';
import { appPath } from '../app-base.js';
import { MermaidDiagram } from '../diagram.js';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert.js';
import { Badge } from '@/components/ui/badge.js';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card.js';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table.js';
import { getBlock } from './api.js';
import { highlight } from './highlight.js';
import { colorize, type ColoredToken } from './shiki.js';
import { PendingPages } from './pending.js';
import { ModulesView, SystemView } from './diagrams/system.js';
import { NeighborhoodGraph } from './diagrams/neighborhood.js';
import { SequenceView } from './diagrams/chain.js';
import { TreemapView } from './diagrams/treemap.js';
import { useKindName } from './kind-names.js';
import { addressOfDocument, addressOfStatement } from './routes.js';
import { linkHandlers, openInNewTab, syncFrontTabAddress } from './tabs.js';
import { remarkStatements, type MNode } from './statements.js';
import { setShowGrounds, useShowGrounds } from './preferences.js';
import { TermBlockView, remarkTerms, useTerms } from './glossary.js';
import type { Block, BrokenWhy, CallRow, CodeLocation, EntityRef, RelatedGroup, Resolution } from './types.js';

/** A link inside the wiki, opened without a reload: in the tab in front, or in a new tab on a middle or control click. */
export function KLink({ href, children, className, title }: { href: string; children: ReactNode; className?: string; title?: string }): ReactElement {
  return <a href={appPath(href)} className={className} title={title} {...linkHandlers(href)}>{children}</a>;
}

/** `path:line` as a link that opens the source at that line. */
export function CodePlace({ location }: { location: CodeLocation }): ReactElement {
  const lines = location.lineEnd > location.lineStart ? `${location.lineStart}–${location.lineEnd}` : String(location.lineStart);
  return (
    <>
      <KLink href={location.href} className="inline-flex min-w-0 max-w-full items-center gap-1 font-mono text-[0.875em] text-secondary" title={`${location.repo === null ? '' : `${location.repo}: `}${location.path}`}>
        <FileCode2Icon aria-hidden="true" className="size-3.5 shrink-0 text-muted" />
        <span className="truncate" data-testid="code-place">{location.path}:{lines}</span>
      </KLink>
      <WebPlace location={location} />
    </>
  );
}

/** "Open on the repository's web page" for a place in code, when the repository's address is known. */
export function WebPlace({ location }: { location: CodeLocation }): ReactElement | null {
  const { t } = useTranslation();
  if (location.web === undefined) return null;
  return (
    <a href={location.web.url} target="_blank" rel="noreferrer noopener" className="ml-2 inline-flex items-center gap-1 text-[0.875em] text-secondary" data-testid="web-place">
      <ExternalLinkIcon aria-hidden="true" className="size-3.5 shrink-0 text-muted" />
      {t('knowledge.openOnHost', { host: location.web.host })}
    </a>
  );
}

/** A reference to an entity: its page when it has one, else its name (and its place in code when it has one). */
export function EntityName({ entity }: { entity: EntityRef }): ReactElement {
  const { t } = useTranslation();
  if (entity.broken !== undefined) {
    return <span className="ref-broken" data-testid="ref-broken" title={entity.broken}>{entity.label}<span className="ref-broken-mark">{t('knowledge.broken')}</span></span>;
  }
  if (entity.href !== null) return <KLink href={entity.href}>{entity.label}</KLink>;
  return <span>{entity.label}</span>;
}

// ---- Markdown with grounds ----------------------------------------------------------------------

/** Passes `madarch:` links to the renderer, which drops every protocol it does not know. */
const keepUrl = (url: string): string => (url.startsWith('madarch:') ? url : defaultUrlTransform(url));

/** A relative link inside a document to another Markdown document of the same repository: its path and section. */
export function relativeDocument(from: { repo: string | null; path: string }, href: string): { path: string; anchor?: string } | null {
  const hash = href.indexOf('#');
  const file = hash < 0 ? href : href.slice(0, hash);
  if (file === '' || !/\.(md|markdown)$/i.test(file) || /^[a-z][a-z0-9+.-]*:/i.test(file)) return null;
  const parts = file.startsWith('/') ? [] : from.path.split('/').slice(0, -1);
  for (const part of file.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') { if (parts.length === 0) return null; parts.pop(); } else parts.push(decodeURIComponent(part));
  }
  return { path: parts.join('/'), ...(hash < 0 ? {} : { anchor: decodeURIComponent(href.slice(hash + 1)) }) };
}

/** Scrolls the page to the element a section anchor names: the one that opens at the line the server found the anchor on. */
export function scrollToAnchor(anchor: string, lines?: Readonly<Record<string, number>>): boolean {
  const line = lines?.[anchor.toLowerCase()];
  const candidates = [...document.querySelectorAll<HTMLElement>('[data-line]')];
  const target = line === undefined
    ? document.getElementById(anchor)
    : candidates.filter((element) => Number(element.dataset['line']) <= line).sort((a, b) => Number(b.dataset['line']) - Number(a.dataset['line']))[0] ?? null;
  if (target === null) return false;
  target.scrollIntoView?.({ block: 'start' });
  target.classList.add('anchor-hit');
  return true;
}

/** The Markdown of a page: text, `madarch:` links resolved against the page's resolutions, footnote grounds listed at the end. */
/** The statements of an agent's page: which page they stand on, and whether their grounds are shown in the text. */
export interface StatementView {
  pageId: string;
  showGrounds: boolean;
}

export function KMarkdown({ text, resolutions, inDocument, statements, exceptTerm }: { text: string; resolutions: Readonly<Record<string, Resolution>>; inDocument?: { repo: string | null; path: string; anchors?: Readonly<Record<string, number>> }; statements?: StatementView; /** The id of the glossary entry this text is, which it does not link to. */ exceptTerm?: string }): ReactElement {
  const { t } = useTranslation();
  const { index } = useTerms();
  const kindName = useKindName();
  const pending = useContext(PendingPages);
  const components: Components = {
    a: ({ href, children, className, title }) => {
      if (href === undefined) return <span>{children}</span>;
      if (href.startsWith('madarch:')) {
        const resolution = resolutions[href];
        if (resolution?.state === 'broken' && pending.has(href.slice('madarch:'.length))) {
          return <span className="ref-pending" data-testid="ref-pending" title={t('knowledge.writer.pendingTitle')}>{children}<span className="ref-broken-mark">{t('knowledge.writer.pending')}</span></span>;
        }
        if (resolution === undefined || resolution.state === 'broken') {
          return <span className="ref-broken" data-testid="ref-broken" title={resolution?.state === 'broken' ? brokenWords(resolution, t) : t('knowledge.unresolved')}>{children}<span className="ref-broken-mark">{t('knowledge.broken')}</span></span>;
        }
        // A reference to code also opens the source at its line: the page link and the place stand together; a statement read plainly names the entity and nothing else.
        const place = resolution.location === undefined || (statements !== undefined && !statements.showGrounds) ? null : <span className="ground-place ml-1.5"><CodePlace location={resolution.location} /></span>;
        if (resolution.href === null) return <><span data-testid="ref-unpaged" title={resolution.note ?? t('knowledge.noPage', { kind: kindName(resolution.kind, 'one') })}>{children}</span>{place}</>;
        return <><KLink href={resolution.href} title={resolution.note}>{children}</KLink>{place}</>;
      }
      if (href.startsWith('/k/') || href === '/k') return <KLink href={href} {...(className === undefined ? {} : { className })} {...(title === undefined ? {} : { title })}>{children}</KLink>;
      if (inDocument !== undefined) {
        // In a document: a link to another Markdown document of the same repository is a page of the wiki, a link to a
        // section of this one scrolls to it, and a link to another site opens it in a tab of its own.
        if (/^https?:\/\//i.test(href)) return <a href={href} target="_blank" rel="noreferrer noopener">{children}</a>;
        if (href.startsWith('#')) {
          let anchor = href.slice(1);
          try { anchor = decodeURIComponent(anchor); } catch { /* the text as written names the section */ }
          return <a href={href} onClick={(event) => { event.preventDefault(); window.history.replaceState({}, '', `${window.location.pathname}${window.location.search}${href}`); syncFrontTabAddress(); scrollToAnchor(anchor, inDocument.anchors); }}>{children}</a>;
        }
        const target = relativeDocument(inDocument, href);
        if (target !== null) return <KLink href={addressOfDocument(inDocument.repo, target.path, target.anchor)}>{children}</KLink>;
      }
      return <span className="plain-link">{children}</span>;
    },
    ...(inDocument === undefined ? {} : (Object.fromEntries((['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'li', 'blockquote', 'pre'] as const).map((tag) => [tag, ({ node, children }: { node?: { position?: { start: { line: number } } }; children?: ReactNode }) => createElement(tag, { 'data-line': node?.position?.start.line }, children)])) as Components)),
    table: ({ children }) => <div className="table-wrap"><table>{children}</table></div>,
    ...(statements === undefined ? {} : {
      span: ({ node: _node, className, children, ...rest }) => {
        const sentence = (rest as Record<string, unknown>)['data-statement'];
        if (typeof sentence !== 'string' || !String(className ?? '').split(' ').includes('statement')) return <span className={className}>{children}</span>;
        const grounded = (rest as Record<string, unknown>)['data-grounded'] === 'true';
        const turn = Number((rest as Record<string, unknown>)['data-turn'] ?? 0);
        const open = (): void => openInNewTab(addressOfStatement(statements.pageId, sentence, Number.isInteger(turn) ? turn : 0));
        return (
          <span
            className={className}
            role="button"
            tabIndex={0}
            data-testid="statement"
            data-grounded={grounded ? 'true' : 'false'}
            title={grounded ? t('knowledge.statementOpen') : t('knowledge.statementUngroundedTitle')}
            onClick={(event) => { if ((event.target as HTMLElement).closest('a') === null) open(); }}
            onKeyDown={(event) => { if (event.key === 'Enter' && (event.target as HTMLElement).closest('a') === null) open(); }}
          >
            {children}
            {!grounded && <span className="statement-mark" data-testid="statement-ungrounded">{t('knowledge.statementUngrounded')}</span>}
          </span>
        );
      },
    } satisfies Components),
  };
  const terms = index.pattern !== null ? [remarkTerms(index, exceptTerm) as unknown as (tree: unknown) => void] : [];
  const plugins = statements === undefined ? [remarkGfm, ...terms] : [remarkGfm, ...terms, () => remarkStatements({ showGrounds: statements.showGrounds }) as unknown as (tree: unknown) => void];
  return (
    <div className="reading">
      <ReactMarkdown remarkPlugins={plugins as never} components={components} urlTransform={keepUrl}>{text}</ReactMarkdown>
    </div>
  );
}

function Body({ block, resolutions, pageId }: { block: Extract<Block, { type: 'body' }>; resolutions: Readonly<Record<string, Resolution>>; pageId?: string }): ReactElement {
  const { t } = useTranslation();
  const showGrounds = useShowGrounds();
  // Statements are the agent's sentences with their grounds: a page of the product has them, a document entity's text has none.
  const read = pageId !== undefined && block.statements > 0;
  return (
    <section data-block="body">
      {read && (
        <label className="mb-3 flex w-fit cursor-pointer items-center gap-2 text-small text-secondary" data-testid="grounds-switch">
          <input type="checkbox" role="switch" checked={showGrounds} onChange={(event) => setShowGrounds(event.target.checked)} />
          {t('knowledge.showGrounds')}
        </label>
      )}
      {block.ungrounded.length > 0 && (
        <Alert variant="problem" className="mb-4" data-testid="ungrounded">
          <AlertTitle>{t('knowledge.ungrounded', { count: block.ungrounded.length, total: block.statements })}</AlertTitle>
          <AlertDescription>
            <p>{t('knowledge.ungroundedHint')}</p>
            <details>
              <summary className="cursor-pointer text-secondary">{t('knowledge.ungroundedList')}</summary>
              <ul className="!my-2">
                {block.ungrounded.map((statement) => <li key={`${statement.line}:${statement.text}`}>{statement.text} <span className="text-muted">({block.file}:{statement.line})</span></li>)}
              </ul>
            </details>
          </AlertDescription>
        </Alert>
      )}
      <KMarkdown text={block.markdown} resolutions={resolutions} {...(read ? { statements: { pageId: pageId!, showGrounds } } : {})} />
    </section>
  );
}

// ---- related, callers, callees ------------------------------------------------------------------

function groupLabel(group: RelatedGroup, t: (key: string, options?: Record<string, unknown>) => string): string {
  const word = group.relation.startsWith('code.') ? group.relation.slice('code.'.length) : group.relation;
  return t(group.direction === 'out' ? 'knowledge.relationOut' : 'knowledge.relationIn', { relation: word.replace(/-/g, ' ') });
}

function Related({ block }: { block: Extract<Block, { type: 'related' }> }): ReactElement | null {
  const { t } = useTranslation();
  const kindName = useKindName();
  if (block.groups.length === 0) {
    return (
      <section data-block="related" aria-label={block.title}>
        <h2>{block.title}</h2>
        <p className="text-small text-muted" data-testid="related-empty">{t('knowledge.none')}</p>
      </section>
    );
  }
  return (
    <section data-block="related" aria-label={block.title}>
      <h2>{block.title}</h2>
      <div className="flex flex-col gap-4">
        {block.groups.map((group) => (
          <div key={`${group.relation}:${group.direction}`} data-relation={group.relation} data-direction={group.direction}>
            <div className="mb-1.5 flex items-center gap-2 text-small text-muted">
              <span>{groupLabel(group, t)}</span>
              <Badge>{group.total}</Badge>
            </div>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('knowledge.colName')}</TableHead>
                  <TableHead>{t('knowledge.colKind')}</TableHead>
                  <TableHead>{t('knowledge.colPlace')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {group.rows.map((row) => (
                  <TableRow key={row.entity.id} data-entity={row.entity.id}>
                    <TableCell className="max-w-[28rem] break-words"><EntityName entity={row.entity} />{row.count > 1 && <span className="ml-1.5 text-muted">×{row.count}</span>}</TableCell>
                    <TableCell><Badge>{kindName(row.entity.kind, 'one')}</Badge></TableCell>
                    <TableCell className="max-w-[24rem]">{row.entity.location !== undefined ? <CodePlace location={row.entity.location} /> : <span className="text-muted">–</span>}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {group.total > group.rows.length && <p className="mt-1.5 text-small text-muted" data-testid="related-cut">{t('knowledge.showing', { shown: group.rows.length, total: group.total })}</p>}
          </div>
        ))}
      </div>
    </section>
  );
}

function Calls({ block }: { block: Extract<Block, { type: 'callers' | 'callees' }> }): ReactElement {
  const { t } = useTranslation();
  if (block.rows.length === 0) {
    return (
      <section data-block={block.type} aria-label={block.title}>
        <h2>{block.title}</h2>
        <p className="text-small text-muted" data-testid={`${block.type}-empty`}>{t('knowledge.none')}</p>
      </section>
    );
  }
  const rows: CallRow[] = block.rows;
  return (
    <section data-block={block.type} aria-label={block.title}>
      <h2>{block.title}</h2>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{block.type === 'callers' ? t('knowledge.colCaller') : t('knowledge.colCallee')}</TableHead>
            <TableHead>{block.type === 'callers' ? t('knowledge.colCallSite') : t('knowledge.colDeclared')}</TableHead>
            <TableHead>{t('knowledge.colSites')}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.entity.id} data-entity={row.entity.id}>
              <TableCell className="max-w-[28rem] break-words"><EntityName entity={row.entity} /></TableCell>
              <TableCell className="max-w-[26rem]">
                {block.type === 'callers' ? (row.site !== undefined ? <CodePlace location={row.site} /> : <span className="text-muted">–</span>) : (row.entity.location !== undefined ? <CodePlace location={row.entity.location} /> : <span className="text-muted">–</span>)}
              </TableCell>
              <TableCell>{row.sites}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {block.total > rows.length && <p className="mt-1.5 text-small text-muted" data-testid="calls-cut">{t('knowledge.showing', { shown: rows.length, total: block.total })}</p>}
    </section>
  );
}

// ---- source -------------------------------------------------------------------------------------

/** Highlighted lines with their numbers; `focus` marks the line the reader was sent to. */
export function CodeLines({ text, language, firstLine, focus, marked }: { text: string; language: string; firstLine: number; focus?: number | null; marked?: { start: number; end: number } }): ReactElement {
  const lines = highlight(text, language);
  // The plain scanner draws at once; the colors of Shiki replace it when they arrive.
  const [colored, setColored] = useState<{ key: string; lines: ColoredToken[][] } | null>(null);
  const key = `${language}\0${text.length}\0${text.slice(0, 64)}`;
  useEffect(() => {
    let alive = true;
    colorize(text, language).then((result) => { if (alive && result !== null) setColored({ key, lines: result }); });
    return () => { alive = false; };
  }, [key, text, language]);
  const shown = colored !== null && colored.key === key && colored.lines.length === lines.length ? colored.lines : null;
  return (
    <pre className="source-code" data-testid="source-code" data-language={language} data-colored={shown !== null ? 'true' : 'false'}>
      <code>
        {lines.map((tokens, index) => {
          const number = firstLine + index;
          return (
            <span key={number} id={`L${number}`} className={'source-line' + (focus === number ? ' source-line-focus' : '') + (marked !== undefined && marked.start > 0 && number >= marked.start && number <= marked.end ? ' source-line-marked' : '')} data-line={number}>
              <span className="source-number" aria-hidden="true">{number}</span>
              <span className="source-text">
                {shown !== null
                  ? shown[index]!.map((token, position) => <span key={position} className="shiki-token" style={{ ...token.style, ...(token.fontStyle & 1 ? { fontStyle: 'italic' } : {}), ...(token.fontStyle & 2 ? { fontWeight: 600 } : {}) }}>{token.text}</span>)
                  : tokens.map((token, position) => <span key={position} className={token.kind === 'plain' ? undefined : `tok-${token.kind}`}>{token.text}</span>)}
                {'\n'}
              </span>
            </span>
          );
        })}
      </code>
    </pre>
  );
}

function Source({ block }: { block: Extract<Block, { type: 'source' }> }): ReactElement {
  const { t } = useTranslation();
  const total = block.location.lineEnd - block.location.lineStart + 1;
  const shown = block.text === '' ? 0 : block.text.split('\n').length;
  return (
    <section data-block="source" aria-label={block.title}>
      <h2>{block.title}</h2>
      <Card className="overflow-hidden">
        <CardHeader className="flex-row items-center justify-between gap-3 pb-3">
          <CardTitle className="min-w-0 flex-1 text-small"><CodePlace location={block.location} /></CardTitle>
          <Badge>{block.language}</Badge>
        </CardHeader>
        <CardContent className="px-0 pb-0 pt-0">
          <CodeLines text={block.text} language={block.language} firstLine={block.location.lineStart} />
          {block.truncated && (
            <p className="m-0 border-t border-line px-4 py-2 text-small text-muted" data-testid="source-cut">
              {t('knowledge.showing', { shown, total })} <KLink href={block.location.href}>{t('knowledge.openSource')}</KLink>
            </p>
          )}
        </CardContent>
      </Card>
    </section>
  );
}

// ---- diagrams -----------------------------------------------------------------------------------

function Diagram({ title, mermaid, caption, empty, links = [] }: { title: string; mermaid: string; caption: string | null; empty: string; links?: readonly EntityRef[] }): ReactElement {
  if (mermaid === '') {
    return (
      <section data-block="diagram" aria-label={title}>
        <h2>{title}</h2>
        <p className="text-small text-muted" data-testid="diagram-empty">{empty}</p>
      </section>
    );
  }
  return (
    <section data-block="diagram" aria-label={title}>
      <h2>{title}</h2>
      <figure className="m-0">
        <MermaidDiagram source={mermaid} title={title} />
        {links.length > 0 && <ul className="dg-links" data-testid="diagram-links">{links.map((entity) => <li key={entity.id}><EntityName entity={entity} /></li>)}</ul>}
        {caption !== null && <figcaption className="mt-1.5 text-small text-muted">{caption}</figcaption>}
      </figure>
    </section>
  );
}

function Properties({ block }: { block: Extract<Block, { type: 'properties' }> }): ReactElement | null {
  const { t } = useTranslation();
  if (block.rows.length === 0) return null;
  return (
    <section data-block="properties" aria-label={block.title}>
      <h2>{block.title}</h2>
      <Table>
        <TableHeader>
          <TableRow><TableHead>{t('knowledge.colProperty')}</TableHead><TableHead>{t('knowledge.colValue')}</TableHead></TableRow>
        </TableHeader>
        <TableBody>
          {block.rows.map((row) => (
            <TableRow key={row.name}>
              <TableCell className="whitespace-nowrap align-top font-mono text-[0.875em] text-secondary">{row.name}</TableCell>
              <TableCell className="max-w-[40rem] break-words">{row.value}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </section>
  );
}

function Refs({ block }: { block: Extract<Block, { type: 'refs' }> }): ReactElement {
  const { t } = useTranslation();
  const kindName = useKindName();
  return (
    <section data-block="refs" aria-label={block.title}>
      <h2>{block.title}</h2>
      {block.rows.length === 0 ? <p className="text-small text-muted" data-testid="refs-empty">{t('knowledge.none')}</p> : (
        <Table>
          <TableHeader>
            <TableRow><TableHead>{t('knowledge.colName')}</TableHead><TableHead>{t('knowledge.colKind')}</TableHead><TableHead>{t('knowledge.colPlace')}</TableHead></TableRow>
          </TableHeader>
          <TableBody>
            {block.rows.map((row) => (
              <TableRow key={row.entity.id} data-entity={row.entity.id}>
                <TableCell className="max-w-[26rem] break-words"><EntityName entity={row.entity} />{row.note !== undefined && <span className="mt-0.5 block text-small text-muted" data-testid="ref-note">{row.noteKey === undefined ? row.note : t(`knowledge.refNote.${row.noteKey}`, { ...row.noteArgs, defaultValue: row.note })}</span>}</TableCell>
                <TableCell><Badge>{row.entity.kind === 'document' ? t('knowledge.documentBadge') : kindName(row.entity.kind, 'one')}</Badge></TableCell>
                <TableCell className="max-w-[24rem]">{row.entity.location !== undefined ? <CodePlace location={row.entity.location} /> : <span className="text-muted">–</span>}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {block.total > block.rows.length && <p className="mt-1.5 text-small text-muted" data-testid="refs-cut">{t('knowledge.showing', { shown: block.rows.length, total: block.total })}</p>}
    </section>
  );
}

function Stated({ block }: { block: Extract<Block, { type: 'stated' }> }): ReactElement {
  const { t } = useTranslation();
  const place = block.place;
  const lines = place.lineEnd > place.lineStart ? `${place.lineStart}–${place.lineEnd}` : String(place.lineStart);
  return (
    <section data-block="stated" aria-label={block.title}>
      <h2>{block.title}</h2>
      <p className="m-0 flex flex-wrap items-center gap-2">
        <Badge>{place.repo ?? t('knowledge.productRepository')}</Badge>
        <KLink href={place.href} className="font-mono text-[0.875em]"><span data-testid="stated-place">{place.path}:{lines}</span></KLink>
        {place.commit !== null && <Badge title={place.commit}>{place.commit.slice(0, 10)}</Badge>}
      </p>
    </section>
  );
}

/** A diagram the page left to be read on its own: drawn when its read comes, a failure said with its reason. */
function Deferred({ block, pageId, resolutions }: { block: Extract<Block, { type: 'deferred' }>; pageId?: string; resolutions: Readonly<Record<string, Resolution>> }): ReactElement {
  const { t, i18n } = useTranslation();
  const [drawn, setDrawn] = useState<Block | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  useEffect(() => {
    if (pageId === undefined) return;
    const stop = new AbortController();
    setDrawn(null);
    setFailure(null);
    getBlock(pageId, block.line, i18n.resolvedLanguage ?? 'en', stop.signal).then(setDrawn, (error: unknown) => {
      if (!(error instanceof DOMException && error.name === 'AbortError')) setFailure(error instanceof Error ? error.message : String(error));
    });
    return () => stop.abort();
  }, [pageId, block.line, block.block, i18n.resolvedLanguage]);
  if (drawn !== null) return <BlockView block={drawn} resolutions={resolutions} {...(pageId === undefined ? {} : { pageId })} />;
  return (
    <section data-block="diagram" data-diagram="deferred" aria-label={block.title}>
      {block.title !== '' && <h2>{block.title}</h2>}
      {failure === null ? <p className="text-small text-muted" data-testid="diagram-loading">{t('knowledge.diagram.drawing')}</p> : <p className="ref-broken" data-testid="diagram-failure">{failure}</p>}
    </section>
  );
}

/**
 * The history of a task, a commit or an author (madarch-m38l.16): the commits it names, the files it changed with the
 * lines it added and removed, or the files its commits touched most. Each figure is a badge whose word comes from the
 * reader's language, so a row reads "2026-01-02 · Ada · +42 −7".
 */
function History({ block }: { block: Extract<Block, { type: 'history' }> }): ReactElement {
  const { t } = useTranslation();
  /** One figure in the reader's language: `+42`, `−7`, `3 symbols`, `module: services/orders`. */
  const figureText = (figure: { kind: string; value: string }): string => {
    if (figure.kind === 'added') return `+${figure.value}`;
    if (figure.kind === 'removed') return `−${figure.value}`;
    if (figure.kind === 'module') return `${t('knowledge.historyFigure.module')}: ${figure.value}`;
    return `${figure.value} ${t(`knowledge.historyFigure.${figure.kind}`)}`;
  };
  return (
    <section data-block="history" aria-label={block.title}>
      <h2>{block.title}</h2>
      {block.sections.length === 0 ? <p className="text-small text-muted" data-testid="history-empty">{t('knowledge.none')}</p> : block.sections.map((section) => (
        <div key={section.role} data-history-section={section.role} className="mb-4">
          <h3 className="text-small text-muted">{t(`knowledge.historySection.${section.role}`)}</h3>
          <Table>
            <TableHeader>
              <TableRow>
                {section.role === 'commits' && <TableHead>{t('knowledge.historyColWhen')}</TableHead>}
                {section.role === 'commits' && <TableHead>{t('knowledge.historyColWho')}</TableHead>}
                <TableHead>{section.role === 'commits' ? t('knowledge.historyColWhat') : t('knowledge.historyColFile')}</TableHead>
                <TableHead>{t('knowledge.historyColFigures')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {section.rows.map((row, index) => (
                <TableRow key={row.entity?.id ?? `${section.role}-${String(index)}`} {...(row.entity === undefined ? {} : {'data-entity': row.entity.id})}>
                  {section.role === 'commits' && <TableCell className="whitespace-nowrap">{row.when ?? <span className="text-muted">–</span>}</TableCell>}
                  {section.role === 'commits' && <TableCell className="whitespace-nowrap">{row.who ?? <span className="text-muted">–</span>}</TableCell>}
                  <TableCell className="max-w-[32rem] break-words">
                    {row.entity === undefined ? row.text : <EntityName entity={row.entity} />}
                  </TableCell>
                  <TableCell>
                    <span className="flex flex-wrap items-center gap-1">
                      {row.figures.map((figure, at) => (
                        <Badge key={`${figure.kind}-${String(at)}`} data-figure={figure.kind} title={t(`knowledge.historyFigure.${figure.kind}`)}>
                          {figureText(figure)}
                        </Badge>
                      ))}
                      {row.figures.length === 0 && <span className="text-muted">–</span>}
                    </span>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {section.total > section.rows.length && <p className="mt-1.5 text-small text-muted" data-testid="history-cut">{t('knowledge.showing', { shown: section.rows.length, total: section.total })}</p>}
        </div>
      ))}
      {block.notes.length > 0 && (
        <ul className="mt-1.5 text-small text-muted" data-testid="history-notes">
          {block.notes.map((note, index) => <li key={index}>{note}</li>)}
        </ul>
      )}
    </section>
  );
}

function Problem({ block }: { block: Extract<Block, { type: 'problem' }> }): ReactElement {
  const { t } = useTranslation();
  return (
    <Alert variant="problem" className="my-4" data-testid="block-problem">
      <AlertTitle>{t('knowledge.blockProblem', { block: block.block })}</AlertTitle>
      <AlertDescription>
        <p>{block.message}</p>
        <p className="font-mono text-[0.875em] text-muted">{block.file}:{block.line}</p>
      </AlertDescription>
    </Alert>
  );
}

/** A repository history summary: the row facts and bounded cut are written in the reader language. */
function History({ block }: { block: Extract<Block, { type: 'history' }> }): ReactElement {
  const { t } = useTranslation();
  /** One figure in the reader's language: `+42`, `−7`, `3 symbols`, `module: services/orders`. */
  const figureText = (figure: { kind: string; value: string }): string => {
    if (figure.kind === 'added') return `+${figure.value}`;
    if (figure.kind === 'removed') return `−${figure.value}`;
    if (figure.kind === 'module') return `${t('knowledge.historyFigure.module')}: ${figure.value}`;
    return `${figure.value} ${t(`knowledge.historyFigure.${figure.kind}`)}`;
  };
  const figure = (kind: string, value: string): string => t(`knowledge.history${kind[0]!.toUpperCase()}${kind.slice(1)}`, { value });
  return (
    <section data-block="history" aria-label={block.title}>
      {block.title !== '' && <h2>{block.title}</h2>}
      {block.rows.length === 0 && <p className="text-small text-muted">{t('knowledge.historyUnavailable')}</p>}
      {block.rows.length > 0 && <ul className="space-y-2" data-testid="history-rows">
        {block.rows.map((row, index) => <li key={`${row.entity?.id ?? row.text}:${index}`} className="rounded-md border p-3">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            {row.when !== undefined && <time className="text-small text-muted">{row.when}</time>}
            {row.who !== undefined && <span className="text-small text-muted">{row.who}</span>}
            {row.entity?.href !== null && row.entity?.href !== undefined ? <KLink href={row.entity.href}>{row.text}</KLink> : <span>{row.text}</span>}
          </div>
          {row.figures.length > 0 && <p className="mb-0 mt-1 text-small text-muted">{row.figures.map((item) => figure(item.kind, item.value)).join(' · ')}</p>}
        </li>)}
      </ul>}
      {block.total > block.shown && <p className="mt-2 text-small text-muted">{t('knowledge.showing', { shown: block.shown, total: block.total })}</p>}
      {block.notes.map((note, index) => <p key={index} className="mt-2 text-small text-muted">{note}</p>)}
    </section>
  );
}

/** One block of a page. */
export function BlockView({ block, resolutions, pageId }: { block: Block; resolutions: Readonly<Record<string, Resolution>>; pageId?: string }): ReactElement | null {
  const { t } = useTranslation();
  switch (block.type) {
    case 'markdown': return <KMarkdown text={block.markdown} resolutions={resolutions} />;
    case 'term': return <TermBlockView block={block} pageId={pageId ?? ''} resolutions={resolutions} />;
    case 'body': return <Body block={block} resolutions={resolutions} {...(pageId === undefined ? {} : { pageId })} />;
    case 'refs': return <Refs block={block} />;
    case 'properties': return <Properties block={block} />;
    case 'stated': return <Stated block={block} />;
    case 'related': return <Related block={block} />;
    case 'callers':
    case 'callees': return <Calls block={block} />;
    case 'source': return <Source block={block} />;
    case 'graph': return <NeighborhoodGraph block={block} />;
    case 'sequence': return <SequenceView block={block} />;
    case 'system': return <SystemView block={block} />;
    case 'modules': return <ModulesView block={block} />;
    case 'treemap': return <TreemapView block={block} />;
    case 'history': return <History block={block} />;
    case 'history': return <History block={block} />;
    case 'er': return <Diagram title={block.title} mermaid={block.mermaid} empty={t('knowledge.noTables')} caption={block.tables > block.shownTables ? t('knowledge.showing', { shown: block.shownTables, total: block.tables }) : null} links={block.links} />;
    case 'deferred': return <Deferred block={block} resolutions={resolutions} {...(pageId === undefined ? {} : { pageId })} />;
    case 'problem': return <Problem block={block} />;
  }
}

/**
 * The findings a page carries. A reader is told in plain words what a finding means and who puts it right; the file and
 * line of each, which an engineer needs, are behind "Details" so the page reads first.
 */
export function Findings({ findings }: { findings: readonly { file: string; line: number; message: string }[] }): ReactElement | null {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  if (findings.length === 0) return null;
  return (
    <Alert variant="problem" className="mt-8" data-testid="findings">
      <AlertTitle>{t('knowledge.findings', { count: findings.length })}</AlertTitle>
      <AlertDescription>
        <p data-testid="findings-help">{t('knowledge.findingsHelp')}</p>
        <button type="button" className="cursor-pointer bg-transparent p-0 text-left text-secondary underline" aria-expanded={open} onClick={() => setOpen(!open)} data-testid="findings-details">
          {open ? t('knowledge.findingsHide') : t('knowledge.findingsDetails')}
        </button>
        {open && (
          <ul className="!my-2">
            {findings.map((finding, index) => <li key={index}><span className="font-mono text-[0.875em]">{finding.file}:{finding.line}</span> {finding.message}</li>)}
          </ul>
        )}
      </AlertDescription>
    </Alert>
  );
}

/** Why a link is broken, in the reader's language; the engineer's English message only where the server gave no reason as data. */
export function brokenWords(resolution: { reason: string; why?: BrokenWhy }, t: (key: string, options?: Record<string, unknown>) => string): string {
  const why = resolution.why;
  if (why === undefined) return resolution.reason;
  switch (why.code) {
    case 'empty': return t('knowledge.brokenWhy.empty');
    case 'no-entity': return t('knowledge.brokenWhy.noEntity', { key: why.key });
    case 'no-path': return t('knowledge.brokenWhy.noPath');
    case 'no-document': return t('knowledge.brokenWhy.noDocument', { path: why.path });
    case 'no-section': return t('knowledge.brokenWhy.noSection', { path: why.path, anchor: why.anchor, repos: why.repos });
  }
}
