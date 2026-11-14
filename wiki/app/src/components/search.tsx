/**
 * The product's search (decision 0036, section 7): the `search` root over labels and text fields, its answers grouped by
 * the kind they belong to, each group wearing the catalogue's word for the kind in the reader's language. The field in
 * the top bar asks as the reader types and opens a results page on Enter; a results page asks once for the text its
 * address names, so a reader can keep the address.
 */
import { useMemo, useState, type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { postQuery } from '../client.js';
import { Button } from './ui/button.js';
import { FilterBar, FilterField } from './ui/filter-bar.js';
import { Input } from './ui/input.js';
import { SearchGroupTitle, SearchResultLink, SearchResults } from './ui/search-results.js';
import { Metadata, Paragraph, Stack } from './ui/typography.js';
import { edgesOf, entityHref, totalOf } from './connection.js';
import { follow } from './relations.js';
import type { SectionContext } from './types.js';

/** One answer of the search root: the connection of entities whose label or text holds the words asked. */
export interface SearchAnswer {
  readonly edges: readonly Record<string, unknown>[];
  readonly totalCount: number;
}

/** The query one search runs: the root of section 1, over every kind or the ones the section names. */
export function searchQuery(kinds: readonly string[] | undefined): string {
  const selection = 'edges { node { id kind label template } } totalCount';
  return kinds === undefined
    ? `query Search($text: String!, $first: Int) { search(text: $text, first: $first) { ${selection} } }`
    : `query Search($text: String!, $first: Int, $kinds: [String!]) { search(text: $text, kinds: $kinds, first: $first) { ${selection} } }`;
}

/** One search over the graph, or the words that refused it. */
export async function askSearch(base: string, text: string, kinds: readonly string[] | undefined, first: number): Promise<{ answer?: SearchAnswer; failure?: string }> {
  const trimmed = text.trim();
  if (trimmed === '') return { answer: { edges: [], totalCount: 0 } };
  const result = await postQuery<{ search?: SearchAnswer }>(base, searchQuery(kinds), { text: trimmed, first, ...(kinds === undefined ? {} : { kinds }) });
  if (result.errors.length > 0) return { failure: result.errors.map((error) => error.message).join('; ') };
  return { answer: result.data?.search ?? { edges: [], totalCount: 0 } };
}

/** The kind's word in the reader's language, from the frame's one navigation read; the kind's name when it is unknown. */
export function kindWordOf(kind: unknown, context: SectionContext): string {
  const name = typeof kind === 'string' ? kind : '';
  return context.navigation?.kinds.find((one) => one.kind === name)?.many ?? name;
}

/** The answers of one search, grouped by kind, each row a link to the entity's page. */
export function ResultsOf({ answer, base, open, kindWord, testId }: {
  readonly answer: SearchAnswer;
  readonly base: string;
  readonly open: (path: string) => void;
  readonly kindWord: (kind: unknown) => string;
  readonly testId?: string;
}): ReactElement {
  const groups = new Map<string, Record<string, unknown>[]>();
  for (const edge of answer.edges) {
    const node = (edge['node'] ?? {}) as Record<string, unknown>;
    const kind = typeof node['kind'] === 'string' ? node['kind'] : '';
    const rows = groups.get(kind) ?? [];
    rows.push(node);
    groups.set(kind, rows);
  }
  return (
    <SearchResults data-testid={testId ?? 'search-results'}>
      <Metadata>{`${String(answer.totalCount)}`}</Metadata>
      {[...groups.entries()].map(([kind, rows]) => (
        <div key={kind}>
          <SearchGroupTitle>{kindWord(kind)}</SearchGroupTitle>
          {rows.map((node) => {
            const href = entityHref(node);
            const label = String(node['label'] ?? '') || (href ?? '');
            return href === undefined
              ? <Paragraph key={label}>{label}</Paragraph>
              : <SearchResultLink key={href} active={false} href={base + href} onClick={follow(open, base + href)}>{label}</SearchResultLink>;
          })}
        </div>
      ))}
    </SearchResults>
  );
}

/** The search of a results page: the text its address names, asked once, drawn as the groups of its kinds. */
export function SearchPageSection({ context }: { readonly context: SectionContext }): ReactElement {
  const { t } = useTranslation();
  const answer = useMemo(() => ({ edges: edgesOf(context.data), totalCount: totalOf(context.data) }), [context.data]);
  return (
    <Stack>
      <Metadata>{`${t('knowledge.searchResults')} · ${String(answer.totalCount)}`}</Metadata>
      {answer.edges.length === 0 ? <Paragraph>{t('knowledge.searchEmpty')}</Paragraph> : <ResultsOf answer={answer} base={context.base} open={context.open} kindWord={(kind) => kindWordOf(kind, context)} testId="search-page-results" />}
    </Stack>
  );
}

/** The search section of a template: its own field and answers, for a page that holds one. */
export function SearchSection({ context }: { readonly context: SectionContext }): ReactElement {
  const { t } = useTranslation();
  if ((context.section.query ?? '').trim() !== '') return <SearchPageSection context={context} />;
  const [text, setText] = useState('');
  const [answer, setAnswer] = useState<SearchAnswer | undefined>(undefined);
  const [failed, setFailed] = useState<string | undefined>(undefined);
  const kinds = Array.isArray(context.section.params['kinds']) ? (context.section.params['kinds'] as string[]).filter((one) => typeof one === 'string') : undefined;
  const ask = async (): Promise<void> => {
    const result = await askSearch(context.base, text, kinds, 20);
    if (result.failure !== undefined) { setFailed(result.failure); return; }
    setFailed(undefined);
    setAnswer(result.answer);
  };
  return (
    <Stack>
      <FilterBar>
        <FilterField>
          {t('knowledge.searchLabel')}
          <Input value={text} aria-label={t('knowledge.searchLabel')} placeholder={t('knowledge.searchPlaceholder')} onChange={(event) => { setText(event.target.value); }} onKeyDown={(event) => { if (event.key === 'Enter') void ask(); }} />
        </FilterField>
        <Button variant="default" size="sm" onClick={() => { void ask(); }}>{t('knowledge.searchButton')}</Button>
      </FilterBar>
      {failed === undefined ? null : <Paragraph>{failed}</Paragraph>}
      {answer === undefined ? null : (answer.edges.length === 0 ? <Paragraph>{t('knowledge.searchEmpty')}</Paragraph> : <ResultsOf answer={answer} base={context.base} open={context.open} kindWord={(kind) => kindWordOf(kind, context)} />)}
    </Stack>
  );
}
