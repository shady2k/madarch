import { Stack, Text, PlainList, ListItem, TextLink } from '@/components/ui/typography.js';
import { useState, type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { CircleHelpIcon } from 'lucide-react';
import { Button } from '@/components/ui/button.js';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover.js';
import { getCatalogKind } from './api.js';
import { useRead } from './live.js';
import { sourceName } from './source-name.js';
import type { CatalogKindView } from './types.js';

/** The standards and practices behind a kind, not its implementation files. */
export function KindSources({ kind, compact = false }: { kind: CatalogKindView; compact?: boolean }): ReactElement | null {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const detail = useRead<CatalogKindView | null>(`kind-sources\0${kind.kind}\0${open}`, 0,
    (signal) => open && kind.sources === undefined ? getCatalogKind(kind.kind, signal) : Promise.resolve(null));
  const sources = kind.sources ?? detail.data?.sources ?? [];
  if (sources.length === 0 && kind.sourcesAvailable !== true) return null;
  const label = t('knowledge.kindSources.standards');
  const link = (source: string): ReactElement => <TextLink href={source} target="_blank" rel="noreferrer" title={source} className="break-words hover:text-ink hover:underline">{sourceName(source)}</TextLink>;
  const list = <PlainList className="m-0 list-none space-y-1 p-0">{sources.map((source) => <ListItem key={source}>{link(source)}</ListItem>)}</PlainList>;
  if (kind.sources === undefined) return <Text className="text-small text-muted" data-testid="kind-sources">
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild><Button type="button" variant="ghost" size="icon-sm" aria-label={label}><CircleHelpIcon className="size-4" aria-hidden="true" /></Button></PopoverTrigger>
      <PopoverContent aria-label={label}>{detail.error !== null ? <Text role="status">{t('knowledge.kindDetails.unavailable')}</Text> : detail.data === null ? <Text role="status">{t('knowledge.loading')}</Text> : list}</PopoverContent>
    </Popover>
  </Text>;
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
