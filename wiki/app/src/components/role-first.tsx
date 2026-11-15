
/**
 * The role choice on the first visit (decision 0031): the wiki reads one page for everyone, and the reader says once, on
 * this machine, which role they read as. Skipping means «everything». The choice is kept through the retained
 * `/api/settings` route, not in the product.
 */
import { useEffect, useState, type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, AlertDescription } from './ui/alert.js';
import { Button } from './ui/button.js';
import { ChoiceCard, ChoiceDescription } from './ui/choice-card.js';
import { Dialog, DialogBody, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './ui/dialog.js';
import { RadioGroup, RadioGroupItem } from './ui/radio-group.js';
import { Paragraph } from './ui/typography.js';
import { isOffline, readReaderSettings, saveReaderRole, useCommandRead, type ReaderSettingsAnswer } from './command.js';

const message = (failure: unknown): string | null => isOffline(failure) ? null : failure instanceof Error ? failure.message : String(failure);

export function RoleFirstVisit({ base, onChosen }: { readonly base: string; readonly onChosen: (role: string) => void }): ReactElement | null {
  const { t } = useTranslation();
  const read = useCommandRead<ReaderSettingsAnswer>('reader-settings', (signal) => readReaderSettings(base, signal));
  const [selected, setSelected] = useState('everything');
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (read.data === null) return;
    setSelected(read.data.role);
  }, [read.data]);
  if (read.data === null || read.data.asked !== false || done) return null;
  const save = (role: string): void => {
    setBusy(true);
    setError(null);
    saveReaderRole(base, role).then(
      () => { setBusy(false); setDone(true); onChosen(role); read.reload(); },
      (failure: unknown) => { setBusy(false); setError(message(failure)); },
    );
  };
  const name = (role: string): string => role === 'everything' ? t('knowledge.roles.names.everything') : t(`knowledge.roles.names.${role}`, { defaultValue: role });
  return (
    <Dialog open>
      <DialogContent closeLabel={t('knowledge.roles.skip')} showCloseButton={false} data-testid="role-first">
        <DialogHeader>
          <DialogTitle>{t('knowledge.roles.cardTitle')}</DialogTitle>
          <DialogDescription>{t('knowledge.roles.cardLead')}</DialogDescription>
        </DialogHeader>
        <DialogBody>
          <RadioGroup value={selected} onValueChange={setSelected} aria-label={t('knowledge.roles.cardTitle')}>
            {read.data.roles.map((role) => (
              <ChoiceCard key={role} data-testid={`role-first-${role}`}>
                <RadioGroupItem value={role} aria-label={name(role)} />
                <ChoiceDescription>{name(role)}</ChoiceDescription>
              </ChoiceCard>
            ))}
          </RadioGroup>
          <Paragraph className="m-0 mt-2 text-small text-muted">{t('knowledge.roles.cardNote')}</Paragraph>
          {error === null ? null : <Alert variant="problem"><AlertDescription>{error}</AlertDescription></Alert>}
        </DialogBody>
        <DialogFooter>
          <Button disabled={busy} disabledReason={t('knowledge.roles.saving')} onClick={() => save('everything')} data-testid="role-first-skip">{t('knowledge.roles.skip')}</Button>
          <Button disabled={busy} disabledReason={t('knowledge.roles.saving')} onClick={() => save(selected)} data-testid="role-first-continue">{t('knowledge.roles.continue')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
