/**
 * The first-run guide on a product that has never been filled (the owner's walk, madarch-64o5.85): what madarch is,
 * the three steps of a first fill, and the preparation wizard itself, inline on the home page. The reader changes the
 * set, chooses who fills, and presses once without leaving the home. The guide disappears as soon as a fill has
 * succeeded or one is running; the top bar's «Заполнить…» stays the manual way into the catalogue's selection mode.
 */
import type { ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from './ui/button.js';
import { InlineGroup, ListItem, OrderedList, Paragraph, SectionTitle, Stack } from './ui/typography.js';
import { readFillStatus, useCommandRead, type FillStatusAnswer } from './command.js';
import { PrepareSection } from './prepare.js';
import { catalogueSelectionAddress } from '../address.js';
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
  // The preparation panel reads its set and its wizard flag from section variables; the home gives it the same shape the
  // preparation address does, and tells it not to rewrite the address it stands on.
  const wizard: SectionContext = { ...context, variables: { ...context.variables, kinds: chosen.join(','), wizard: '1' } };
  return (
    <Stack className="grid gap-5" data-testid="first-run">
      <Stack className="grid gap-2">
        {context.section.title === undefined ? <SectionTitle>{t('firstRun.title')}</SectionTitle> : null}
        <Paragraph className="m-0 text-secondary" data-testid="first-run-what">{t('firstRun.what')}</Paragraph>
        <OrderedList className="m-0 grid gap-1" data-testid="first-run-steps">
          <ListItem>{t('firstRun.stepOne')}</ListItem>
          <ListItem>{t('firstRun.stepTwo')}</ListItem>
          <ListItem>{t('firstRun.stepThree')}</ListItem>
        </OrderedList>
        <InlineGroup className="mb-0">
          <Button onClick={() => context.open(catalogueSelectionAddress(chosen))} data-testid="first-run-manual">
            {t('firstRun.manual')}
          </Button>
        </InlineGroup>
      </Stack>
      <PrepareSection context={wizard} inline />
    </Stack>
  );
}
