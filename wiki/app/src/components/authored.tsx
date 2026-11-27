import { useId, useState, type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { CATALOGUE_KIND } from '../../../../src/page-contract/index.js';
import { entityAddress } from '../address.js';
import { postQuery } from '../client.js';
import { CommandError, offlineWords, writeAuthored } from './command.js';
import type { SectionContext } from './types.js';
import { Button } from './ui/button.js';
import { ConfirmationPanel } from './ui/confirmation-panel.js';
import { Input } from './ui/input.js';
import { RadioGroup, RadioGroupItem } from './ui/radio-group.js';
import { Textarea } from './ui/textarea.js';
import { FieldLabel, Form, InlineGroup, Paragraph, Stack, Text } from './ui/typography.js';

interface Field {
  readonly name: string;
  readonly type: string;
  readonly nullable?: boolean;
  readonly key?: boolean;
  readonly value?: unknown;
}

interface Snapshot {
  readonly revision: string;
  readonly details: readonly Field[];
}

interface EditData extends Snapshot {
  readonly id: string;
  readonly kind: string;
  readonly label: string;
}

interface CreateData {
  readonly name: string;
  readonly fields: readonly Field[];
}

function fieldText(field: Field): string {
  if (field.value == null) return '';
  return field.type === 'json' ? JSON.stringify(field.value, null, 2) : String(field.value);
}

function AuthoredForm({ context, kind, fields, entity, close }: {
  readonly context: SectionContext;
  readonly kind: string;
  readonly fields: readonly Field[];
  readonly entity?: EditData;
  readonly close: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const id = useId();
  // Keep the revision and values observed at opening even while the page refreshes in the background.
  const [snapshot, setSnapshot] = useState<Snapshot | undefined>(entity);
  const [draft, setDraft] = useState(new Map<string, string>());
  const [error, setError] = useState<{ message: string; field?: string } | null>(null);
  const [conflicts, setConflicts] = useState(new Map<string, unknown>());
  const [busy, setBusy] = useState(false);
  const shown = snapshot?.details ?? fields;

  async function reload(field: string): Promise<void> {
    if (entity === undefined || snapshot === undefined) return;
    setBusy(true);
    setError(null);
    try {
      const answer = await postQuery<{ entity: Snapshot | null }>(context.base, `query ReloadAuthored($id: ID!, $lang: String) {
        entity(id: $id, lang: $lang) { revision details { name type key value } }
      }`, { id: entity.id, lang: context.language });
      if (answer.offline === true) throw new Error(offlineWords());
      const fresh = answer.data?.entity;
      if (fresh?.revision == null || answer.errors.length > 0) throw new Error(answer.errors[0]?.message ?? t('authored.missingEntity'));
      const remaining = new Map(draft);
      remaining.delete(field);
      const pending = new Map(conflicts);
      pending.delete(field);
      // Advancing the revision must not make a second, stale draft safe to submit.
      for (const current of fresh.details) {
        if (!remaining.has(current.name)) continue;
        const previous = snapshot.details.find((old) => old.name === current.name);
        if (pending.has(current.name) || (previous !== undefined && fieldText(previous) !== fieldText(current))) pending.set(current.name, current.value);
      }
      setSnapshot(fresh);
      setDraft(remaining);
      setConflicts(pending);
    } catch (failure) {
      setError({ message: failure instanceof Error ? failure.message : String(failure) });
    } finally {
      setBusy(false);
    }
  }

  async function submit(): Promise<void> {
    if (busy || conflicts.size > 0) return;
    setError(null);
    const entries: [string, unknown][] = [];
    for (const field of shown) {
      const raw = draft.get(field.name) ?? fieldText(field);
      if (snapshot !== undefined && (field.key === true || raw === fieldText(field))) continue;
      if (raw === '') {
        if (field.nullable === false) {
          setError({ field: field.name, message: t('authored.required') });
          return;
        }
        if (snapshot !== undefined) entries.push([field.name, null]);
        continue;
      }
      let value: unknown = raw;
      if (field.type === 'integer') {
        const number = Number(raw);
        if (raw.trim() === '' || !Number.isSafeInteger(number)) {
          setError({ field: field.name, message: t('authored.invalidInteger') });
          return;
        }
        value = number;
      } else if (field.type === 'json') {
        try { value = JSON.parse(raw) as unknown; }
        catch {
          setError({ field: field.name, message: t('authored.invalidJson') });
          return;
        }
      } else if (field.type === 'boolean') value = raw === 'true';
      entries.push([field.name, value]);
    }
    if (entity !== undefined && entries.length === 0) {
      close();
      return;
    }
    setBusy(true);
    const values = Object.fromEntries(entries);
    try {
      if (entity === undefined) {
        const answer = await writeAuthored(context.base, kind, { method: 'POST', values });
        context.open(entityAddress(kind, answer.entity.uid));
      } else if (snapshot !== undefined) {
        await writeAuthored(context.base, kind, { method: 'PATCH', uid: entity.id, revision: snapshot.revision, values });
        context.reload({});
      }
      close();
    } catch (failure) {
      if (failure instanceof CommandError && failure.conflict !== undefined) {
        setConflicts(new Map([[failure.conflict.field, failure.conflict.current]]));
      } else {
        const field = failure instanceof CommandError ? failure.field : undefined;
        setError({ message: failure instanceof Error ? failure.message : String(failure), ...(field === undefined ? {} : { field }) });
      }
    } finally {
      setBusy(false);
    }
  }

  return <Form aria-label={t(entity === undefined ? 'authored.new' : 'authored.edit')} onSubmit={(event) => { event.preventDefault(); void submit(); }}>
    {shown.map((field, index) => {
      const fieldId = `${id}-${index}`;
      const locked = snapshot !== undefined && field.key === true;
      const conflict = conflicts.has(field.name);
      const invalid = conflict || error?.field === field.name;
      const value = draft.get(field.name) ?? fieldText(field);
      const change = (next: string): void => {
        const updated = new Map(draft);
        if (next === fieldText(field)) updated.delete(field.name);
        else updated.set(field.name, next);
        setDraft(updated);
      };
      const validity = { 'aria-invalid': invalid, 'aria-describedby': invalid ? `${fieldId}-error` : undefined };
      const input = { ...validity, id: fieldId, value, disabled: busy, readOnly: locked, 'aria-required': field.nullable === false,
        onInput: (event: { currentTarget: { value: string } }) => change(event.currentTarget.value) };
      const boolean = field.type === 'boolean' && !locked;
      return <Stack layout="text" key={field.name}>
        <FieldLabel id={`${fieldId}-label`} htmlFor={boolean ? undefined : fieldId}>{field.name}{field.nullable === false && <Text aria-hidden="true"> *</Text>}</FieldLabel>
        {boolean ? <RadioGroup {...validity} aria-labelledby={`${fieldId}-label`} aria-required={field.nullable === false}
          disabled={busy} value={value || 'unset'} onValueChange={(next) => change(next === 'unset' ? '' : next)}>
          {(field.nullable === false ? ['true', 'false'] : ['unset', 'true', 'false']).map((option) => (
            <InlineGroup key={option}>
              <RadioGroupItem id={`${fieldId}-${option}`} value={option} />
              <FieldLabel htmlFor={`${fieldId}-${option}`}>{option === 'unset' ? t('authored.unset') : t(option === 'true' ? 'authored.true' : 'authored.false')}</FieldLabel>
            </InlineGroup>
          ))}
        </RadioGroup> : field.type === 'json' || (field.type === 'text' && !locked)
          ? <Textarea {...input} rows={field.type === 'json' ? 5 : 2} />
          : <Input {...input} inputMode={field.type === 'integer' || field.type === 'bigint' ? 'numeric' : undefined} />}
        {invalid && (
          <Stack>
            <Paragraph id={`${fieldId}-error`} role="alert">
              {conflict ? t('authored.conflict', { current: JSON.stringify(conflicts.get(field.name)) ?? t('authored.unset') }) : error?.message}
            </Paragraph>
            {conflict && <Button type="button" size="sm" disabled={busy} disabledReason={t('authored.actionInProgress')} onClick={() => void reload(field.name)}>{t('authored.reload')}</Button>}
          </Stack>
        )}
      </Stack>;
    })}
    {error !== null && !shown.some((field) => field.name === error.field) && <Paragraph role="alert">{error.message}</Paragraph>}
    <InlineGroup>
      <Button type="submit" variant="default" size="default" disabled={busy || conflicts.size > 0}
        disabledReason={t(busy ? 'authored.actionInProgress' : 'authored.reloadConflicts')}>{t(busy ? 'authored.saving' : 'authored.save')}</Button>
      <Button type="button" variant="ghost" size="default" disabled={busy} disabledReason={t('authored.actionInProgress')} onClick={close}>{t('authored.cancel')}</Button>
    </InlineGroup>
  </Form>;
}

export function AuthoredSection({ context }: { readonly context: SectionContext }): ReactElement | null {
  const { t } = useTranslation();
  const creating = context.section.params['mode'] === 'create';
  const catalogue = creating ? context.data as CreateData | undefined : undefined;
  const entity = creating ? undefined : context.data as EditData | undefined;
  const nav = context.navigation?.kinds.find(({ kind }) => kind === (catalogue?.name ?? entity?.kind));
  const [action, setAction] = useState<'form' | EditData | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [busy, setBusy] = useState(false);
  if (nav?.authored !== true || nav.entryId === null || (!creating && entity?.revision == null)) return null;
  const { kind, entryId } = nav;
  const close = (): void => { setAction(null); setError(null); };

  async function remove(record: EditData): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await writeAuthored(context.base, kind, { method: 'DELETE', uid: record.id, revision: record.revision });
      close();
      context.open(entityAddress(CATALOGUE_KIND, entryId));
    } catch (failure) {
      setError(failure instanceof Error ? failure : new Error(String(failure)));
    } finally {
      setBusy(false);
    }
  }

  if (action === 'form') return <AuthoredForm key={entity?.id ?? kind} context={context} kind={kind} fields={catalogue?.fields ?? []} {...(entity === undefined ? {} : { entity })} close={close} />;
  if (action !== null) {
    const stale = error instanceof CommandError && error.status === 412;
    return <ConfirmationPanel aria-label={t('authored.delete')}>
      <Paragraph>{t('authored.confirmDelete', { title: action.label })}</Paragraph>
      {error !== null && <Paragraph role="alert">{stale ? t('authored.staleDelete') : error.message}</Paragraph>}
      <InlineGroup>
        {stale
          ? <Button type="button" size="default" onClick={() => { context.reload({}); close(); }}>{t('authored.reload')}</Button>
          : <Button type="button" variant="default" size="default" disabled={busy} disabledReason={t('authored.actionInProgress')} onClick={() => void remove(action)}>{t('authored.confirm')}</Button>}
        <Button type="button" variant="ghost" size="default" disabled={busy} disabledReason={t('authored.actionInProgress')} onClick={close}>{t('authored.cancel')}</Button>
      </InlineGroup>
    </ConfirmationPanel>;
  }
  return <InlineGroup>
    <Button type="button" variant="default" size="default" disabled={context.busy} disabledReason={t('authored.loading')}
      onClick={() => setAction('form')}>{t(creating ? 'authored.new' : 'authored.edit')}</Button>
    {entity !== undefined && <Button type="button" variant="ghost" size="default" disabled={context.busy} disabledReason={t('authored.loading')}
      onClick={() => setAction(entity)}>{t('authored.delete')}</Button>}
  </InlineGroup>;
}
