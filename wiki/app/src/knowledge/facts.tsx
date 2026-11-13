/** The home assembles only the graph facts returned for the reader's role. */
import type { ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, AlertDescription } from '@/components/ui/alert.js';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card.js';
import { Disclosure, DisclosureSummary } from '@/components/ui/disclosure.js';
import { FactChart } from '@/components/ui/fact-chart.js';
import { PageSection, PageHeader, PageTitle, SectionTitle, Paragraph, TextLink, DefinitionList, DefinitionTerm, DefinitionValue, BulletList, ListItem } from '@/components/ui/typography.js';
import { appPath } from '../app-base.js';
import { getFacts } from './api.js';
import { useRead } from './live.js';
import { useRole } from './roles.js';
import { addressOfEntity, addressOfStatement } from './routes.js';
import { linkHandlers, useTabTitle } from './tabs.js';
import type { FactsView } from './types.js';

export function FactsHome({ title, version }: { title: string; version: number }): ReactElement {
  const { t, i18n } = useTranslation();
  const { role } = useRole();
  const language = (i18n.resolvedLanguage ?? 'en').startsWith('ru') ? 'ru' : 'en';
  const read = useRead<FactsView>(`facts\0${role}\0${language}`, version, (signal) => getFacts(language, signal));
  useTabTitle(title);
  return <PageSection data-testid="facts-home">
    <PageHeader><PageTitle>{title}</PageTitle></PageHeader>
    {read.error !== null && <Alert variant="problem" data-testid="facts-error"><AlertDescription>{read.error}</AlertDescription></Alert>}
    {read.data === null && read.error === null && <Paragraph role="status" data-testid="facts-loading">{t('facts.loading')}</Paragraph>}
    {read.data !== null && read.data.kinds.length === 0 && <Paragraph data-testid="facts-empty">{t('facts.empty')}</Paragraph>}
    {read.data?.kinds.map((kind) => <PageSection key={kind.kind} data-kind={kind.kind}>
      <SectionTitle>{kind.label}</SectionTitle>
      {kind.statements.map((fact) => <Card key={fact.id} data-testid="home-fact" data-fact={fact.id}>
        <CardHeader><CardTitle><TextLink href={appPath(addressOfStatement(fact.statement.page.id, fact.label))} {...linkHandlers(addressOfStatement(fact.statement.page.id, fact.label))}>{fact.label}</TextLink></CardTitle></CardHeader>
        <CardContent>
          {fact.display === 'number' ? <Paragraph data-testid="fact-number">{fact.value === null ? t('facts.unavailable') : fact.value.toLocaleString(language)}</Paragraph> : <FactChart display={fact.display} rows={fact.rows.map((row) => ({ ...row, ...(row.entity === undefined ? {} : { href: appPath(addressOfEntity(row.entity)) }) }))} labelTitle={t('facts.label')} valueTitle={t('facts.value')} />}
          {fact.display !== 'number' && fact.rows.length === 0 && <Paragraph>{t('facts.noValues')}</Paragraph>}
          <Disclosure data-testid="fact-ground"><DisclosureSummary>{t('facts.ground')}</DisclosureSummary>
            <DefinitionList columns>
              <DefinitionTerm>{t('facts.kind')}</DefinitionTerm><DefinitionValue>{fact.ground.kind}</DefinitionValue>
              <DefinitionTerm>{t('facts.measure')}</DefinitionTerm><DefinitionValue>{fact.ground.measure}</DefinitionValue>
              {fact.ground.field !== undefined && <><DefinitionTerm>{t('facts.field')}</DefinitionTerm><DefinitionValue>{fact.ground.field}</DefinitionValue></>}
              {fact.ground.buckets !== undefined && <><DefinitionTerm>{t('facts.buckets')}</DefinitionTerm><DefinitionValue>{JSON.stringify(fact.ground.buckets)}</DefinitionValue></>}
              {fact.ground.limit !== undefined && <><DefinitionTerm>{t('facts.limit')}</DefinitionTerm><DefinitionValue>{fact.ground.limit}</DefinitionValue></>}
              <DefinitionTerm>{t('facts.total')}</DefinitionTerm><DefinitionValue>{fact.ground.total}</DefinitionValue>
              <DefinitionTerm>{t('facts.missing')}</DefinitionTerm><DefinitionValue>{fact.ground.missing}</DefinitionValue>
              <DefinitionTerm>{t('facts.computedAt')}</DefinitionTerm><DefinitionValue>{fact.ground.computedAt}</DefinitionValue>
            </DefinitionList>
            <BulletList>{fact.ground.entities.map((entity) => <ListItem key={entity}><TextLink href={appPath(addressOfEntity(entity))} {...linkHandlers(addressOfEntity(entity))}>{entity}</TextLink></ListItem>)}</BulletList>
          </Disclosure>
        </CardContent>
      </Card>)}
    </PageSection>)}
  </PageSection>;
}
