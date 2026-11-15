/**
 * The product's search (decision 0036, section 7): the `searchGroups` root over labels and text fields, its answers
 * grouped by the kind they belong to, each group wearing the catalogue's word and its count, and every row the line a
 * reader knows it by (a file's path, a commit's short hash and its message). The top bar asks as the reader types; Enter
 * opens the results page, which asks the same root for the text its address names.
 */
import { useMemo, useState, type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { postQuery } from '../client.js';
import { Button } from './ui/button.js';
import { FilterBar, FilterField } from './ui/filter-bar.js';
import { Input } from './ui/input.js';
import { SearchGroupTitle, SearchResultLink, SearchResults } from './ui/search-results.js';
import { Metadata, Paragraph, Stack } from './ui/typography.js';
import { follow } from './relations.js';
import type { SectionContext } from './types.js';

/** One row of the search's answer: the entity and the line it is shown by. */
export interface SearchHit {
  readonly node: Record<string, unknown>;
  readonly line: string;
}

/** One kind's answers: its name, the catalogue's word for it, how many it holds and its best rows. */
export interface SearchGroup {
  readonly kind: string;
  readonly label: string;
  readonly count: number;
  readonly results: readonly SearchHit[];
}

/** The query one search runs: the grouped root of section 7, over every kind or the ones a section names. */
export function searchQuery(kinds: readonly string[] | undefined): string {
  const selection = 'kind label count results { node { id kind label template } line }';
  return kinds === undefined
    ? `query Search($text: String!, $perKind: Int, $lang: String) { searchGroups(text: $text, perKind: $perKind, lang: $lang) { ${selection} } }`
    : `query Search($text: String!, $perKind: Int, $kinds: [String!], $lang: String) { searchGroups(text: $text, kinds: $kinds, perKind: $perKind, lang: $lang) { ${selection} } }`;
}

/** One search over the graph, grouped by kind, or the words that refused it. */
export async function askSearch(base: string, text: string, kinds: readonly string[] | undefined, perKind: number, lang: string): Promise<{ groups?: readonly SearchGroup[]; failure?: string }> {
  const trimmed = text.trim();
  if (trimmed === '') return { groups: [] };
  const result = await postQuery<{ searchGroups?: SearchGroup[] }>(base, searchQuery(kinds), { text: trimmed, perKind, lang, ...(kinds === undefined ? {} : { kinds }) });
  if (result.errors.length > 0) return { failure: result.errors.map((error) => error.message).join('; ') };
  return { groups: result.data?.searchGroups ?? [] };
}

/** How many answers the groups hold together. */
export function totalOfGroups(groups: readonly SearchGroup[]): number {
  return groups.reduce((sum, group) => sum + group.count, 0);
}

/** One row of the answers as the reader walks them with the arrow keys. */
export interface SearchRow {
  readonly href: string;
  readonly line: string;
  readonly kind: string;
  readonly label: string;
}

/** The rows of every group, in the order they are drawn: what the keyboard walks. */
export function rowsOf(groups: readonly SearchGroup[], base: string): SearchRow[] {
  const rows: SearchRow[] = [];
  for (const group of groups) {
    for (const hit of group.results) {
      if (typeof hit.node['kind'] !== 'string' || typeof hit.node['id'] !== 'string') continue;
      rows.push({
        href: `${base}/e/${encodeURIComponent(String(hit.node['kind']))}/${encodeURIComponent(String(hit.node['id']))}`,
        line: hit.line,
        kind: group.kind,
        label: group.label,
      });
    }
  }
  return rows;
}

/** The answers grouped by kind: each kind's word and count, its best rows, and the way to the whole answer. */
export function GroupsOf({ groups, base, open, resultsHref, testId, active = -1 }: {
  readonly groups: readonly SearchGroup[];
  readonly base: string;
  readonly open: (path: string) => void;
  /** Where the whole answer stands, when the page is not already it. */
  readonly resultsHref?: string;
  readonly testId?: string;
  /** The row the arrow keys stand on: it is drawn as the active one. */
  readonly active?: number;
}): ReactElement {
  const { t } = useTranslation();
  const total = totalOfGroups(groups);
  let at = -1;
  return (
    <SearchResults data-testid={testId ?? 'search-results'}>
      {groups.map((group) => (
        <div key={group.kind}>
          <SearchGroupTitle>{`${group.kind === 'catalogue' ? t('knowledge.catalogueKinds') : group.label} · ${new Intl.NumberFormat().format(group.count)}`}</SearchGroupTitle>
          {group.results.map((hit) => {
            const href = typeof hit.node['kind'] === 'string' && typeof hit.node['id'] === 'string'
              ? `${base}/e/${encodeURIComponent(String(hit.node['kind']))}/${encodeURIComponent(String(hit.node['id']))}`
              : undefined;
            at += 1;
            const here = at === active;
            return href === undefined
              ? <Paragraph key={hit.line}>{hit.line}</Paragraph>
              : <SearchResultLink key={href} active={here} aria-current={here ? 'true' : undefined} data-testid="search-row" href={href} onClick={follow(open, href)}>{hit.line}</SearchResultLink>;
          })}
        </div>
      ))}
      {resultsHref === undefined ? null : (
        <SearchResultLink active={false} href={base + resultsHref} onClick={follow(open, base + resultsHref)} data-testid="search-all">
          {t('knowledge.searchAll', { count: total })}
        </SearchResultLink>
      )}
    </SearchResults>
  );
}

/** The search of a results page: the text its address names, asked once, drawn as the groups of its kinds. */
export function SearchPageSection({ context }: { readonly context: SectionContext }): ReactElement {
  const { t } = useTranslation();
  const groups = useMemo(() => (Array.isArray(context.data) ? (context.data as SearchGroup[]) : []), [context.data]);
  return (
    <Stack>
      <Metadata>{t('knowledge.searchResults')}</Metadata>
      {groups.length === 0 ? <Paragraph>{t('knowledge.searchEmpty')}</Paragraph> : <GroupsOf groups={groups} base={context.base} open={context.open} testId="search-page-results" />}
    </Stack>
  );
}

/** The search section of a template: its own field and answers, for a page that holds one. */
export function SearchSection({ context }: { readonly context: SectionContext }): ReactElement {
  const { t } = useTranslation();
  if ((context.section.query ?? '').trim() !== '') return <SearchPageSection context={context} />;
  const [text, setText] = useState('');
  const [groups, setGroups] = useState<readonly SearchGroup[] | undefined>(undefined);
  const [failed, setFailed] = useState<string | undefined>(undefined);
  const kinds = Array.isArray(context.section.params['kinds']) ? (context.section.params['kinds'] as string[]).filter((one) => typeof one === 'string') : undefined;
  const ask = async (): Promise<void> => {
    const result = await askSearch(context.base, text, kinds, 10, context.language);
    if (result.failure !== undefined) { setFailed(result.failure); return; }
    setFailed(undefined);
    setGroups(result.groups);
  };
  return (
    <Stack>
      <FilterBar>
        <FilterField>
          {t('knowledge.searchLabel')}
          <Input value={text} aria-label={t('knowledge.searchLabel')} data-testid="page-search" placeholder={t('knowledge.searchPlaceholder')} onChange={(event) => { setText(event.target.value); }} onKeyDown={(event) => { if (event.key === 'Enter') void ask(); }} />
        </FilterField>
        <Button variant="default" size="sm" onClick={() => { void ask(); }}>{t('knowledge.searchButton')}</Button>
      </FilterBar>
      {failed === undefined ? null : <Paragraph>{failed}</Paragraph>}
      {groups === undefined ? null : (groups.length === 0 ? <Paragraph>{t('knowledge.searchEmpty')}</Paragraph> : <GroupsOf groups={groups} base={context.base} open={context.open} />)}
    </Stack>
  );
}
