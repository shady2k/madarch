/**
 * A server action while the server cannot answer: the control stays visible but disabled, and a tooltip says why. The
 * span carries the hover because a disabled button receives no pointer events of its own.
 */
import type { ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { Tooltip, TooltipContent, TooltipTrigger } from './tooltip.js';

export function OfflineAction({ offline, children }: { readonly offline: boolean; readonly children: ReactElement }): ReactElement {
  const { t } = useTranslation();
  if (!offline) return children;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span tabIndex={0} className="inline-flex">{children}</span>
      </TooltipTrigger>
      <TooltipContent>{t('connection.actionsDisabled')}</TooltipContent>
    </Tooltip>
  );
}
