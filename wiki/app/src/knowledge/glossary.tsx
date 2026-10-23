/**
 * The glossary of a product in the wiki (decision 0031): the page that lists its
 * terms with their definitions, synonyms, code names and where each is stated, a
 * term's block, and the links from the text of every page to the entry of a term
 * it uses. A link is made only where the words are the term (or one of its
 * synonyms) whole and in the same case; nothing is guessed. A name that two
 * terms both claim is linked to neither.
 */
import { createContext, useContext, useEffect, useMemo, useState, type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, AlertDescription } from '@/components/ui/alert.js';
import { Badge } from '@/components/ui/badge.js';
import { Input } from '@/components/ui/input.js';
import { getGlossary } from './api.js';
import { KLink, KMarkdown } from './blocks.js';
import { PageSkeleton } from './skeleton.js';
import { addressOfDocument } from './routes.js';
import { useTabTitle } from './tabs.js';
import type { Glossary, GlossaryTerm, Resolution } from './types.js';
import type { MNode } from './statements.js';

/** The names that link to a term: its title and its synonyms. */
export interface TermIndex {
  /** Name to the term it names. */
  names: ReadonlyMap<string, GlossaryTerm>;
  /** The names in the order the matcher tries them: the longest first. */
  pattern: RegExp | null;
}

export const NO_TERMS: TermIndex = { names: new Map(), pattern: null };
export const GlossaryContext = createContext<{ index: TermIndex; terms: readonly GlossaryTerm[] }>({ index: NO_TERMS, terms: [] });

const WORD_EDGE = '(?<![\\p{L}\\p{N}_])';
const WORD_END = '(?![\\p{L}\\p{N}_])';

/** The index of a glossary's names. A name claimed by two different terms is left out: no guessing. */
export function termIndex(terms: readonly GlossaryTerm[]): TermIndex {
  const claimed = new Map<string, GlossaryTerm | null>();
  for (const term of terms) {
    for (const name of [term.title, ...term.synonyms]) {
      const trimmed = name.trim();
      if (trimmed === '') continue;
      const held = claimed.get(trimmed);
      claimed.set(trimmed, held === undefined || held === term ? term : null);
    }
  }
  const names = new Map<string, GlossaryTerm>();
  for (const [name, term] of claimed) if (term !== null) names.set(name, term);
  if (names.size === 0) return NO_TERMS;
  const escaped = [...names.keys()].sort((a, b) => b.length - a.length || (a < b ? -1 : 1)).map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return { names, pattern: new RegExp(`${WORD_EDGE}(?:${escaped.join('|')})${WORD_END}`, 'gu') };
}

/** Containers whose text is read for terms; the first occurrence of a term in each is linked. */
const CONTAINERS = new Set(['paragraph', 'tableCell']);
/** Nodes whose text is never read for terms: it is already a link or code. */
const SKIP = new Set(['link', 'linkReference', 'inlineCode', 'code', 'footnoteDefinition', 'definition', 'html', 'heading']);

/**
 * A remark plugin: in the text of a paragraph or a table cell, the first use of each term becomes a link to its entry.
 * `except` is the id of the entry the page is itself (a term does not link to itself).
 */
export function remarkTerms(index: TermIndex, except?: string): () => (tree: MNode) => void {
  return () => (tree) => {
    if (index.pattern === null) return;
    const pattern = index.pattern;
    const visit = (node: MNode): void => {
      if (SKIP.has(node.type)) return;
      if (CONTAINERS.has(node.type)) linkIn(node);
      else for (const child of node.children ?? []) visit(child);
    };
    const linkIn = (container: MNode): void => {
      const seen = new Set<string>();
      const walk = (node: MNode): void => {
        if (node.children === undefined) return;
        const next: MNode[] = [];
        for (const child of node.children) {
          if (child.type === 'text') {
            const text = child.value ?? '';
            let at = 0;
            pattern.lastIndex = 0;
            for (const match of text.matchAll(pattern)) {
              const term = index.names.get(match[0]);
              if (term === undefined || term.id === except || seen.has(term.id)) continue;
              seen.add(term.id);
              if (match.index! > at) next.push({ type: 'text', value: text.slice(at, match.index) });
              next.push({ type: 'link', url: term.href, children: [{ type: 'text', value: match[0] }], data: { hProperties: { className: 'term-link', title: term.definition.split('\n')[0] ?? '' } } });
              at = match.index! + match[0].length;
            }
            next.push(at === 0 ? child : { type: 'text', value: text.slice(at) });
          } else {
            if (!SKIP.has(child.type)) walk(child);
            next.push(child);
          }
        }
        node.children = next;
      };
      walk(container);
    };
    visit(tree);
  };
}

/** The product's glossary, read once per version of the wiki, for the links of the text and for the page. */
export function useGlossary(version: number): { glossary: Glossary | null; error: string | null } {
  const [glossary, setGlossary] = useState<Glossary | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    getGlossary(controller.signal).then(
      (answer) => { setGlossary(answer); setError(null); },
      (failure: unknown) => { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : String(failure)); },
    );
    return () => controller.abort();
  }, [version]);
  return { glossary, error };
}

export function useGlossaryValue(glossary: Glossary | null): { index: TermIndex; terms: readonly GlossaryTerm[] } {
  return useMemo(() => ({ index: glossary === null ? NO_TERMS : termIndex(glossary.terms), terms: glossary?.terms ?? [] }), [glossary]);
}

export const useTerms = (): { index: TermIndex; terms: readonly GlossaryTerm[] } => useContext(GlossaryContext);

function Names({ term }: { term: GlossaryTerm }): ReactElement | null {
  const { t } = useTranslation();
  if (term.synonyms.length === 0 && term.code.length === 0) return null;
  return (
    <dl className="mb-2 mt-0 grid gap-x-3 gap-y-1 text-small" data-testid="term-names">
      {term.synonyms.length > 0 && <div className="flex flex-wrap items-baseline gap-2"><dt className="text-muted">{t('knowledge.glossary.alsoCalled')}</dt><dd className="m-0">{term.synonyms.join(', ')}</dd></div>}
      {term.code.length > 0 && <div className="flex flex-wrap items-baseline gap-2"><dt className="text-muted">{t('knowledge.glossary.inCode')}</dt><dd className="m-0">{term.code.map((name) => <code key={name} className="mr-1.5">{name}</code>)}</dd></div>}
    </dl>
  );
}

/** The ambiguity of a term, in the words the document gave it; the question it links to is a link of that text. */
function Ambiguity({ term, pageId, resolutions }: { term: Pick<GlossaryTerm, 'ambiguous' | 'id'>; pageId?: string; resolutions: Readonly<Record<string, Resolution>> }): ReactElement | null {
  const { t } = useTranslation();
  if (term.ambiguous === null) return null;
  return (
    <Alert variant="problem" className="mb-2" data-testid="term-ambiguous">
      <AlertDescription>
        <p><b>{t('knowledge.glossary.ambiguous')}</b> {term.ambiguous === '-' ? t('knowledge.glossary.ambiguousNoNote') : ''}</p>
        {term.ambiguous !== '-' && <KMarkdown text={term.ambiguous} resolutions={resolutions} {...(pageId === undefined ? {} : { exceptTerm: pageId })} />}
      </AlertDescription>
    </Alert>
  );
}

/** The block of a term's page. */
export function TermBlockView({ block, pageId, resolutions }: { block: { definition: string; synonyms: string[]; code: string[]; usedIn: string | null; ambiguous: string | null }; pageId: string; resolutions: Readonly<Record<string, Resolution>> }): ReactElement {
  const { t } = useTranslation();
  const term = { ...block, id: pageId };
  return (
    <section data-block="term">
      <KMarkdown text={upperFirst(block.definition)} resolutions={resolutions} exceptTerm={pageId} />
      <Names term={term as unknown as GlossaryTerm} />
      <Ambiguity term={term} pageId={pageId} resolutions={resolutions} />
      {block.usedIn !== null && <div className="mb-2 text-small"><span className="text-muted">{t('knowledge.glossary.usedIn')} </span><KMarkdown text={block.usedIn} resolutions={resolutions} /></div>}
    </section>
  );
}

/** A definition starts a sentence on the page whatever case the document wrote it in. */
export const upperFirst = (text: string): string => (text === '' ? text : text.charAt(0).toLocaleUpperCase() + text.slice(1));

/** The terms whose name, synonym or code name holds the text, in any case; all of them for an empty text. */
export function filterTerms(terms: readonly GlossaryTerm[], query: string): GlossaryTerm[] {
  const text = query.trim().toLowerCase();
  return terms.filter((term) => text === '' || [term.title, ...term.synonyms, ...term.code].some((name) => name.toLowerCase().includes(text)));
}

/** The glossary page: every term with its definition, names, ambiguity and the document and line it is stated at. */
export function GlossaryPage({ version }: { version: number }): ReactElement {
  const { t } = useTranslation();
  const { glossary, error } = useGlossary(version);
  const [query, setQuery] = useState('');
  useTabTitle(t('knowledge.glossary.title'));
  if (glossary === null && error === null) return <PageSkeleton testId="glossary-loading" rows />;
  if (glossary === null) return <Alert variant="problem" data-testid="glossary-error"><AlertDescription><p>{error}</p></AlertDescription></Alert>;
  const shown = filterTerms(glossary.terms, query);
  return (
    <section data-testid="glossary-page">
      <header className="mb-6">
        <h1>{t('knowledge.glossary.title')}</h1>
        <p>{t('knowledge.glossary.lead', { count: glossary.terms.length })}</p>
        <Input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t('knowledge.filter')} aria-label={t('knowledge.filter')} className="max-w-sm" data-testid="glossary-filter" />
      </header>
      {glossary.terms.length === 0 && <p className="text-muted" data-testid="glossary-empty">{t('knowledge.glossary.empty')}</p>}
      <ul className="m-0 list-none p-0">
        {shown.map((term) => (
          <li key={term.id} id={term.id} style={{ listStyle: 'none' }} className="mb-6 border-b border-line pb-5" data-testid="glossary-term" data-term={term.title} data-ambiguous={term.ambiguous === null ? 'false' : 'true'}>
            <h2 className="!mb-1 !mt-0 flex flex-wrap items-center gap-2 !text-[1.15rem]">
              <KLink href={term.href} className="text-ink">{term.title}</KLink>
              {term.ambiguous !== null && <Badge data-testid="term-ambiguous-badge">{t('knowledge.glossary.ambiguousBadge')}</Badge>}
            </h2>
            <KMarkdown text={upperFirst(term.definition)} resolutions={glossary.resolutions} exceptTerm={term.id} />
            <Names term={term} />
            <Ambiguity term={term} pageId={term.id} resolutions={glossary.resolutions} />
            {term.usedIn !== null && <div className="mb-2 text-small"><span className="text-muted">{t('knowledge.glossary.usedIn')} </span><KMarkdown text={term.usedIn} resolutions={glossary.resolutions} /></div>}
            <p className="m-0 text-small text-muted" data-testid="term-ground">
              {t('knowledge.glossary.statedAt')}{' '}
              <KLink href={addressOfDocument(term.repo, term.path, term.anchor)} className="font-mono">{term.repo === null ? term.path : `${term.repo}/${term.path}`}:{term.line}</KLink>
            </p>
          </li>
        ))}
      </ul>
      {glossary.terms.length > 0 && shown.length === 0 && <p className="text-muted">{t('knowledge.nothingOfKind')}</p>}
    </section>
  );
}
