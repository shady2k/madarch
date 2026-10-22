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
import { useContext, useState, type MouseEvent, type ReactElement, type ReactNode } from 'react';
import ReactMarkdown, { defaultUrlTransform, type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useTranslation } from 'react-i18next';
import { FileCode2Icon } from 'lucide-react';
import { appPath } from '../app-base.js';
import { MermaidDiagram } from '../diagram.js';
import { navigateTo } from '../hold.js';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert.js';
import { Badge } from '@/components/ui/badge.js';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card.js';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table.js';
import { highlight } from './highlight.js';
import { PendingPages } from './pending.js';
import { kindWord } from './routes.js';
import type { Block, CallRow, CodeLocation, EntityRef, RelatedGroup, Resolution } from './types.js';

/** Follows an address on the client side, unless the click asks for a new tab. */
function follow(address: string): (event: MouseEvent<HTMLAnchorElement>) => void {
  return (event) => {
    if (event.shiftKey || event.ctrlKey || event.metaKey || event.altKey || event.button !== 0) return;
    event.preventDefault();
    navigateTo(appPath(address));
  };
}

/** A link inside the wiki, opened without a reload. */
export function KLink({ href, children, className, title }: { href: string; children: ReactNode; className?: string; title?: string }): ReactElement {
  return <a href={appPath(href)} className={className} title={title} onClick={follow(href)}>{children}</a>;
}

/** `path:line` as a link that opens the source at that line. */
export function CodePlace({ location }: { location: CodeLocation }): ReactElement {
  const lines = location.lineEnd > location.lineStart ? `${location.lineStart}–${location.lineEnd}` : String(location.lineStart);
  return (
    <KLink href={location.href} className="inline-flex min-w-0 max-w-full items-center gap-1 font-mono text-[0.875em] text-secondary" title={`${location.repo === null ? '' : `${location.repo}: `}${location.path}`}>
      <FileCode2Icon aria-hidden="true" className="size-3.5 shrink-0 text-muted" />
      <span className="truncate" data-testid="code-place">{location.path}:{lines}</span>
    </KLink>
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

/** The Markdown of a page: text, `madarch:` links resolved against the page's resolutions, footnote grounds listed at the end. */
export function KMarkdown({ text, resolutions }: { text: string; resolutions: Readonly<Record<string, Resolution>> }): ReactElement {
  const { t } = useTranslation();
  const pending = useContext(PendingPages);
  const components: Components = {
    a: ({ href, children }) => {
      if (href === undefined) return <span>{children}</span>;
      if (href.startsWith('madarch:')) {
        const resolution = resolutions[href];
        if (resolution?.state === 'broken' && pending.has(href.slice('madarch:'.length))) {
          return <span className="ref-pending" data-testid="ref-pending" title={t('knowledge.writer.pendingTitle')}>{children}<span className="ref-broken-mark">{t('knowledge.writer.pending')}</span></span>;
        }
        if (resolution === undefined || resolution.state === 'broken') {
          return <span className="ref-broken" data-testid="ref-broken" title={resolution?.state === 'broken' ? resolution.reason : t('knowledge.unresolved')}>{children}<span className="ref-broken-mark">{t('knowledge.broken')}</span></span>;
        }
        // A reference to code also opens the source at its line: the page link and the place stand together.
        const place = resolution.location === undefined ? null : <span className="ground-place ml-1.5"><CodePlace location={resolution.location} /></span>;
        if (resolution.href === null) return <><span data-testid="ref-unpaged" title={resolution.note ?? t('knowledge.noPage', { kind: kindWord(resolution.kind) })}>{children}</span>{place}</>;
        return <><KLink href={resolution.href} title={resolution.note}>{children}</KLink>{place}</>;
      }
      if (href.startsWith('/k/') || href === '/k') return <KLink href={href}>{children}</KLink>;
      return <span className="plain-link">{children}</span>;
    },
    table: ({ children }) => <div className="table-wrap"><table>{children}</table></div>,
  };
  return (
    <div className="reading">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components} urlTransform={keepUrl}>{text}</ReactMarkdown>
    </div>
  );
}

function Body({ block, resolutions }: { block: Extract<Block, { type: 'body' }>; resolutions: Readonly<Record<string, Resolution>> }): ReactElement {
  const { t } = useTranslation();
  return (
    <section data-block="body">
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
      <KMarkdown text={block.markdown} resolutions={resolutions} />
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
                    <TableCell><Badge>{kindWord(row.entity.kind)}</Badge></TableCell>
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
export function CodeLines({ text, language, firstLine, focus }: { text: string; language: string; firstLine: number; focus?: number | null }): ReactElement {
  const lines = highlight(text, language);
  return (
    <pre className="source-code" data-testid="source-code" data-language={language}>
      <code>
        {lines.map((tokens, index) => {
          const number = firstLine + index;
          return (
            <span key={number} id={`L${number}`} className={'source-line' + (focus === number ? ' source-line-focus' : '')} data-line={number}>
              <span className="source-number" aria-hidden="true">{number}</span>
              <span className="source-text">
                {tokens.map((token, position) => <span key={position} className={token.kind === 'plain' ? undefined : `tok-${token.kind}`}>{token.text}</span>)}
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

function Diagram({ title, mermaid, caption, empty }: { title: string; mermaid: string; caption: string | null; empty: string }): ReactElement {
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
        {caption !== null && <figcaption className="mt-1.5 text-small text-muted">{caption}</figcaption>}
      </figure>
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

/** One block of a page. */
export function BlockView({ block, resolutions }: { block: Block; resolutions: Readonly<Record<string, Resolution>> }): ReactElement | null {
  const { t } = useTranslation();
  switch (block.type) {
    case 'markdown': return <KMarkdown text={block.markdown} resolutions={resolutions} />;
    case 'body': return <Body block={block} resolutions={resolutions} />;
    case 'related': return <Related block={block} />;
    case 'callers':
    case 'callees': return <Calls block={block} />;
    case 'source': return <Source block={block} />;
    case 'graph': return <Diagram title={block.title} mermaid={block.mermaid} empty={t('knowledge.noLinks')} caption={block.total > block.shown ? t('knowledge.showing', { shown: block.shown, total: block.total }) : null} />;
    case 'sequence': return <Diagram title={block.title} mermaid={block.mermaid} empty={t('knowledge.noCalls')} caption={block.total > block.shown ? t('knowledge.showing', { shown: block.shown, total: block.total }) : null} />;
    case 'er': return <Diagram title={block.title} mermaid={block.mermaid} empty={t('knowledge.noTables')} caption={block.tables > block.shownTables ? t('knowledge.showing', { shown: block.shownTables, total: block.tables }) : null} />;
    case 'problem': return <Problem block={block} />;
  }
}

/** The findings a page carries, listed with their file and line; collapsed so a page reads first. */
export function Findings({ findings }: { findings: readonly { file: string; line: number; message: string }[] }): ReactElement | null {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  if (findings.length === 0) return null;
  return (
    <Alert variant="problem" className="mt-8" data-testid="findings">
      <AlertTitle>
        <button type="button" className="cursor-pointer bg-transparent p-0 text-left font-[600] text-ink" aria-expanded={open} onClick={() => setOpen(!open)}>
          {t('knowledge.findings', { count: findings.length })}
        </button>
      </AlertTitle>
      {open && (
        <AlertDescription>
          <ul className="!my-1">
            {findings.map((finding, index) => <li key={index}><span className="font-mono text-[0.875em]">{finding.file}:{finding.line}</span> {finding.message}</li>)}
          </ul>
        </AlertDescription>
      )}
    </Alert>
  );
}
