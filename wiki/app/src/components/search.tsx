/**
 * The product's search (decision 0036, section 7): one question to the `search` root, its answers as links. A press is
 * the reader's own read, so it is a request of its own; a page view is still one request.
 */
import { useState, type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { postQuery } from '../client.js';
import { Button } from './ui/button.js';
import { FilterBar, FilterField } from './ui/filter-bar.js';
import { Input } from './ui/input.js';
import { Metadata, Paragraph, Stack, TextLink } from './ui/typography.js';
import { entityHref } from './connection.js';
import { follow } from './relations.js';
import type { SectionContext } from './types.js';

interface SearchAnswer {
  readonly search: { readonly edges: readonly { readonly node: Record<string, unknown> }[]; readonly totalCount: number };
}

export function SearchSection({ context }: { readonly context: SectionContext }): ReactElement {
  const { t } = useTranslation();
  const [text, setText] = useState('');
  const [answer, setAnswer] = useState<SearchAnswer['search'] | undefined>(undefined);
  const [failed, setFailed] = useState<string | undefined>(undefined);
  const kinds = Array.isArray(context.section.params['kinds']) ? (context.section.params['kinds'] as string[]) : undefined;
  const ask = async (): Promise<void> => {
    setFailed(undefined);
    const query = kinds === undefined
      ? 'query Search($text: String!) { search(text: $text, first: 20) { edges { node { id kind label template } } totalCount } }'
      : 'query Search($text: String!, $kinds: [String!]) { search(text: $text, kinds: $kinds, first: 20) { edges { node { id kind label template } } totalCount } }';
    const result = await postQuery<SearchAnswer>(context.base, query, { text, ...(kinds === undefined ? {} : { kinds }) });
    if (result.errors.length > 0) {
      setFailed(result.errors.map((error) => error.message).join('; '));
      return;
    }
    setAnswer(result.data?.search);
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
      {answer === undefined ? null : (
        <>
          <Metadata>{t('knowledge.found', { count: answer.totalCount })}</Metadata>
          {answer.edges.map((edge, at2) => {
            const href = entityHref(edge.node);
            return href === undefined ? null : (
              <TextLink key={String(at2)} href={context.base + href} onClick={follow(context.open, context.base + href)}>{String(edge.node['label'] ?? href)}</TextLink>
            );
          })}
        </>
      )}
    </Stack>
  );
}
