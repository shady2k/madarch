import { Dialog, DialogContent, DialogTitle, DialogDescription, DialogHeader, DialogFooter, DialogBody } from '@/components/ui/dialog.js';
import { ChoiceCard, ChoiceDescription } from '@/components/ui/choice-card.js';
import { RadioGroup } from '@/components/ui/radio-group.js';
import { RadioInput } from '@/components/ui/radio-input.js';
import { Paragraph, Text } from '@/components/ui/typography.js';
import { ShellIconLink, ShellRoleButton, ShellRoleLabel } from '@/components/ui/shell.js';
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator } from '@/components/ui/dropdown-menu.js';
/**
 * The role in the wiki's chrome (decision 0031): the card that asks once on the
 * first open (skippable, "everything" by default), the switch in the top bar,
 * and the «?» that opens madarch's own documentation from any product.
 */
import { useState, type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { CircleHelpIcon, UserRoundIcon } from 'lucide-react';
import { Button } from '@/components/ui/button.js';
import { WIKI_HOME } from './routes.js';
import { chooseRole, rolesOf, useSettings } from './roles.js';
import type { ProductChoice } from './types.js';

/** The first open asks which role the reader reads as; closing the card or skipping it means everything. */
export function RoleCard(): ReactElement | null {
  const { t } = useTranslation();
  const settings = useSettings();
  const roles = rolesOf(settings.roles);
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
      <DialogContent aria-labelledby="role-card-title" aria-describedby="role-card-lead" data-testid="role-card" closeLabel={t('knowledge.roles.skip')} closeDisabled={working} onEscapeKeyDown={(event) => { if (working) event.preventDefault(); }}>
        <DialogHeader><DialogTitle id="role-card-title">{t('knowledge.roles.cardTitle')}</DialogTitle></DialogHeader>
        <DialogBody data-testid="role-card-body">
          <DialogDescription id="role-card-lead">{t('knowledge.roles.cardLead')}</DialogDescription>
          <RadioGroup aria-labelledby="role-card-title">
            {roles.map((role) => (
              <ChoiceCard key={role} data-testid="role-option" data-role={role}>
                <RadioInput name="role" value={role} checked={picked === role} onChange={() => setPicked(role)} autoFocus={role === 'everything'} />
                <ChoiceDescription><Text>{t(`knowledge.roles.names.${role}`)}</Text><br />{t(`knowledge.roles.about.${role}`)}</ChoiceDescription>
              </ChoiceCard>
            ))}
          </RadioGroup>
          {error !== null && <Paragraph role="alert" data-testid="role-error">{error}</Paragraph>}
        </DialogBody>
        <DialogFooter data-testid="role-card-footer">
          <Paragraph>{t('knowledge.roles.cardNote')}</Paragraph>
          <Button variant="default" size="default" disabled={working} onClick={() => keep('everything')} data-testid="role-skip">{t('knowledge.roles.skip')}</Button>
          <Button variant="default" size="default" disabled={working} onClick={() => keep(picked)} data-testid="role-continue">{t('knowledge.roles.continue')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** The role in the top bar: the reader's role, and a menu to read as another. */
export function RoleMenu(): ReactElement {
  const { t } = useTranslation();
  const settings = useSettings();
  const roles = rolesOf(settings.roles);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <ShellRoleButton aria-label={t('knowledge.roles.menu')} title={t('knowledge.roles.menuTitle')} data-testid="role-menu">
          <UserRoundIcon aria-hidden="true" size={19} />
          <ShellRoleLabel data-testid="role-current">{t(`knowledge.roles.names.${settings.role}`)}</ShellRoleLabel>
        </ShellRoleButton>
      </DropdownMenuTrigger>
        <DropdownMenuContent align="end" sideOffset={7}>
          <DropdownMenuLabel>{t('knowledge.roles.menu')}</DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuRadioGroup value={settings.role} onValueChange={(role: string) => { chooseRole(role).catch(() => undefined); }}>
            {roles.map((role) => (
              <DropdownMenuRadioItem key={role} value={role} data-testid="role-choice">
                {t(`knowledge.roles.names.${role}`)}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The «?» beside the language globe: madarch's own documentation, from any product. Not shown inside that documentation, nor where the server serves one product only. */
export function HelpLink({ products, current }: { products: readonly ProductChoice[]; current: string | null }): ReactElement | null {
  const { t } = useTranslation();
  const own = products.find((product) => product.own === true);
  if (own === undefined || own.folder === current) return null;
  const href = `/products/${encodeURIComponent(own.folder)}${WIKI_HOME}`;
  return (
    <ShellIconLink href={href} aria-label={t('knowledge.help.label')} title={t('knowledge.help.title')} data-testid="help-link">
      <CircleHelpIcon aria-hidden="true" size={21} />
    </ShellIconLink>
  );
}
