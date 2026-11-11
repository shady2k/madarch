import { useId, type ReactElement } from 'react';
import { CircleHelpIcon } from 'lucide-react';
import { Button } from '@/components/ui/button.js';
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover.js';
import { fillWithOf } from './producers.js';
import { useTranslation } from 'react-i18next';
import { KLink } from './blocks.js';
import type { CatalogKindView } from './types.js';

/** Both the standards behind a kind and the product file that declares it. */
export function KindSources({ kind }: { kind: CatalogKindView }): ReactElement | null {
  const { t } = useTranslation();
  const declaration = kind.declaration;
  if ((kind.sources?.length ?? 0) === 0 && declaration === undefined) return null;
  const query = declaration === undefined ? null : new URLSearchParams({
    ...(declaration.repo === null ? {} : { repo: declaration.repo }),
    path: declaration.path, line: String(declaration.line),
  });
  return <div className="mt-1 space-y-1 text-small text-muted" data-testid="kind-sources">
    {(kind.sources?.length ?? 0) > 0 && <div>{t('knowledge.kindSources.standards')}<ul className="m-0 list-none p-0">{kind.sources!.map((source) => <li key={source}><a href={source} target="_blank" rel="noreferrer" className="break-all hover:text-ink hover:underline">{source}</a></li>)}</ul></div>}
    {declaration !== undefined && <div>{t('knowledge.kindSources.declaration')}{' '}<KLink href={`/src?${query}`} testId="kind-declaration" className="break-all hover:text-ink hover:underline">{declaration.path}:{declaration.line}</KLink></div>}
  </div>;
}

/** Compact row affordance for the declaration, template, and fill producer. */
export function KindSourcePopover({ kind }: { kind: CatalogKindView }): ReactElement {
  const { t } = useTranslation();
  const title = useId();
  const template = kind.template;
  const query = template === undefined ? null : new URLSearchParams({
    ...(template.repo === null ? {} : { repo: template.repo }), path: template.path,
  });
  const plugins = kind.pluginFolders?.length ? kind.pluginFolders : kind.plugins;
  const producer = plugins?.length ? plugins.join(', ') : t(fillWithOf(kind) === 'person'
    ? 'knowledge.catalogueByPerson' : fillWithOf(kind) === 'agent'
      ? 'knowledge.catalogueByAgent' : `knowledge.catalogueStage.${kind.producer ?? 'extract'}`);
  return <Popover>
    <PopoverTrigger asChild><Button variant="ghost" size="icon-sm" className="ml-2" aria-label={t('knowledge.kindSources.show', { kind: kind.kind })} data-testid="kind-source-trigger"><CircleHelpIcon aria-hidden="true" className="size-4" /></Button></PopoverTrigger>
    <PopoverContent aria-labelledby={title} data-testid="kind-source-popover">
      <p id={title} className="m-0 font-medium">{kind.kind}</p>
      <KindSources kind={kind} />
      {template !== undefined && <p className="mb-0 mt-2 text-small">{t('knowledge.kindSources.template')}{' '}<KLink href={`/src?${query}`}>{template.path}</KLink></p>}
      <p className="mb-0 mt-2 text-small">{t('knowledge.kindSources.producer')}{' '}<span data-testid="kind-source-producer">{producer}</span></p>
    </PopoverContent>
  </Popover>;
}
