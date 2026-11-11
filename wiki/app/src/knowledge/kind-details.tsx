import type { ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/badge.js';
import { getCatalog } from './api.js';
import { KLink } from './blocks.js';
import { KindGraph, relatedKinds, graphStateOf } from './kind-graph.js';
import { KindSources } from './kind-sources.js';
import { useRead } from './live.js';
import { fillWithOf } from './producers.js';
import { addressOfKind } from './routes.js';
import type { CatalogView } from './types.js';

/** The kind's declaration stays separate from the records that happen to exist today. */
export function KindDetails({ kind, version }: { kind: string; version: number }): ReactElement | null {
  const { t, i18n } = useTranslation();
  const language = (i18n.resolvedLanguage ?? 'en').startsWith('ru') ? 'ru' : 'en';
  const read = useRead<CatalogView>(`kind-details\0${kind}\0${language}`, version, (signal) => getCatalog(signal));
  const catalog = read.data;
  const chosen = catalog?.kinds.find((entry) => entry.kind === kind);
  if (catalog === null || chosen === undefined) return read.error === null ? null : <p className="mb-6 text-small text-muted" role="status" data-testid="kind-details-unavailable">{t('knowledge.kindDetails.unavailable')}</p>;
  const related = relatedKinds(catalog.kinds, kind);
  const description = chosen.descriptions?.[language] ?? chosen.descriptions?.['en'];
  const producer = (chosen.pluginFolders ?? []).length > 0 ? chosen.pluginFolders!.join(', ')
    : (chosen.plugins ?? []).length > 0 ? t('knowledge.catalogueByPlugin', { plugins: chosen.plugins!.join(', ') })
    : fillWithOf(chosen) === 'person' ? t('knowledge.catalogueByPerson')
    : fillWithOf(chosen) === 'agent' ? t('knowledge.catalogueByAgent')
    : t(`knowledge.catalogueStage.${chosen.producer}`);
  const name = (id: string): string => {
    const entry = catalog.kinds.find((item) => item.kind === id);
    return entry?.labels?.[language]?.many ?? entry?.labels?.['en']?.many ?? id;
  };
  return <div className="mb-8 space-y-6" data-testid="kind-details">
    <section>
      {description !== undefined && <p data-testid="kind-meaning">{description}</p>}
      <KindSources kind={chosen} />
      <dl className="mt-4 grid gap-2 text-small sm:grid-cols-[auto_1fr]">
        <dt className="text-muted">{t('knowledge.kindSources.producer')}</dt>
        <dd className="m-0" data-testid="kind-producer">{producer}</dd>
        <dt className="text-muted">{t('knowledge.catalogueColState')}</dt>
        <dd className="m-0"><Badge data-testid="kind-state" data-state={graphStateOf(chosen, false)}>{t(`knowledge.catalogueState.${graphStateOf(chosen, false)}`)}</Badge></dd>
      </dl>
    </section>
    <section data-testid="kind-fields">
      <h2>{t('knowledge.kindDetails.fields')}</h2>
      {(chosen.fields ?? []).length === 0 ? <p className="text-muted">{t('knowledge.kindDetails.noFields')}</p> : <dl className="space-y-2">
        {chosen.fields!.map((field) => <div key={field.name} className="flex flex-wrap gap-x-3">
          <dt className="font-mono">{field.name}</dt>
          <dd className="m-0 text-muted">{field.type}{field.nullable === true && ' | null'}{field.reference !== undefined && <> → <KLink href={addressOfKind(field.reference)}>{name(field.reference)}</KLink></>}</dd>
        </div>)}
      </dl>}
    </section>
    <section data-testid="kind-relations">
      <h2>{t('knowledge.kindDetails.relations')}</h2>
      {(chosen.relations ?? []).length === 0 ? <p className="text-muted">{t('knowledge.kindDetails.noRelations')}</p> : <ul className="space-y-1">
        {chosen.relations!.map((relation, index) => <li key={`${relation.direction}:${relation.name}:${relation.kind ?? ''}:${index}`} data-direction={relation.direction}>
          <span>{t(relation.direction === 'in' ? 'knowledge.relationIn' : 'knowledge.relationOut', { relation: relation.name })}</span>{' '}
          {relation.kind !== undefined && (relation.kind === '*' ? <span>{relation.kind}</span> : <KLink href={addressOfKind(relation.kind)}>{name(relation.kind)}</KLink>)}
        </li>)}
      </ul>}
    </section>
    <section>
      <h2>{t('knowledge.catalogueViews.relations')}</h2>
      <KindGraph catalog={{ ...catalog, kinds: catalog.kinds.filter((entry) => related.has(entry.kind)) }} chosen={kind} highlighted={new Set([kind])} />
    </section>
  </div>;
}
