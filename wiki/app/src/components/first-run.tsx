
/**
 * The first-run card on an empty product (the design change of madarch-64o5.71): the recommended editable set is opened in
 * the same preparation panel, not a second flow. The card disappears as soon as the graph holds a kind or a run is not
 * idle; the top bar's «Заполнить…» stays the manual way into the catalogue's selection mode.
 */
import type { ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from './ui/button.js';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card.js';
import { Paragraph, Stack } from './ui/typography.js';
import { readFillStatus, useCommandRead, type FillStatusAnswer } from './command.js';
import { catalogueSelectionAddress, prepareAddress } from '../address.js';
import type { SectionContext } from './types.js';

export function FirstRunSection({ context }: { readonly context: SectionContext }): ReactElement | null {
  const { t } = useTranslation();
  const status = useCommandRead<FillStatusAnswer>('fill-status', (signal) => readFillStatus(context.base, signal));
  const kinds = context.navigation?.kinds ?? [];
  // A fresh product has had no successful fill. Its starter catalogue and value sets already hold entities, so a kind's
  // count is not what says it is fresh; the fill status does.
  const empty = status.data?.filled === false;
  const idle = status.data !== undefined && status.data !== null && status.data.fill.state === 'idle';
  if (!empty || !idle || status.data?.own === true) return null;
  const recommended = kinds.filter((kind) => kind.taken).map((kind) => kind.kind);
  const chosen = recommended.length > 0 ? recommended : kinds.map((kind) => kind.kind);
  return (
    <Card data-testid="first-run">
      <CardHeader><CardTitle>{t('firstRun.title')}</CardTitle></CardHeader>
      <CardContent>
        <Paragraph className="mt-0 text-secondary">{t('firstRun.intro', { count: chosen.length })}</Paragraph>
        <Stack className="flex flex-wrap items-center gap-3">
          <Button variant="default" size="default" onClick={() => context.open(prepareAddress(chosen, false, true))} data-testid="first-run-start">
            {t('firstRun.start')}
          </Button>
          <Button variant="ghost" size="default" onClick={() => context.open(catalogueSelectionAddress(chosen))} data-testid="first-run-manual">
            {t('firstRun.manual')}
          </Button>
        </Stack>
      </CardContent>
    </Card>
  );
}
