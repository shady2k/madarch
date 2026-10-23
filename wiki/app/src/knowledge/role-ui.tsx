/**
 * The role in the wiki's chrome (decision 0031): the card that asks once on the
 * first open (skippable, "everything" by default), the switch in the top bar,
 * and the «?» that opens madarch's own documentation from any product.
 */
import { useState, type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import * as DropdownMenuPrimitive from '@radix-ui/react-dropdown-menu';
import { CheckIcon, CircleHelpIcon, UserRoundIcon } from 'lucide-react';
import { Button } from '@/components/ui/button.js';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog.js';
import { K_HOME } from './routes.js';
import { ROLES, chooseRole, useSettings } from './roles.js';
import type { ProductChoice } from './types.js';

/** The first open asks which role the reader reads as; closing the card or skipping it means everything. */
export function RoleCard(): ReactElement | null {
  const { t } = useTranslation();
  const settings = useSettings();
  const [picked, setPicked] = useState<string>('everything');
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  if (!settings.loaded || settings.asked) return null;
  const keep = (role: string): void => {
    setWorking(true);
    setError(null);
    chooseRole(role).then(() => setWorking(false), (failure: unknown) => { setWorking(false); setError(failure instanceof Error ? failure.message : String(failure)); });
  };
  return (
    <Dialog open onOpenChange={(open) => { if (!open && !working) keep('everything'); }}>
      <DialogContent data-testid="role-card">
        <DialogTitle>{t('knowledge.roles.cardTitle')}</DialogTitle>
        <DialogDescription asChild>
          <div className="grid gap-3 text-small text-secondary">
            <p className="m-0">{t('knowledge.roles.cardLead')}</p>
            <div role="radiogroup" aria-label={t('knowledge.roles.cardTitle')} className="grid gap-1.5">
              {ROLES.map((role) => (
                <label key={role} className="flex cursor-pointer items-start gap-2.5 rounded-[var(--radius-card)] border border-line px-3 py-2 has-[:checked]:border-ink" data-testid="role-option" data-role={role}>
                  <input type="radio" name="role" className="mt-1" checked={picked === role} onChange={() => setPicked(role)} />
                  <span><b className="text-ink">{t(`knowledge.roles.names.${role}`)}</b><br />{t(`knowledge.roles.about.${role}`)}</span>
                </label>
              ))}
            </div>
            <p className="m-0 text-muted">{t('knowledge.roles.cardNote')}</p>
          </div>
        </DialogDescription>
        {error !== null && <p className="m-0 text-small" role="alert" data-testid="role-error">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="default" size="default" disabled={working} onClick={() => keep('everything')} data-testid="role-skip">{t('knowledge.roles.skip')}</Button>
          <Button variant="default" size="default" className="!border-ink !bg-ink !text-page" disabled={working} onClick={() => keep(picked)} data-testid="role-continue">{t('knowledge.roles.continue')}</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** The role in the top bar: the reader's role, and a menu to read as another. */
export function RoleMenu(): ReactElement {
  const { t } = useTranslation();
  const settings = useSettings();
  return (
    <DropdownMenuPrimitive.Root>
      <DropdownMenuPrimitive.Trigger asChild>
        <Button variant="ghost" size="icon" className="size-auto gap-1.5 px-2" aria-label={t('knowledge.roles.menu')} title={t('knowledge.roles.menuTitle')} data-testid="role-menu">
          <UserRoundIcon aria-hidden="true" className="size-[19px]" />
          <span className="hidden text-small sm:inline" data-testid="role-current">{t(`knowledge.roles.names.${settings.role}`)}</span>
        </Button>
      </DropdownMenuPrimitive.Trigger>
      <DropdownMenuPrimitive.Portal>
        <DropdownMenuPrimitive.Content align="end" sideOffset={7} className="language-menu">
          <DropdownMenuPrimitive.Label className="language-menu-label">{t('knowledge.roles.menu')}</DropdownMenuPrimitive.Label>
          <DropdownMenuPrimitive.Separator className="language-menu-separator" />
          <DropdownMenuPrimitive.RadioGroup value={settings.role} onValueChange={(role: string) => { chooseRole(role).catch(() => undefined); }}>
            {ROLES.map((role) => (
              <DropdownMenuPrimitive.RadioItem key={role} className="language-menu-item" value={role} data-testid="role-choice">
                <span className="language-menu-check"><DropdownMenuPrimitive.ItemIndicator><CheckIcon aria-hidden="true" className="size-4" /></DropdownMenuPrimitive.ItemIndicator></span>
                {t(`knowledge.roles.names.${role}`)}
              </DropdownMenuPrimitive.RadioItem>
            ))}
          </DropdownMenuPrimitive.RadioGroup>
        </DropdownMenuPrimitive.Content>
      </DropdownMenuPrimitive.Portal>
    </DropdownMenuPrimitive.Root>
  );
}

/** The «?» beside the language globe: madarch's own documentation, from any product. Not shown inside that documentation, nor where the server serves one product only. */
export function HelpLink({ products, current }: { products: readonly ProductChoice[]; current: string | null }): ReactElement | null {
  const { t } = useTranslation();
  const own = products.find((product) => product.own === true);
  if (own === undefined || own.folder === current) return null;
  const href = `/products/${encodeURIComponent(own.folder)}${K_HOME}`;
  return (
    <a href={href} aria-label={t('knowledge.help.label')} title={t('knowledge.help.title')} data-testid="help-link" className="inline-flex size-9 items-center justify-center rounded-[var(--radius-control)] text-secondary no-underline hover:bg-[var(--surface-hover)] hover:text-ink focus-visible:ring-2 focus-visible:ring-ink">
      <CircleHelpIcon aria-hidden="true" className="size-[21px]" />
    </a>
  );
}
