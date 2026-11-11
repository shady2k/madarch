import { Stack, Text, PlainList, ListItem, TextLink } from '@/components/ui/typography.js';
import type { ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { CircleHelpIcon } from 'lucide-react';
import { Button } from '@/components/ui/button.js';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover.js';
import { sourceName } from './source-name.js';
import type { CatalogKindView } from './types.js';

/** The standards and practices behind a kind, not its implementation files. */
export function KindSources({ kind, compact = false }: { kind: CatalogKindView; compact?: boolean }): ReactElement | null {
  const { t } = useTranslation();
  const sources = kind.sources ?? [];
  if (sources.length === 0) return null;
  const label = t('knowledge.kindSources.standards');
  const link = (source: string): ReactElement => <TextLink href={source} target="_blank" rel="noreferrer" title={source} className="break-words hover:text-ink hover:underline">{sourceName(source)}</TextLink>;
  const list = <PlainList className="m-0 list-none space-y-1 p-0">{sources.map((source) => <ListItem key={source}>{link(source)}</ListItem>)}</PlainList>;
  if (!compact) return <Stack className="mt-1 space-y-1 text-small text-muted" data-testid="kind-sources"><Stack>{label}</Stack>{list}</Stack>;
  return <Text className="text-small text-muted" data-testid="kind-sources">
    <Text className="ml-1 hidden md:inline" data-testid="kind-sources-inline">({sources.map((source, index) => <Text key={source}>{index > 0 && ', '}{link(source)}</Text>)})</Text>
    <Text className="ml-1 inline-flex md:hidden" data-testid="kind-sources-compact">
      <Popover>
        <PopoverTrigger asChild><Button type="button" variant="ghost" size="icon-sm" aria-label={label}><CircleHelpIcon className="size-4" aria-hidden="true" /></Button></PopoverTrigger>
        <PopoverContent aria-label={label} className="md:hidden">{list}</PopoverContent>
      </Popover>
    </Text>
  </Text>;
}
