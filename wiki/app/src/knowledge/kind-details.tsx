import { Stack, Text, PageSection, SectionTitle, Paragraph, PlainList, ListItem, DefinitionList, DefinitionTerm, DefinitionValue } from '@/components/ui/typography.js';
import type { ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/badge.js';
import { getCatalog, getCatalogKind } from './api.js';
import { relationLabel } from './relation-labels.js';
import { KLink } from './blocks.js';
import { KindGraph, relatedKinds, graphStateOf } from './kind-graph.js';
import { KindSources } from './kind-sources.js';
import { useRead } from './live.js';
import { fillWithOf } from './producers.js';
import { addressOfKind } from './routes.js';
import type { CatalogKindView, CatalogView } from './types.js';

/** The kind's declaration stays separate from the records that happen to exist today. */
export function KindDetails({ kind, version }: { kind: string; version: number }): ReactElement | null {
  const { t, i18n } = useTranslation();
  const language = (i18n.resolvedLanguage ?? 'en').startsWith('ru') ? 'ru' : 'en';
  const read = useRead<CatalogView>(`kind-details\0${kind}\0${language}`, version, (signal) => getCatalog(signal));
  const catalog = read.data;
  const detail = useRead<CatalogKindView>(`kind-declaration\0${kind}\0${language}`, version, (signal) => getCatalogKind(kind, signal));
  const chosen = detail.data;
  if (catalog === null || chosen === null) return read.error === null && detail.error === null ? <Paragraph role="status">{t('knowledge.loading')}</Paragraph> : <Paragraph className="mb-6 text-small text-muted" role="status" data-testid="kind-details-unavailable">{t('knowledge.kindDetails.unavailable')}</Paragraph>;
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
  return <Stack className="mb-8 space-y-6" data-testid="kind-details">
    <PageSection>
      {description !== undefined && <Paragraph data-testid="kind-meaning">{description}</Paragraph>}
      <KindSources kind={chosen} />
      <DefinitionList className="mt-4 grid gap-2 text-small sm:grid-cols-2">
        <DefinitionTerm className="text-muted">{t('knowledge.kindSources.producer')}</DefinitionTerm>
        <DefinitionValue className="m-0" data-testid="kind-producer">{producer}</DefinitionValue>
        <DefinitionTerm className="text-muted">{t('knowledge.catalogueColState')}</DefinitionTerm>
        <DefinitionValue className="m-0"><Badge data-testid="kind-state" data-state={graphStateOf(chosen, false)}>{t(`knowledge.catalogueState.${graphStateOf(chosen, false)}`)}</Badge></DefinitionValue>
      </DefinitionList>
    </PageSection>
    <PageSection data-testid="kind-fields">
      <SectionTitle>{t('knowledge.kindDetails.fields')}</SectionTitle>
      {(chosen.fields ?? []).length === 0 ? <Paragraph className="text-muted">{t('knowledge.kindDetails.noFields')}</Paragraph> : <DefinitionList className="space-y-2">
        {chosen.fields!.map((field) => <Stack key={field.name} className="flex flex-wrap gap-x-3">
          <DefinitionTerm className="font-mono">{field.name}</DefinitionTerm>
          <DefinitionValue className="m-0 text-muted">{field.type}{field.nullable === true && ' | null'}{field.reference !== undefined && <> → <KLink href={addressOfKind(field.reference)}>{name(field.reference)}</KLink></>}</DefinitionValue>
        </Stack>)}
      </DefinitionList>}
    </PageSection>
    <PageSection data-testid="kind-relations">
      <SectionTitle>{t('knowledge.kindDetails.relations')}</SectionTitle>
      {(chosen.relations ?? []).length === 0 ? <Paragraph className="text-muted">{t('knowledge.kindDetails.noRelations')}</Paragraph> : <PlainList className="space-y-1">
        {chosen.relations!.map((relation, index) => <ListItem key={`${relation.direction}:${relation.name}:${relation.kind ?? ''}:${index}`} data-direction={relation.direction}>
          <Text>{t(relation.direction === 'in' ? 'knowledge.relationIn' : 'knowledge.relationOut', { relation: relationLabel(relation.name, t) })}</Text>{' '}
          {relation.kind !== undefined && (relation.kind === '*' ? <Text>{relation.kind}</Text> : <KLink href={addressOfKind(relation.kind)}>{name(relation.kind)}</KLink>)}
        </ListItem>)}
      </PlainList>}
    </PageSection>
    <PageSection>
      <SectionTitle>{t('knowledge.catalogueViews.relations')}</SectionTitle>
      <KindGraph catalog={{ ...catalog, kinds: catalog.kinds.filter((entry) => related.has(entry.kind)) }} chosen={kind} highlighted={new Set([kind])} />
    </PageSection>
  </Stack>;
}
