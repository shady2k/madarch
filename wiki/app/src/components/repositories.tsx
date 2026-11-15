/**
 * The home's repositories (madarch-64o5.85, the owner's walk): the repositories the product connects, from its
 * workspace and manifest, before any fill has put a repository in the graph. The Sources page reads the same answer;
 * a repository is named as that page names it, and its two states are the same two badges.
 */
import type { ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, AlertDescription } from './ui/alert.js';
import { Badge } from './ui/badge.js';
import { Skeleton } from './ui/skeleton.js';
import { ListItem, PlainList, Stack, Text } from './ui/typography.js';
import { readSources, useChangeStream, useCommandRead, type SourcesAnswer } from './command.js';
import type { SectionContext } from './types.js';

export function RepositoriesSection({ context }: { readonly context: SectionContext }): ReactElement {
  const { t } = useTranslation();
  const read = useCommandRead<SourcesAnswer>('sources', (signal) => readSources(context.base, signal));
  useChangeStream(context.base, read.reload);
  const listing = read.data;
  const repoName = (name: string | null): string => name === null ? t('knowledge.productRepository') : name;
  if (read.error !== null) return <Alert variant="problem" data-testid="home-repositories-error"><AlertDescription>{read.error}</AlertDescription></Alert>;
  if (listing === null) return <Skeleton className="h-9 w-72" data-testid="home-repositories-loading" />;
  return (
    <Stack data-testid="home-repositories">
      <PlainList className="m-0 list-none p-0">
        {listing.repositories.map((repository) => (
          <ListItem key={repository.name ?? '\u0000product'} className="flex flex-wrap items-center gap-2 border-b border-line py-2 last:border-b-0" data-testid="home-repository">
            <Text className="font-medium">{repoName(repository.name)}</Text>
            <Badge variant={repository.present ? 'outline' : 'solid'}>{t(repository.present ? 'knowledge.sourcesPage.present' : 'knowledge.sourcesPage.absent')}</Badge>
            <Badge variant={repository.filled ? 'solid' : 'outline'}>{t(repository.filled ? 'knowledge.sourcesPage.filled' : 'knowledge.sourcesPage.notFilled')}</Badge>
          </ListItem>
        ))}
      </PlainList>
    </Stack>
  );
}
