
/** The top bar's «Заполнить…» press: it opens the catalogue's explicit selection mode. */
import type { ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from './ui/button.js';
import { catalogueSelectionAddress } from '../address.js';

export function FillEntry({ open }: { readonly open: (path: string) => void }): ReactElement {
  const { t } = useTranslation();
  return (
    <Button variant="default" size="default" data-testid="fill-entry" onClick={() => open(catalogueSelectionAddress())}>
      {t('knowledge.fillRun.open')}
    </Button>
  );
}
