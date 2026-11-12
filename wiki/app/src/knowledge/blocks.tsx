import { Stack, Text, PageSection, Paragraph, SectionTitle, SmallTitle, PlainList, ListItem, DefinitionList, DefinitionTerm, DefinitionValue, FieldLabel, TextLink, Preformatted } from '@/components/ui/typography.js';
import { SyntaxToken } from '@/components/ui/syntax-token.js';
import { InlineCode } from '@/components/ui/inline-content.js';
import { Disclosure, DisclosureSummary } from '@/components/ui/disclosure.js';
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
import { lazy, Suspense, createContext, createElement, useContext, useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';
import ReactMarkdown, { defaultUrlTransform, type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useTranslation } from 'react-i18next';
import { ExternalLinkIcon, FileCode2Icon } from 'lucide-react';
import { appPath } from '../app-base.js';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert.js';
import { Badge } from '@/components/ui/badge.js';
import { Button } from '@/components/ui/button.js';
import { Switch } from '@/components/ui/switch.js';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card.js';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table.js';
import { relationLabel } from './relation-labels.js';
import { getBlock } from './api.js';
import { historyAddress } from './history-context.js';
import { historyNoteText } from './history-note.js';
import { highlight } from './highlight.js';
import { colorize, type ColoredToken } from './shiki.js';
import { PendingPages } from './pending.js';
import { DiagramsView } from './diagrams/views.js';
import { NeighborhoodGraph } from './diagrams/neighborhood.js';
import { TreemapView } from './diagrams/treemap.js';
import { FilesTableView } from './files-table.js';
import { useKindName } from './kind-names.js';
import { ContractDiagnosticView } from './contract-diagnostic.js';
import { mermaidFence, MermaidFence } from './diagram-fence.js';
import { addressOfDocument, addressOfEntity, addressOfStatement, isWikiAddress, WIKI_PROBLEMS } from './routes.js';
import { FileFactsBlock, FilePageView, FolderBlock, RepositoryFactsBlock } from './repository.js';
import { COUNTED_FIGURES } from '../../../../src/knowledge/history-figures.js';
import { currentAddress, linkHandlers, openInNewTab, syncFrontTabAddress } from './tabs.js';
import { remarkStatements } from './statements.js';
import { setShowGrounds, useShowGrounds } from './preferences.js';
import { TermBlockView, remarkTerms, useTerms } from './glossary.js';
import type { Block, BrokenWhy, CallRow, CodeLocation, EntityRef, PlannedMarkView, PropertyRow, RelatedGroup, Resolution } from './types.js';

/** A link inside the wiki, opened without a reload: in the tab in front, or in a new tab on a middle or control click. */
export function KLink({ href, children, className, title, testId }: { href: string; children: ReactNode; className?: string; title?: string; testId?: string }): ReactElement {
  const target = historyAddress(href);
  return <TextLink href={appPath(target)} className={className} title={title} data-testid={testId} {...linkHandlers(target)}>{children}</TextLink>;
}

/** `path:line` as a link that opens the source at that line. */
export function CodePlace({ location }: { location: CodeLocation }): ReactElement {
  const lines = location.lineEnd > location.lineStart ? `${location.lineStart}–${location.lineEnd}` : String(location.lineStart);
  return (
    <>
      <KLink href={location.href} className="inline-flex min-w-0 max-w-full items-center gap-1 font-mono text-small text-secondary" title={`${location.repo === null ? '' : `${location.repo}: `}${location.path}`}>
        <FileCode2Icon aria-hidden="true" className="size-3.5 shrink-0 text-muted" />
        <Text className="truncate" data-testid="code-place">{location.path}:{lines}</Text>
      </KLink>
      <WebPlace location={location} />
    </>
  );
}

/** "Open on the repository's web page" for a place in code, when the repository's address is known. */
function WebPlace({ location }: { location: CodeLocation }): ReactElement | null {
  const { t } = useTranslation();
  if (location.web === undefined) return null;
  return (
    <TextLink href={location.web.url} target="_blank" rel="noreferrer noopener" className="ml-2 inline-flex items-center gap-1 text-small text-secondary" data-testid="web-place">
      <ExternalLinkIcon aria-hidden="true" className="size-3.5 shrink-0 text-muted" />
      {t('knowledge.openOnHost', { host: location.web.host })}
    </TextLink>
  );
}

/** A reference to an entity: its page when it has one, else its name (and its place in code when it has one). */
export function EntityName({ entity }: { entity: EntityRef }): ReactElement {
  const { t } = useTranslation();
  if (entity.broken !== undefined) {
    return <Text className="ref-broken" data-testid="ref-broken" title={entity.broken}>{entity.label}<Text className="ref-broken-mark">{t('knowledge.broken')}</Text></Text>;
  }
  if (entity.href !== null) return <KLink href={entity.href}>{entity.label}</KLink>;
  return <Text>{entity.label}</Text>;
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

/**
 * A planned change, where a reader meets it (madarch-m38l.14): the badge names the task and links to it, so what will
 * change is visible on the section, the statement or the page itself and not only on a list elsewhere.
 */
export function PlannedBadge({ mark, ground = false }: { mark: PlannedMarkView; ground?: boolean }): ReactElement {
  const { t } = useTranslation();
  return (
    <Text className="planned-badge" data-testid="planned-badge" data-how={mark.how} data-task={mark.task.id} title={t('loop.plannedTitle', { title: mark.task.title })}>
      <KLink href={addressOfEntity(mark.task.id)} className="planned-badge-link">{ground ? t('loop.basisWillChange') : t('loop.plannedChange')}</KLink>
    </Text>
  );
}

/** The Markdown of a page: text, `madarch:` links resolved against the page's resolutions, footnote grounds listed at the end. */
/** The statements of an agent's page: which page they stand on, and whether their grounds are shown in the text. */
export interface StatementView {
  pageId: string;
  showGrounds: boolean;
}

/** How long an opening waits after its click: a second press within this window is a double click, which selects. */
const CLICK_INTERVAL = 400;

/** The openings the sentences of one text asked for, and whether the press that ended a selection was seen. */
interface PendingOpen {
  /** The press found a selection: the click that follows only dismisses it and opens nothing. */
  pressed: boolean;
  /** A wait per sentence: two sentences clicked one after the other each open, and a second press drops its own wait alone. */
  timers: Map<string, { timer: ReturnType<typeof setTimeout>; turn: number }>;
}

/** The planned changes of one page, as its text is drawn: headings by the line they are on, statements by their sentence. */
export interface PlannedMarks {
  headings: Readonly<Record<number, PlannedMarkView>>;
  statements: Readonly<Record<string, PlannedMarkView>>;
}

const NO_PLANNED: PlannedMarks = { headings: {}, statements: {} };

/** The key a sentence is matched by: its words, without the footnote references and with its blanks as one. */
export const sentenceKey = (text: string): string => text.replace(/\[\^[^\]\s]+\]/g, '').replace(/\s+/g, ' ').trim();

/** What a page's text is read for: a page that carries a planned change tells every block of it (madarch-m38l.14). */
export const PlannedContext = createContext<PlannedMarks>(NO_PLANNED);

export function KMarkdown({ text, resolutions, inDocument, statements, exceptTerm, sourcePath }: {
  text: string;
  resolutions: Readonly<Record<string, Resolution>>;
  inDocument?: { repo: string | null; path: string; anchors?: Readonly<Record<string, number>> };
  statements?: StatementView;
  /** The id of the glossary entry this text is, which it does not link to. */
  exceptTerm?: string;
  /** The Markdown file this text comes from, when it is not a document page: a failed fence names it. */
  sourcePath?: string;
}): ReactElement {
  const { t } = useTranslation();
  const { index } = useTerms();
  const kindName = useKindName();
  const pending = useContext(PendingPages);
  const planned = useContext(PlannedContext);
  // An opening belongs to the page its click was made on: the wait is this text's own, and leaving the page drops it.
  const pendingOpen = useRef<PendingOpen>({ pressed: false, timers: new Map() });
  // A pending click is owned by its page, not its component: changing routes can
  // leave KMarkdown mounted briefly, then render a different page in the same slot.
  const pageAddress = currentAddress();
  useEffect(() => {
    const wait = pendingOpen.current;
    return () => {
      for (const { timer } of wait.timers.values()) clearTimeout(timer);
      wait.timers.clear();
    };
  }, [pageAddress]);
  const components: Components = {
    a: ({ href, children, className, title }) => {
      if (href === undefined) return <Text>{children}</Text>;
      if (href.startsWith('madarch:')) {
        const resolution = resolutions[href];
        if (resolution?.state === 'broken' && pending.has(href.slice('madarch:'.length))) {
          return <Text className="ref-pending" data-testid="ref-pending" title={t('knowledge.writer.pendingTitle')}>{children}<Text className="ref-broken-mark">{t('knowledge.writer.pending')}</Text></Text>;
        }
        if (resolution === undefined || resolution.state === 'broken') {
          return <Text className="ref-broken" data-testid="ref-broken" title={resolution?.state === 'broken' ? brokenWords(resolution, t) : t('knowledge.unresolved')}>{children}<Text className="ref-broken-mark">{t('knowledge.broken')}</Text></Text>;
        }
        // A reference to code also opens the source at its line: the page link and the place stand together; a statement read plainly names the entity and nothing else.
        const place = resolution.location === undefined || (statements !== undefined && !statements.showGrounds) ? null : <Text className="ground-place ml-1.5"><CodePlace location={resolution.location} /></Text>;
        if (resolution.href === null) return <><Text data-testid="ref-unpaged" title={resolution.note ?? t('knowledge.noPage', { kind: kindName(resolution.kind, 'one') })}>{children}</Text>{place}</>;
        return <><KLink href={resolution.href} title={resolution.note}>{children}</KLink>{place}</>;
      }
      if (isWikiAddress(href)) return <KLink href={href} {...(className === undefined ? {} : { className })} {...(title === undefined ? {} : { title })}>{children}</KLink>;
      if (inDocument !== undefined) {
        // In a document: a link to another Markdown document of the same repository is a page of the wiki, a link to a
        // section of this one scrolls to it, and a link to another site opens it in a tab of its own.
        if (/^https?:\/\//i.test(href)) return <TextLink href={href} target="_blank" rel="noreferrer noopener">{children}</TextLink>;
        if (href.startsWith('#')) {
          let anchor = href.slice(1);
          try { anchor = decodeURIComponent(anchor); } catch { /* the text as written names the section */ }
          return <TextLink href={href} onClick={(event) => { event.preventDefault(); window.history.replaceState({}, '', `${window.location.pathname}${window.location.search}${href}`); syncFrontTabAddress(); scrollToAnchor(anchor, inDocument.anchors); }}>{children}</TextLink>;
        }
        const target = relativeDocument(inDocument, href);
        if (target !== null) return <KLink href={addressOfDocument(inDocument.repo, target.path, target.anchor)}>{children}</KLink>;
      }
      return <Text className="plain-link">{children}</Text>;
    },
    ...(inDocument === undefined ? {} : (Object.fromEntries((['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'li', 'blockquote'] as const).map((tag) => [tag, ({ node, children }: { node?: { position?: { start: { line: number } } }; children?: ReactNode }) => {
      const line = node?.position?.start.line;
      const mark = line === undefined ? undefined : planned.headings[line];
      return createElement(tag, mark === undefined ? { 'data-line': line } : { 'data-line': line, 'data-planned': 'true' }, children, mark === undefined ? null : <PlannedBadge mark={mark} />);
    }])) as Components)),
    // A ```mermaid fence is the wiki's own diagram, not code (madarch-u3vw.18): the parser's language on the code node
    // decides, so any other fence stays the code block it was.
    pre: ({ node, children }) => {
      const fence = mermaidFence(node);
      const line = node?.position?.start.line;
      if (fence !== null) return <MermaidFence source={fence.source} line={fence.line} path={inDocument?.path ?? sourcePath ?? null} />;
      return <Preformatted {...(inDocument === undefined || line === undefined ? {} : { 'data-line': line })}>{children}</Preformatted>;
    },
    table: ({ children }) => <Table>{children}</Table>,
    thead: ({ children }) => <TableHeader>{children}</TableHeader>,
    tbody: ({ children }) => <TableBody>{children}</TableBody>,
    tr: ({ children }) => <TableRow>{children}</TableRow>,
    th: ({ children, style }) => <TableHead align={style?.textAlign === 'right' ? 'right' : style?.textAlign === 'center' ? 'center' : 'left'}>{children}</TableHead>,
    td: ({ children, style }) => <TableCell align={style?.textAlign === 'right' ? 'right' : style?.textAlign === 'center' ? 'center' : 'left'}>{children}</TableCell>,
    ...(statements === undefined ? {} : {
      span: ({ node: _node, className, children, ...rest }) => {
        const sentence = (rest as Record<string, unknown>)['data-statement'];
        if (typeof sentence !== 'string' || !String(className ?? '').split(' ').includes('statement')) return <Text className={className}>{children}</Text>;
        const grounded = (rest as Record<string, unknown>)['data-grounded'] === 'true';
        const turn = Number((rest as Record<string, unknown>)['data-turn'] ?? 0);
        const mark = planned.statements[sentenceKey(sentence)];
        // A drag across the sentence selects text: it opens nothing. Only a click that leaves no selection opens the statement.
        const selecting = (): boolean => {
          const selection = window.getSelection();
          return selection !== null && !selection.isCollapsed && selection.toString().trim() !== '';
        };
        // A click that only dismisses a selection finds it already gone (the press collapsed it): the press says it was there.
        const open = (): void => openInNewTab(addressOfStatement(statements.pageId, sentence, Number.isInteger(turn) ? turn : 0));
        return (
          <Text
            className={className}
            role="button"
            tabIndex={0}
            data-testid="statement"
            data-grounded={grounded ? 'true' : 'false'}
            {...(mark === undefined ? {} : { 'data-planned': mark.how })}
            title={grounded ? t('knowledge.statementOpen') : t('knowledge.statementUngroundedTitle')}
            onMouseDown={() => {
              const wait = pendingOpen.current;
              wait.pressed = selecting();
              const waiting = wait.timers.get(sentence);
              if (waiting !== undefined) {
                // The second press on this sentence: its pending opening is dropped, and the press selects.
                clearTimeout(waiting.timer);
                wait.timers.delete(sentence);
                wait.pressed = true;
              }
            }}
            onClick={(event) => {
              const wait = pendingOpen.current;
              const dismissed = wait.pressed;
              wait.pressed = false;
              if ((event.target as HTMLElement).closest('a') !== null || dismissed || selecting()) return;
              // Wait one click interval: a native double click selects a word after its
              // first click, and a slow one arrives well inside this window.
              const waiting = wait.timers.get(sentence);
              if (waiting !== undefined) clearTimeout(waiting.timer);
              wait.timers.set(sentence, { timer: setTimeout(() => {
                const pending = wait.timers.get(sentence);
                if (pending === undefined) return;
                wait.timers.delete(sentence);
                if (!selecting()) open();
              }, CLICK_INTERVAL), turn });
            }}
            onKeyDown={(event) => { if (event.key === 'Enter' && (event.target as HTMLElement).closest('a') === null) open(); }}
          >
            {children}
            {mark !== undefined && <PlannedBadge mark={mark} ground={mark.how === 'impact'} />}
            {!grounded && <Text className="statement-mark" data-testid="statement-ungrounded">{t('knowledge.statementUngrounded')}</Text>}
          </Text>
        );
      },
    } satisfies Components),
  };
  const terms = index.pattern !== null ? [remarkTerms(index, exceptTerm) as unknown as (tree: unknown) => void] : [];
  const plugins = statements === undefined ? [remarkGfm, ...terms] : [remarkGfm, ...terms, () => remarkStatements({ showGrounds: statements.showGrounds }) as unknown as (tree: unknown) => void];
  return (
    <Stack className="reading">
      <ReactMarkdown remarkPlugins={plugins as never} components={components} urlTransform={keepUrl}>{text}</ReactMarkdown>
    </Stack>
  );
}

function Body({ block, resolutions, pageId }: { block: Extract<Block, { type: 'body' }>; resolutions: Readonly<Record<string, Resolution>>; pageId?: string }): ReactElement {
  const { t } = useTranslation();
  const showGrounds = useShowGrounds();
  // Statements are the agent's sentences with their grounds: a page of the product has them, a document entity's text has none.
  const read = pageId !== undefined && block.statements > 0;
  return (
    <PageSection data-block="body">
      {read && (
        <FieldLabel className="mb-3 flex w-fit cursor-pointer items-center gap-2 text-small text-secondary" data-testid="grounds-switch">
          <Switch checked={showGrounds} onCheckedChange={setShowGrounds} />
          {t('knowledge.showGrounds')}
        </FieldLabel>
      )}
      {block.ungrounded.length > 0 && (
        <Alert variant="problem" className="mb-4" data-testid="ungrounded">
          <AlertTitle>{t('knowledge.ungrounded', { count: block.ungrounded.length, total: block.statements })}</AlertTitle>
          <AlertDescription>
            <Paragraph>{t('knowledge.ungroundedHint')}</Paragraph>
            <Disclosure>
              <DisclosureSummary className="cursor-pointer text-secondary">{t('knowledge.ungroundedList')}</DisclosureSummary>
              <PlainList className="!my-2">
                {block.ungrounded.map((statement) => <ListItem key={`${statement.line}:${statement.text}`}>{statement.text} <Text className="text-muted">({block.file}:{statement.line})</Text></ListItem>)}
              </PlainList>
            </Disclosure>
          </AlertDescription>
        </Alert>
      )}
      <KMarkdown text={block.markdown} resolutions={resolutions} sourcePath={block.file} {...(read ? { statements: { pageId: pageId!, showGrounds } } : {})} />
      {block.localized !== undefined && <Disclosure className="mt-5 border-t border-line pt-4" data-testid="localized-source">
        <DisclosureSummary className="cursor-pointer text-small font-medium text-secondary">{t('knowledge.localizedSource')}</DisclosureSummary>
        <KMarkdown text={block.localized.original} resolutions={resolutions} sourcePath={block.localized.sourceDocument} />
        <Paragraph className="m-0 mt-2 text-small text-muted" data-testid="localized-source-place">{block.localized.sourceDocument}:{block.localized.sourceLine}{block.localized.sourceEndLine === block.localized.sourceLine ? '' : `–${block.localized.sourceEndLine}`}</Paragraph>
      </Disclosure>}
    </PageSection>
  );
}

// ---- related, callers, callees ------------------------------------------------------------------

export function groupLabel(group: RelatedGroup, t: (key: string, options?: Record<string, unknown>) => string): string {
  return t(group.direction === 'out' ? 'knowledge.relationOut' : 'knowledge.relationIn', { relation: relationLabel(group.relation, t) });
}

/** One relation's rows: the table the `related` block and the `relations` block both draw. */
function RelationGroupTable({ group }: { group: RelatedGroup }): ReactElement {
  const { t } = useTranslation();
  const kindName = useKindName();
  return (
    <Stack data-relation={group.relation} data-direction={group.direction}>
      <Stack className="mb-1.5 flex items-center gap-2 text-small text-muted">
        <Text>{groupLabel(group, t)}</Text>
        <Badge>{group.total}</Badge>
      </Stack>
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
              <TableCell className="break-words">
                <EntityName entity={row.entity} />{row.count > 1 && <Text className="ml-1.5 text-muted">×{row.count}</Text>}
                {row.sources !== undefined && row.sources.length > 0 && <Text className="ml-1.5 text-small text-muted" data-testid="relation-source">{t('knowledge.relationSource', { sources: row.sources.join(', ') })}</Text>}
              </TableCell>
              <TableCell><Badge>{kindName(row.entity.kind, 'one')}</Badge></TableCell>
              <TableCell>{row.entity.location !== undefined ? <CodePlace location={row.entity.location} /> : <Text className="text-muted">–</Text>}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {group.total > group.rows.length && <Paragraph className="mt-1.5 text-small text-muted" data-testid="related-cut">{t('knowledge.showing', { shown: group.rows.length, total: group.total })}</Paragraph>}
    </Stack>
  );
}

function Related({ block }: { block: Extract<Block, { type: 'related' }> }): ReactElement | null {
  if (block.groups.length === 0) return null;
  return (
    <PageSection data-block="related" aria-label={block.title}>
      <SectionTitle>{block.title}</SectionTitle>
      <Stack className="flex flex-col gap-4">
        {block.groups.map((group) => <RelationGroupTable key={`${group.relation}:${group.direction}`} group={group} />)}
      </Stack>
    </PageSection>
  );
}

/**
 * The relations block: the entity's one-step neighbourhood through the three diagram engines, under the renderer
 * switcher, and the same relations as lists — outgoing and incoming by relation, and every entity with an edge to the
 * page. A page with no relation says so, never an empty frame.
 */
function Relations({ block }: { block: Extract<Block, { type: 'relations' }> }): ReactElement {
  const { t } = useTranslation();
  return (
    <PageSection data-block="relations" data-testid="relations-block" aria-label={block.title}>
      <SectionTitle>{block.title}</SectionTitle>
      {block.views.length === 0 ? (
        <Paragraph className="text-small text-muted" data-testid="relations-empty">{block.empty ?? t('knowledge.relationsEmpty')}</Paragraph>
      ) : (
        <>
          <DiagramsView block={{ type: 'diagrams', title: '', renderer: block.renderer, views: block.views }} />
          <Stack className="mt-5 flex flex-col gap-4" data-testid="relations-lists">
            {block.groups.map((group) => <RelationGroupTable key={`${group.relation}:${group.direction}`} group={group} />)}
          </Stack>
          {block.linksHere.length > 0 && (
            <Stack className="mt-6" data-testid="links-here">
              <SmallTitle className="mb-1.5 text-small font-medium text-secondary">{t('knowledge.linksHere')}</SmallTitle>
              <PlainList className="dg-elements">
                {block.linksHere.map((row) => (
                  <ListItem key={row.entity.id} data-entity={row.entity.id}>
                    <EntityName entity={row.entity} />
                    <Text className="ml-1.5 text-small text-muted">{row.relations.map((relation) => relationLabel(relation, t)).join(', ')}</Text>
                  </ListItem>
                ))}
              </PlainList>
            </Stack>
          )}
        </>
      )}
    </PageSection>
  );
}

function Calls({ block }: { block: Extract<Block, { type: 'callers' | 'callees' }> }): ReactElement {
  const { t } = useTranslation();
  if (block.rows.length === 0) {
    return (
      <PageSection data-block={block.type} aria-label={block.title}>
        <SectionTitle>{block.title}</SectionTitle>
        <Paragraph className="text-small text-muted" data-testid={`${block.type}-empty`}>{block.emptyNote ?? t('knowledge.none')}</Paragraph>
      </PageSection>
    );
  }
  const rows: CallRow[] = block.rows;
  return (
    <PageSection data-block={block.type} aria-label={block.title}>
      <SectionTitle>{block.title}</SectionTitle>
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
              <TableCell className="break-words"><EntityName entity={row.entity} /></TableCell>
              <TableCell>
                {block.type === 'callers' ? (row.site !== undefined ? <CodePlace location={row.site} /> : <Text className="text-muted">–</Text>) : (row.entity.location !== undefined ? <CodePlace location={row.entity.location} /> : <Text className="text-muted">–</Text>)}
              </TableCell>
              <TableCell>{row.sites}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {block.total > rows.length && <Paragraph className="mt-1.5 text-small text-muted" data-testid="calls-cut">{t('knowledge.showing', { shown: rows.length, total: block.total })}</Paragraph>}
    </PageSection>
  );
}

// ---- source -------------------------------------------------------------------------------------

/** Highlighted lines with their numbers; `focus` marks the line the reader was sent to. */
export function CodeLines({ text, language, firstLine, focus, marked, wrap = false }: { text: string; language: string; firstLine: number; focus?: number | null; marked?: { start: number; end: number }; wrap?: boolean }): ReactElement {
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
    <Preformatted className={`source-code${wrap ? ' source-code-wrap' : ''}`} data-testid="source-code" data-language={language} data-colored={shown !== null ? 'true' : 'false'} data-wrap={wrap ? 'true' : 'false'}>
      <InlineCode>
        {lines.map((tokens, index) => {
          const number = firstLine + index;
          return (
            <Text key={number} id={`L${number}`} className={'source-line' + (focus === number ? ' source-line-focus' : '') + (marked !== undefined && marked.start > 0 && number >= marked.start && number <= marked.end ? ' source-line-marked' : '')} data-line={number}>
              <Text className="source-number" aria-hidden="true">{number}</Text>
              <Text className="source-text">
                {shown !== null
                  ? shown[index]!.map((token, position) => <SyntaxToken key={position} colors={token.style} fontStyle={token.fontStyle}>{token.text}</SyntaxToken>)
                  : tokens.map((token, position) => <Text key={position} className={token.kind === 'plain' ? undefined : `tok-${token.kind}`}>{token.text}</Text>)}
                {'\n'}
              </Text>
            </Text>
          );
        })}
      </InlineCode>
    </Preformatted>
  );
}

function Source({ block }: { block: Extract<Block, { type: 'source' }> }): ReactElement {
  const { t } = useTranslation();
  const total = block.location.lineEnd - block.location.lineStart + 1;
  const shown = block.text === '' ? 0 : block.text.split('\n').length;
  return (
    <PageSection data-block="source" aria-label={block.title}>
      <SectionTitle>{block.title}</SectionTitle>
      <Card className="overflow-hidden">
        <CardHeader className="flex-row items-center justify-between gap-3 pb-3">
          <CardTitle className="min-w-0 flex-1 text-small"><CodePlace location={block.location} /></CardTitle>
          <Badge>{block.language}</Badge>
        </CardHeader>
        <CardContent className="px-0 pb-0 pt-0">
          <CodeLines text={block.text} language={block.language} firstLine={block.location.lineStart} />
          {block.truncated && (
            <Paragraph className="m-0 border-t border-line px-4 py-2 text-small text-muted" data-testid="source-cut">
              {t('knowledge.showing', { shown, total })} <KLink href={block.location.href}>{t('knowledge.openSource')}</KLink>
            </Paragraph>
          )}
        </CardContent>
      </Card>
    </PageSection>
  );
}

// ---- diagrams -----------------------------------------------------------------------------------

/** An instant as the wiki writes dates: the day and the time in the reader's language, the raw text where it is no date. */
function when(value: string, language: string): string {
  const instant = new Date(value);
  if (Number.isNaN(instant.getTime())) return value;
  return new Intl.DateTimeFormat(language, { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }).format(instant);
}

function Properties({ block }: { block: Extract<Block, { type: 'properties' }> }): ReactElement | null {
  const { t, i18n } = useTranslation();
  if (block.rows.length === 0) return null;
  return (
    <PageSection data-block="properties" aria-label={block.title}>
      <SectionTitle>{block.title}</SectionTitle>
      <Table>
        <TableHeader>
          <TableRow><TableHead>{t('knowledge.colProperty')}</TableHead><TableHead>{t('knowledge.colValue')}</TableHead></TableRow>
        </TableHeader>
        <TableBody>
          {block.rows.map((row) => (
            <TableRow key={row.name}>
              <TableCell className="whitespace-nowrap align-top font-mono text-small text-secondary">{row.label ?? (row.nameKey === undefined ? row.name : t(`knowledge.property.${row.nameKey}`))}</TableCell>
              <TableCell className="break-words">{row.valueKind === 'date' ? when(row.value, i18n.language) : row.valueKind === 'code' ? <InlineCode>{row.value}</InlineCode> : row.value}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </PageSection>
  );
}

/** The reader or writer list of one member: a few links, then a button that opens the rest. */
function MemberRefs({ refs, testId }: { refs: EntityRef[]; testId: 'member-readers' | 'member-writers' }): ReactElement {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  if (refs.length === 0) return <Text className="text-muted">—</Text>;
  const short = 3;
  const shown = open ? refs : refs.slice(0, short);
  return (
    <Stack className="flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5 text-small" data-testid={testId}>
      {shown.map((entity, at) => <Text key={entity.id}>{at > 0 && <Text className="text-muted">, </Text>}<EntityName entity={entity} /></Text>)}
      {refs.length > short && (
        <Button type="button" variant="link" size="content" data-testid="member-more" onClick={() => setOpen(!open)}>
          {open ? t('knowledge.memberLess') : t('knowledge.memberMore', { count: refs.length - short })}
        </Button>
      )}
    </Stack>
  );
}

function Members({ block }: { block: Extract<Block, { type: 'members' }> }): ReactElement | null {
  const { t, i18n } = useTranslation();
  if (block.rows.length === 0) return null;
  const names: string[] = [];
  for (const row of block.rows) for (const value of row.values) if (!names.includes(value.name)) names.push(value.name);
  const shared: { name: string; label?: string; value: string; valueKind?: PropertyRow['valueKind'] }[] = [];
  const columns: { name: string; label?: string }[] = [];
  if (block.kindLabel !== undefined) shared.push({ name: 'symbolKind', label: block.kindLabelName ?? t('knowledge.memberKind'), value: block.kindLabel });
  for (const name of names) {
    const held = block.rows.map((row) => row.values.find((value) => value.name === name));
    if (name === 'symbolKind' && block.kindLabel !== undefined) continue;
    const first = held.find((value) => value !== undefined);
    if (first !== undefined && held.every((value) => value !== undefined && value.value === first.value)) shared.push(first);
    else columns.push({ name, ...(first?.label === undefined ? {} : { label: first.label }) });
  }
  const hasReaders = block.rows.some((row) => row.readers.length > 0);
  const hasWriters = block.rows.some((row) => row.writers.length > 0);
  return (
    <PageSection data-block="members" aria-label={block.title}>
      <SectionTitle>{block.title}</SectionTitle>
      {shared.length > 0 && (
        <Paragraph className="mb-2 flex flex-wrap gap-x-2 gap-y-0.5 text-small text-muted" data-testid="member-shared">
          {shared.map((value, at) => (
            <Text key={value.name}>{at > 0 && <Text aria-hidden="true" className="mr-2">·</Text>}{value.label ?? value.name}: <Text className="text-ink">{value.valueKind === 'date' ? when(value.value, i18n.language) : value.valueKind === 'code' ? <InlineCode>{value.value}</InlineCode> : value.value}</Text></Text>
          ))}
        </Paragraph>
      )}
      <Table data-testid="member-table" density="compact">
        <TableHeader>
          <TableRow>
            <TableHead>{t('knowledge.memberName')}</TableHead>
            {columns.map((column) => <TableHead key={column.name}>{column.label ?? column.name}</TableHead>)}
            {hasReaders && <TableHead>{t('knowledge.memberReaders')}</TableHead>}
            {hasWriters && <TableHead>{t('knowledge.memberWriters')}</TableHead>}
          </TableRow>
        </TableHeader>
        <TableBody>
          {block.rows.map((row) => (
            <TableRow key={row.entity.id} id={row.anchor} data-testid="member-row" data-member={row.entity.id} className="scroll-mt-24 align-top">
              <TableCell className="min-w-36 align-top"><Text className="font-medium">{row.name ?? row.entity.label}</Text></TableCell>
              {columns.map((column) => {
                const value = row.values.find((entry) => entry.name === column.name);
                return <TableCell key={column.name} className="break-words align-top">{value === undefined ? <Text className="text-muted">—</Text> : value.valueKind === 'date' ? when(value.value, i18n.language) : value.valueKind === 'code' ? <InlineCode>{value.value}</InlineCode> : value.value}</TableCell>;
              })}
              {hasReaders && <TableCell className="align-top"><MemberRefs refs={row.readers} testId="member-readers" /></TableCell>}
              {hasWriters && <TableCell className="align-top"><MemberRefs refs={row.writers} testId="member-writers" /></TableCell>}
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {block.total > block.rows.length && <Paragraph className="mt-2 text-small text-muted" data-testid="members-cut">{t('knowledge.showing', { shown: block.rows.length, total: block.total })}</Paragraph>}
    </PageSection>
  );
}

function Refs({ block }: { block: Extract<Block, { type: 'refs' }> }): ReactElement {
  const { t } = useTranslation();
  const kindName = useKindName();
  return (
    <PageSection data-block="refs" aria-label={block.title}>
      <SectionTitle>{block.title}</SectionTitle>
      {block.rows.length === 0 ? <Paragraph className="text-small text-muted" data-testid="refs-empty">{t('knowledge.none')}</Paragraph> : (
        <Table>
          <TableHeader>
            <TableRow><TableHead>{t('knowledge.colName')}</TableHead><TableHead>{t('knowledge.colKind')}</TableHead><TableHead>{t('knowledge.colPlace')}</TableHead></TableRow>
          </TableHeader>
          <TableBody>
            {block.rows.map((row) => (
              <TableRow key={row.entity.id} data-entity={row.entity.id}>
                <TableCell className="break-words"><EntityName entity={row.entity} />{row.note !== undefined && <Text className="mt-0.5 block text-small text-muted" data-testid="ref-note">{row.noteKey === undefined ? row.note : t(`knowledge.refNote.${row.noteKey}`, { ...row.noteArgs, defaultValue: row.note })}</Text>}</TableCell>
                <TableCell><Badge>{row.entity.kind === 'document' ? t('knowledge.documentBadge') : kindName(row.entity.kind, 'one')}</Badge></TableCell>
                <TableCell>{row.entity.location !== undefined ? <CodePlace location={row.entity.location} /> : <Text className="text-muted">–</Text>}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {block.total > block.rows.length && <Paragraph className="mt-1.5 text-small text-muted" data-testid="refs-cut">{t('knowledge.showing', { shown: block.rows.length, total: block.total })}</Paragraph>}
    </PageSection>
  );
}

function Stated({ block }: { block: Extract<Block, { type: 'stated' }> }): ReactElement {
  const { t } = useTranslation();
  const place = block.place;
  const lines = place.lineEnd > place.lineStart ? `${place.lineStart}–${place.lineEnd}` : String(place.lineStart);
  return (
    <PageSection data-block="stated" aria-label={block.title}>
      <SectionTitle>{block.title}</SectionTitle>
      <Paragraph className="m-0 flex flex-wrap items-center gap-2">
        {place.single === true ? null : <Badge>{place.repo ?? t('knowledge.productRepository')}</Badge>}
        <KLink href={place.href} className="font-mono text-small"><Text data-testid="stated-place">{place.path}:{lines}</Text></KLink>
        {place.commit !== null && <Badge title={place.commit}>{place.commit.slice(0, 10)}</Badge>}
      </Paragraph>
    </PageSection>
  );
}

/** A diagram the page left to be read on its own: drawn when its read comes, a failure said with its reason. */
function Deferred({ block, pageId, resolutions }: { block: Extract<Block, { type: 'deferred' }>; pageId?: string; resolutions: Readonly<Record<string, Resolution>> }): ReactElement {
  const { t, i18n } = useTranslation();
  const [drawn, setDrawn] = useState<Block | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [opened, setOpened] = useState(false);
  useEffect(() => {
    if (pageId === undefined || (block.block === 'definition' && !opened)) return;
    const stop = new AbortController();
    setDrawn(null);
    setFailure(null);
    getBlock(pageId, block.id, i18n.resolvedLanguage ?? 'en', stop.signal).then(setDrawn, (error: unknown) => {
      if (!(error instanceof DOMException && error.name === 'AbortError')) setFailure(error instanceof Error ? error.message : String(error));
    });
    return () => stop.abort();
  }, [pageId, block.id, block.block, i18n.resolvedLanguage, opened]);
  if (block.block === 'definition') return <Disclosure data-testid="contract-definition-disclosure" onToggle={(event) => { if (event.currentTarget.open) setOpened(true); }}>
    <DisclosureSummary className="cursor-pointer text-secondary">{block.title}</DisclosureSummary>
    {opened && (drawn !== null ? <BlockView block={drawn} resolutions={resolutions} {...(pageId === undefined ? {} : {pageId})} /> : <Paragraph role={failure === null ? 'status' : 'alert'}>{failure ?? t('knowledge.contractLoading')}</Paragraph>)}
  </Disclosure>;
  if (drawn !== null) return <BlockView block={drawn} resolutions={resolutions} {...(pageId === undefined ? {} : { pageId })} />;
  return (
    <PageSection data-block="diagram" data-diagram="deferred" aria-label={block.title}>
      {block.title !== '' && <SectionTitle>{block.title}</SectionTitle>}
      {failure === null ? <Paragraph className="text-small text-muted" data-testid="diagram-loading">{t('knowledge.diagram.drawing')}</Paragraph> : <Paragraph className="ref-broken" data-testid="diagram-failure">{failure}</Paragraph>}
    </PageSection>
  );
}

/**
 * The figures whose word is counted: the numeral chooses the form of the word in the reader's language
 * (madarch-u3vw.7), so "1 commit", "2 commits", "5 commits" instead of one form glued to every numeral.
 * The kinds are #195's own list, so the app cannot drift from the page files by keeping a second copy.
 */
const countedKinds: ReadonlySet<string> = new Set(COUNTED_FIGURES);

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
    const key = `knowledge.historyFigure.${figure.kind}`;
    if (countedKinds.has(figure.kind)) return t(key, { count: Number(figure.value) });
    if (figure.kind === 'change') return t(key, { value: figure.value });
    if (figure.kind === 'renamed') return t(key, { value: figure.value });
    if (figure.kind === 'added') return `+${figure.value}`;
    if (figure.kind === 'removed') return `−${figure.value}`;
    return `${t(key)}: ${figure.value}`;
  };
  /** A badge's title: the same words for a counted figure, so it agrees with the numeral it names. */
  const figureTitle = (figure: { kind: string; value: string }): string => (countedKinds.has(figure.kind) || ['change', 'renamed'].includes(figure.kind) ? figureText(figure) : t(`knowledge.historyFigure.${figure.kind}`));
  return (
    <PageSection data-block="history" aria-label={block.title}>
      <SectionTitle>{block.title}</SectionTitle>
      {block.sections.length === 0 ? <Paragraph className="text-small text-muted" data-testid="history-empty">{t('knowledge.none')}</Paragraph> : block.sections.map((section) => (
        <Stack key={`${section.role}-${block.sections.indexOf(section)}`} data-history-section={section.role} className="mb-4">
          {block.sections.length > 1 && <SmallTitle className="text-small text-muted">{section.repository === undefined ? '' : `${section.repository}: `}{t(`knowledge.historySection.${section.role}`)}</SmallTitle>}
          {section.role === 'summary' ? <Paragraph className="flex flex-wrap items-center gap-1" data-testid="history-summary">{section.rows.flatMap((row, at) => row.figures.map((figure, figureAt) => <Badge key={`${figure.kind}-${String(at)}-${String(figureAt)}`} data-figure={figure.kind} title={figureTitle(figure)}>{figureText(figure)}</Badge>))}</Paragraph> : <Table>
            <TableHeader>
              <TableRow>
                {section.role === 'commits' && <TableHead>{t('knowledge.historyColWhen')}</TableHead>}
                {section.role === 'commits' && <TableHead>{t('knowledge.historyColWho')}</TableHead>}
                <TableHead>{section.role === 'files' || section.role === 'hotspots' ? t('knowledge.historyColFile') : t('knowledge.historyColWhat')}</TableHead>
                <TableHead>{t('knowledge.historyColFigures')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {section.rows.map((row, index) => (
                <TableRow key={row.entity?.id ?? `${section.role}-${String(index)}`} {...(row.entity === undefined ? {} : {'data-entity': row.entity.id})}>
                  {section.role === 'commits' && <TableCell className="whitespace-nowrap">{row.when ?? <Text className="text-muted">–</Text>}</TableCell>}
                  {section.role === 'commits' && <TableCell className="whitespace-nowrap">{row.who ?? <Text className="text-muted">–</Text>}</TableCell>}
                  <TableCell className="break-words">
                    {row.entity === undefined ? row.text : <><EntityName entity={row.entity} />{row.text !== row.entity.label && <Text className="block break-all text-small text-muted">{row.text}</Text>}</>}
                  </TableCell>
                  <TableCell>
                    <Text className="flex flex-wrap items-center gap-1">
                      {row.figures.map((figure, at) => (
                        <Badge key={`${figure.kind}-${String(at)}`} data-figure={figure.kind} title={figureTitle(figure)}>
                          {figureText(figure)}
                        </Badge>
                      ))}
                      {row.figures.length === 0 && <Text className="text-muted">–</Text>}
                    </Text>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>}
          {section.total > section.rows.length && <Paragraph className="mt-1.5 text-small text-muted" data-testid="history-cut">{t('knowledge.showing', { shown: section.rows.length, total: section.total })}</Paragraph>}
        </Stack>
      ))}
      {block.notes.length > 0 && (
        <PlainList className="mt-1.5 text-small text-muted" data-testid="history-notes">
          {block.notes.map((note, index) => <ListItem key={index}>{historyNoteText(note, t)}</ListItem>)}
        </PlainList>
      )}
      {block.more !== undefined && (
        <Paragraph data-testid="history-more" className="mt-1.5 text-small">
          <KLink href={block.more.href}>{block.more.label} →</KLink>
        </Paragraph>
      )}
    </PageSection>
  );
}

/**
 * A contract's definition in its own format (madarch-m38l.16): the operations of an OpenAPI document, the channels and
 * their messages of an AsyncAPI document, or the services and rpcs of a protobuf file, each at an anchor a link can open
 * the page at, beside the contract's own text. The block arrives deferred, so a reader pays for it only when they open it.
 */
const ContractView = lazy(() => import('./contract-view.js'));
function Definition({block}: {block: Extract<Block, {type: 'definition'}>}): ReactElement {
  const {t} = useTranslation();
  return <Suspense fallback={<Paragraph role="status">{t('knowledge.contractLoading')}</Paragraph>}><ContractView block={block} /></Suspense>;
}

function Problem({ block }: { block: Extract<Block, { type: 'problem' }> }): ReactElement {
  const { t } = useTranslation();
  return (
    <Alert variant="problem" className="my-4" data-testid="block-problem">
      <AlertTitle>{t('knowledge.blockProblem', { block: block.block })}</AlertTitle>
      <AlertDescription>
        {block.block === 'definition' && block.diagnostic !== undefined ? <ContractDiagnosticView diagnostic={block.diagnostic} /> : <Paragraph>{block.message}</Paragraph>}
        <Paragraph className="font-mono text-small text-muted">{block.file}:{block.line}</Paragraph>
      </AlertDescription>
    </Alert>
  );
}


/** One section of the product overview (madarch-47vw.5): its words, its diagram, its rows or links, or what brings it. */
function Overview({ block }: { block: Extract<Block, { type: 'overview' }> }): ReactElement {
  return (
    <PageSection data-block="overview" data-overview={block.section} className="mb-6" aria-label={block.title}>
      <SectionTitle>{block.title}</SectionTitle>
      {block.paragraphs?.map((paragraph, at) => (
        <Paragraph key={at} className="break-words">
          {paragraph.text}
          {paragraph.source !== undefined && <Text className="ml-2 whitespace-nowrap text-small text-muted">· <KLink href={paragraph.source.href}>{paragraph.source.label}</KLink></Text>}
        </Paragraph>
      ))}
      {block.diagrams !== undefined && <DiagramsView block={block.diagrams} />}
      {block.rows !== undefined && block.rows.length > 0 && (
        <DefinitionList className="m-0 grid gap-2 text-small" data-testid="overview-rows">
          {block.rows.map((row, at) => (
            <Stack key={`${row.label}-${String(at)}`} className="grid grid-cols-2 gap-x-4">
              <DefinitionTerm className="break-words font-medium text-ink">{row.href === undefined ? row.label : <KLink href={row.href}>{row.label}</KLink>}</DefinitionTerm>
              <DefinitionValue className="m-0 break-words text-secondary">
                {row.value}
                {row.note !== undefined && <Text className="ml-2 text-muted">{row.note}</Text>}
                {row.source !== undefined && <Text className="ml-2 whitespace-nowrap text-small text-muted">· <KLink href={row.source.href}>{row.source.label}</KLink></Text>}
              </DefinitionValue>
            </Stack>
          ))}
        </DefinitionList>
      )}
      {block.links !== undefined && block.links.length > 0 && (
        <PlainList className="m-0 list-none p-0 text-small" data-testid="overview-links">
          {block.links.map((link) => <ListItem key={`${link.label}-${link.href ?? ''}`} className="py-0.5"><KLink href={link.href ?? '#'}>{link.label}</KLink>{link.value !== undefined && <Text className="ml-2 text-muted">{link.value}</Text>}</ListItem>)}
        </PlainList>
      )}
      {block.absent !== undefined && (
        <Paragraph className="m-0 text-small text-muted" data-testid="overview-absent">
          {block.absent.message} <KLink href={block.absent.href}>{block.absent.label}</KLink>
        </Paragraph>
      )}
    </PageSection>
  );
}

/** One block of a page. */
export function BlockView({ block, resolutions, pageId }: { block: Block; resolutions: Readonly<Record<string, Resolution>>; pageId?: string }): ReactElement | null {
  switch (block.type) {
    case 'guide': return <PageSection data-block="guide" data-walk-status={block.data.walk.status}><KMarkdown text={block.data.markdown} resolutions={resolutions} /></PageSection>;
    case 'markdown': return <KMarkdown text={block.markdown} resolutions={resolutions} />;
    case 'term': return <TermBlockView block={block} pageId={pageId ?? ''} resolutions={resolutions} />;
    case 'body': return <Body block={block} resolutions={resolutions} {...(pageId === undefined ? {} : { pageId })} />;
    case 'refs': return <Refs block={block} />;
    case 'properties': return <Properties block={block} />;
    case 'members': return <Members block={block} />;
    case 'stated': return <Stated block={block} />;
    case 'related': return <Related block={block} />;
    case 'callers':
    case 'callees': return <Calls block={block} />;
    case 'source': return <Source block={block} />;
    case 'graph': return <NeighborhoodGraph block={block} />;
    case 'diagrams': return <DiagramsView block={block} />;
    case 'relations': return <Relations block={block} />;
    case 'treemap': return <TreemapView block={block} />;
    case 'files': return <FilesTableView block={block} />;
    case 'history': return <History block={block} />;
    case 'overview': return <Overview block={block} />;
    case 'definition': return <Definition block={block} />;
    case 'deferred': return <Deferred block={block} resolutions={resolutions} {...(pageId === undefined ? {} : { pageId })} />;
    case 'repository': return <RepositoryFactsBlock data={block.data} />;
    case 'folder': return <FolderBlock data={block.data} />;
    case 'file': return <FileFactsBlock data={block.data} />;
    case 'filePage': return <FilePageView block={block} resolutions={resolutions} />;
    case 'problem': return <Problem block={block} />;
  }
}

/**
 * The findings a page carries. A reader is told in plain words what a finding means and who puts it right; the file and
 * line of each, which an engineer needs, are behind "Details" so the page reads first.
 */
export function Findings({ findings, scope = 'page' }: { findings: readonly { file: string; line: number; message: string }[]; scope?: 'page' | 'manifest' }): ReactElement | null {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const visible = scope === 'manifest' ? [...new Map(findings.map((finding) => [`${finding.file}:${finding.line}:${finding.message}`, finding])).values()] : findings;
  const words = (message: string): string => {
    const missingGroup = /^kind "([^"]+)": "group" names a group of "groups" (?:\([^)]*\)|.*?), got "([^"]+)"$/.exec(message);
    if (missingGroup !== null) {
      const kind = t(`knowledge.manifestKinds.${missingGroup[1]}`, { defaultValue: missingGroup[1] });
      return t('knowledge.manifestMissingGroup', { kind, group: missingGroup[2] });
    }
    return message;
  };
  if (visible.length === 0) return null;
  return (
    <Alert variant="problem" className={scope === 'manifest' ? 'mb-8' : 'mt-8'} data-testid={scope === 'manifest' ? 'manifest-findings' : 'findings'}>
      <AlertTitle>{t('knowledge.findings', { count: visible.length })}</AlertTitle>
      <AlertDescription>
        <Paragraph data-testid="findings-help">{scope === 'manifest' ? t('knowledge.manifestFindingsHelp') : t('knowledge.findingsHelp')}</Paragraph>
        {scope === 'manifest' && <Paragraph className="mt-1"><KLink href={WIKI_PROBLEMS}>{t('errors.problems')}</KLink></Paragraph>}
        <Button type="button" variant="link" size="content" aria-expanded={open} onClick={() => setOpen(!open)} data-testid="findings-details">
          {open ? t('knowledge.findingsHide') : t('knowledge.findingsDetails')}
        </Button>
        {open && (
          <PlainList className="!my-2">
            {visible.map((finding, index) => <ListItem key={`${finding.file}:${finding.line}:${index}`}><Text className="font-mono text-small">{finding.file}:{finding.line}</Text> {scope === 'manifest' ? words(finding.message) : finding.message}</ListItem>)}
          </PlainList>
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
