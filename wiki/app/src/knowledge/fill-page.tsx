import type { ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { PageSection, PageHeader, PageTitle } from '@/components/ui/typography.js';
import { FillSetup } from './fill-setup.js';
import { FillHistory } from './fill-runs.js';
import { useTabTitle } from './tabs.js';
import type { WikiStatus } from './types.js';

export function FillPage({ status, refresh, version }: { status: WikiStatus; refresh: () => void; version: number }): ReactElement {
  const { t } = useTranslation();
  useTabTitle(t('knowledge.fillPage.title'));
  return <PageSection data-testid="fill-page">
    <PageHeader><PageTitle>{t('knowledge.fillPage.title')}</PageTitle></PageHeader>
    <FillSetup refresh={refresh} disabled={status.fill.state === 'running' || status.fill.state === 'paused'} />
    <FillHistory version={version} />
  </PageSection>;
}
