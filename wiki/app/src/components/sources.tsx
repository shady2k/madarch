
/**
 * The Sources page (the old portal's «Источники»): the product's Markdown documents, grouped by the repository they were
 * read from, and the repositories themselves. A document is an entity of a kind the graph filled with a `markdown` field;
 * its title links to the entity's page, and the page names no kind of its own.
 */
import { useState, type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, AlertDescription } from './ui/alert.js';
import { Badge } from './ui/badge.js';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card.js';
import { Input } from './ui/input.js';
import { FieldLabel, ListItem, Paragraph, PlainList, SectionTitle, Stack, Text, TextLink } from './ui/typography.js';
import { readSources, useChangeStream, useCommandRead, type SourcesAnswer } from './command.js';
import { entityAddress } from '../address.js';
import type { SectionContext } from './types.js';

const lower = (text: string, language: string): string => text.toLocaleLowerCase(language);

/** The Sources page. */
export function SourcesSection({ context }: { readonly context: SectionContext }): ReactElement {
  const { t, i18n } = useTranslation();
  const language = context.language !== undefined && context.language !== '' ? context.language : (i18n.resolvedLanguage ?? 'en').startsWith('ru') ? 'ru' : 'en';
  const read = useCommandRead<SourcesAnswer>('sources', (signal) => readSources(context.base, signal));
  useChangeStream(context.base, read.reload);
  const [query, setQuery] = useState('');
  const listing = read.data;
  const needle = lower(query.trim(), language);
  const matches = (title: string, path: string): boolean => needle === '' || lower(`${title} ${path}`, language).includes(needle);
  const documents = (listing?.documents ?? []).filter((document) => matches(document.title, document.path));
  const groups = new Map<string | null, typeof documents>();
  for (const document of documents) groups.set(document.repo, [...(groups.get(document.repo) ?? []), document]);
  const repoName = (name: string | null): string => name === null ? t('knowledge.productRepository') : name;
  return (
    <Stack className="grid gap-6" data-testid="sources-page">
      <Paragraph className="m-0 text-secondary" data-testid="sources-intro">{t('knowledge.documentsIntro')}</Paragraph>
      {read.error === null ? null : <Alert variant="problem" data-testid="sources-error"><AlertDescription>{read.error}</AlertDescription></Alert>}
      {listing?.note === undefined ? null : <Alert data-testid="sources-note"><AlertDescription>{listing.note}</AlertDescription></Alert>}
      {listing === null ? null : (
        <Card data-testid="sources-repositories">
          <CardHeader><CardTitle>{t('knowledge.sourcesPage.repositories')}</CardTitle></CardHeader>
          <CardContent>
            <PlainList className="m-0 list-none p-0">
              {listing.repositories.map((repository) => (
                <ListItem key={repository.name ?? '\u0000product'} className="flex flex-wrap items-center gap-2 border-b border-line py-2 last:border-b-0" data-testid="sources-repository">
                  <Text className="font-medium">{repoName(repository.name)}</Text>
                  <Badge variant={repository.present ? 'outline' : 'solid'}>{t(repository.present ? 'knowledge.sourcesPage.present' : 'knowledge.sourcesPage.absent')}</Badge>
                  <Badge variant={repository.filled ? 'solid' : 'outline'}>{t(repository.filled ? 'knowledge.sourcesPage.filled' : 'knowledge.sourcesPage.notFilled')}</Badge>
                </ListItem>
              ))}
            </PlainList>
          </CardContent>
        </Card>
      )}
      <FieldLabel className="grid gap-1 text-small">
        {t('knowledge.filterSources')}
        <Input type="search" value={query} onInput={(event) => setQuery(event.currentTarget.value)} placeholder={t('knowledge.filterSources')} aria-label={t('knowledge.filterSources')} data-testid="sources-filter" />
      </FieldLabel>
      {/* No premature "no documents": the sentence is for a filter that matched nothing, and a product with no documents
          is told what will bring them (madarch-64o5.83). */}
      {listing !== null && documents.length === 0
        ? <Paragraph className="text-muted" data-testid="sources-empty">{needle === '' ? t('knowledge.sourcesPage.empty') : t('knowledge.sourcesPage.noMatch', { text: query.trim() })}</Paragraph>
        : null}
      {[...groups.entries()].map(([repo, rows]) => (
        <Stack key={repo ?? '\u0000product'} className="grid gap-2" data-testid="sources-group">
          <SectionTitle className="first-letter:uppercase">{repoName(repo)}</SectionTitle>
          <PlainList className="m-0 list-none p-0">
            {rows.map((document) => {
              const address = document.id === null ? null : entityAddress(document.kind, document.id);
              return (
                <ListItem key={`${document.kind}:${document.path}`} className="border-b border-line py-1.5 last:border-b-0" data-testid="sources-row">
                  {address === null ? <Text>{document.title}</Text> : (
                    <TextLink href={context.base + address} onClick={(event) => { event.preventDefault(); context.open(address); }}>{document.title}</TextLink>
                  )}
                  <Text className="block break-all text-small text-muted" data-testid="sources-path">{document.path}</Text>
                </ListItem>
              );
            })}
          </PlainList>
          {(listing?.truncated ?? []).filter((cut) => cut.repo === repo).map((cut) => (
            <Paragraph key={`${repo ?? ''}:cut`} className="text-small text-muted" data-testid="sources-cut">{t('knowledge.sourcesPage.truncated', { shown: cut.shown, total: cut.total })}</Paragraph>
          ))}
        </Stack>
      ))}
    </Stack>
  );
}
