import { Stack, PlainList, ListItem, TextLink } from '@/components/ui/typography.js';
import type { ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { sourceName } from './source-name.js';
import type { CatalogKindView } from './types.js';

/** Standards belong to the kind declaration, not to each catalogue row. */
export function KindSources({ kind }: { kind: CatalogKindView }): ReactElement | null {
  const { t } = useTranslation();
  if ((kind.sources ?? []).length === 0) return null;
  return <Stack className="mt-1 space-y-1 text-small text-muted" data-testid="kind-sources">
    <Stack>{t('knowledge.kindSources.standards')}</Stack>
    <PlainList className="m-0 list-none space-y-1 p-0">{kind.sources!.map((source) => <ListItem key={source}>
      <TextLink href={source} target="_blank" rel="noreferrer" className="break-words hover:text-ink hover:underline">{sourceName(source)}</TextLink>
    </ListItem>)}</PlainList>
  </Stack>;
}
