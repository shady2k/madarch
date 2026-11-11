import type { ReactElement } from 'react';
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
