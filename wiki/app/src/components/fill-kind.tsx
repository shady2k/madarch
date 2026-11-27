
/**
 * The kind page's way into the fill (the design change of madarch-64o5.71): one press opens the preparation panel with
 * this kind and its prerequisites preselected. It never starts an agent by itself.
 */
import type { ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from './ui/button.js';
import { valueAt } from '../../../../src/page-contract/index.js';
import { prepareAddress } from '../address.js';
import type { SectionContext } from './types.js';

export function FillKindSection({ context }: { readonly context: SectionContext }): ReactElement {
  const { t } = useTranslation();
  const path = typeof context.section.params['kindPath'] === 'string' ? context.section.params['kindPath'] : 'name';
  const kind = valueAt(context.data, path);
  const name = typeof kind === 'string' && kind !== '' ? kind : null;
  return (
    <Button variant="default" size="default" disabled={name === null} disabledReason={t('prepare.noKinds')} onClick={() => { if (name !== null) context.open(prepareAddress([name])); }} data-testid="fill-kind">
      {t('fillKind.button')}
    </Button>
  );
}
