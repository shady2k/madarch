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
  const link = (source: string): ReactElement => <a href={source} target="_blank" rel="noreferrer" title={source} className="break-words hover:text-ink hover:underline">{sourceName(source)}</a>;
  const list = <ul className="m-0 list-none space-y-1 p-0">{sources.map((source) => <li key={source}>{link(source)}</li>)}</ul>;
  if (!compact) return <div className="mt-1 space-y-1 text-small text-muted" data-testid="kind-sources"><div>{label}</div>{list}</div>;
  return <span className="text-small text-muted" data-testid="kind-sources">
    <span className="ml-1 hidden md:inline" data-testid="kind-sources-inline">({sources.map((source, index) => <span key={source}>{index > 0 && ', '}{link(source)}</span>)})</span>
    <span className="ml-1 inline-flex md:hidden" data-testid="kind-sources-compact">
      <Popover>
        <PopoverTrigger asChild><Button type="button" variant="ghost" size="icon-sm" aria-label={label}><CircleHelpIcon className="size-4" aria-hidden="true" /></Button></PopoverTrigger>
        <PopoverContent aria-label={label} className="md:hidden">{list}</PopoverContent>
      </Popover>
    </span>
  </span>;
}
