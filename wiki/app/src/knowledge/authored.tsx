import { Stack, Text, PageSection, PageArticle, PageHeader, PageTitle, SectionTitle, Paragraph, PlainList, ListItem, DefinitionList, DefinitionTerm, DefinitionValue, FieldLabel, Form } from '@/components/ui/typography.js';
import { useState, type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button.js';
import { Select } from '@/components/ui/select.js';
import { Input } from '@/components/ui/input.js';
import { Textarea } from '@/components/ui/textarea.js';
import { KLink } from './blocks.js';
import { useRead } from './live.js';
import { useKindName } from './kind-names.js';
import { useTabTitle } from './tabs.js';
import { addressOfKind } from './routes.js';
import { AuthoredError, readAuthored, readAuthoredSchema, writeAuthored, type AuthoredConflict, type AuthoredEntity, type AuthoredField, type AuthoredView } from './authored-api.js';

export const addressOfAuthored = (kind: string, uid: string): string => `/authored?${new URLSearchParams({ kind, uid })}`;
const words = (failure: unknown): string => failure instanceof Error ? failure.message : String(failure);
const titleOf = (entity: AuthoredEntity): string => String(entity.values['title'] ?? entity.values['name'] ?? entity.uid);

export function AuthoredForm({ kind, entity, saved, cancel }: { kind: string; entity?: AuthoredEntity; saved: (entity?: AuthoredEntity) => void; cancel: () => void }): ReactElement {
  const { t } = useTranslation();
  const schema = useRead<AuthoredView>(kind, 0, (signal) => readAuthoredSchema(kind, signal));
  const [loaded, setLoaded] = useState(entity);
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [error, setError] = useState<{ message: string; field?: string; conflict?: AuthoredConflict } | null>(null);
  const [busy, setBusy] = useState(false);
  const initialValue = (field: AuthoredField): string => loaded?.values[field.name] == null ? '' : field.type === 'json' || field.reference !== undefined ? JSON.stringify(loaded.values[field.name], null, 2) : String(loaded.values[field.name]);
  const valueOf = (field: AuthoredField): string => draft[field.name] ?? initialValue(field);
  const reload = async (): Promise<void> => {
    if (loaded === undefined) return;
    setBusy(true);
    try {
      const answer = await readAuthored(kind, loaded.uid);
      if (answer.entity === undefined) throw new Error(t('authored.missingEntity'));
      setLoaded(answer.entity); setDraft({}); setError(null);
    } catch (failure) { setError({ message: words(failure) }); }
    finally { setBusy(false); }
  };
  const submit = async (): Promise<void> => {
    setError(null);
    const values: Record<string, unknown> = {};
    for (const field of schema.data?.fields ?? []) {
      const raw = valueOf(field);
      if (loaded !== undefined && raw === initialValue(field)) continue;
      if (raw === '') { values[field.name] = null; continue; }
      try {
        if (field.type === 'json' || field.reference !== undefined) values[field.name] = JSON.parse(raw);
        else if (field.type === 'integer') { const number = Number(raw); if (!Number.isSafeInteger(number)) throw new Error(); values[field.name] = number; }
        else if (field.type === 'boolean') values[field.name] = raw === 'true';
        else values[field.name] = raw;
      } catch { setError({ field: field.name, message: t(field.type === 'json' || field.reference !== undefined ? 'authored.invalidJson' : 'authored.invalidInteger') }); return; }
    }
    setBusy(true);
    try { const answer = await writeAuthored(kind, loaded === undefined ? 'POST' : 'PATCH', loaded?.uid, values, loaded?.revision); saved(answer.entity); }
    catch (failure) { setError({ message: words(failure), field: failure instanceof AuthoredError ? failure.field : undefined, conflict: failure instanceof AuthoredError ? failure.conflict : undefined }); }
    finally { setBusy(false); }
  };
  return <Form data-testid="authored-form" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
    <SectionTitle>{t(entity === undefined ? 'authored.new' : 'authored.edit')}</SectionTitle>
    {schema.error !== null && <Paragraph role="alert">{schema.error}</Paragraph>}
    {schema.data === null && schema.error === null && <Paragraph>{t('authored.loading')}</Paragraph>}
    {schema.data?.fields.map((field) => {
      const id = `authored-field-${field.name}`;
      const invalid = error?.field === field.name || error?.field === `values.${field.name}`;
      const props = { id, value: valueOf(field), disabled: busy, required: !field.nullable, 'aria-invalid': invalid, 'aria-describedby': invalid ? `${id}-error` : undefined, onChange: (event: { target: { value: string } }) => setDraft({ ...draft, [field.name]: event.target.value }) };
      return <Stack key={field.name}><FieldLabel htmlFor={id} className="block mb-1">{field.name}{!field.nullable && <Text aria-hidden="true"> *</Text>} <Text className="text-small text-muted">{field.type}</Text></FieldLabel>
        {field.type === 'boolean' ? <Select {...props} options={[{ value: '', label: '—' }, { value: 'true', label: t('authored.true') }, { value: 'false', label: t('authored.false') }]} /> : field.type === 'json' || field.type === 'text' || field.reference !== undefined ? <Textarea {...props} rows={field.type === 'json' || field.reference !== undefined ? 6 : 3} /> : <Input {...props} type="text" inputMode={field.type === 'integer' || field.type === 'bigint' ? 'numeric' : undefined} />}
        {invalid && <Paragraph id={`${id}-error`} role="alert" className="text-small">{error.message}{error.conflict !== undefined && <> {t('authored.conflict', { field: error.conflict.field, current: JSON.stringify(error.conflict.current), author: error.conflict.author })}</>}</Paragraph>}</Stack>;
    })}
    {error !== null && <Paragraph role="alert">{error.message}</Paragraph>}
    {error?.conflict !== undefined && <Button type="button" size="default" disabled={busy} onClick={() => void reload()}>{t('authored.reload')}</Button>}
    <Stack className="flex gap-2"><Button type="submit" size="default" variant="default" disabled={busy || schema.data === null}>{t(busy ? 'authored.saving' : 'authored.save')}</Button><Button type="button" size="default" disabled={busy} onClick={cancel}>{t('authored.cancel')}</Button></Stack>
  </Form>;
}

export function AuthoredKindPage({ kind, version }: { kind: string; version: number }): ReactElement {
  const { t } = useTranslation();
  const kindName = useKindName();
  const [creating, setCreating] = useState(false);
  const [revision, setRevision] = useState(0);
  const [query, setQuery] = useState('');
  const read = useRead<AuthoredView>(kind, version + revision, (signal) => readAuthored(kind, undefined, signal));
  useTabTitle(kindName(kind, 'many'));
  return <PageSection data-testid="authored-kind-page"><PageHeader className="mb-6"><PageTitle>{kindName(kind, 'many')}</PageTitle><Button size="default" variant="default" onClick={() => setCreating(true)}>{t('authored.new')}</Button></PageHeader>
    {creating && <AuthoredForm key={kind} kind={kind} cancel={() => setCreating(false)} saved={() => { setCreating(false); setRevision(revision + 1); }} />}
    <Input type="search" aria-label={t('knowledge.filter')} placeholder={t('knowledge.filter')} value={query} onChange={(event) => setQuery(event.target.value)} className="mb-4 w-96 max-w-full" />
    {read.error !== null && <Paragraph role="alert">{read.error}</Paragraph>}
    {read.data === null && read.error === null && <Paragraph>{t('authored.loading')}</Paragraph>}
    {read.data !== null && (read.data.entities ?? []).length === 0 && <Paragraph>{t('knowledge.nothingOfKind')}</Paragraph>}
    <PlainList>{read.data?.entities?.filter((entity) => titleOf(entity).toLowerCase().includes(query.toLowerCase())).map((entity) => <ListItem key={entity.uid} className="border-b border-line py-3"><KLink href={addressOfAuthored(kind, entity.uid)}>{titleOf(entity)}</KLink></ListItem>)}</PlainList>
  </PageSection>;
}

export function AuthoredPage({ kind, uid, version }: { kind: string; uid: string; version: number }): ReactElement {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [deleted, setDeleted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const read = useRead<AuthoredView>(`${kind}\0${uid}`, version + revision, (signal) => readAuthored(kind, uid, signal));
  const entity = read.data?.entity;
  useTabTitle(entity === undefined ? null : titleOf(entity));
  const remove = async (): Promise<void> => { setBusy(true); setError(null); try { await writeAuthored(kind, 'DELETE', uid, undefined, entity?.revision); setDeleted(true); } catch (failure) { setError(words(failure)); } finally { setBusy(false); } };
  if (deleted) return <PageSection><PageTitle>{t('authored.deleted')}</PageTitle><KLink href={addressOfKind(kind)}>{t('authored.back')}</KLink></PageSection>;
  return <PageArticle data-testid="authored-page"><KLink href={addressOfKind(kind)}>{t('authored.back')}</KLink>
    {(error ?? read.error) !== null && <Paragraph role="alert">{error ?? read.error}</Paragraph>}
    {entity === undefined && read.error === null && <Paragraph>{t('authored.loading')}</Paragraph>}
    {entity !== undefined && <><PageTitle>{titleOf(entity)}</PageTitle>
      {!editing && <Stack className="flex gap-2 my-4"><Button size="default" variant="default" onClick={() => setEditing(true)}>{t('authored.edit')}</Button><Button size="default" onClick={() => setConfirming(true)}>{t('authored.delete')}</Button></Stack>}
      {confirming && <Stack role="alertdialog" aria-label={t('authored.delete')} className="border border-line rounded p-4 my-4"><Paragraph>{t('authored.confirmDelete', { title: titleOf(entity) })}</Paragraph><Button size="default" variant="default" disabled={busy} onClick={() => void remove()}>{t('authored.confirm')}</Button><Button size="default" disabled={busy} onClick={() => setConfirming(false)}>{t('authored.cancel')}</Button></Stack>}
      {editing ? <AuthoredForm key={uid} kind={kind} entity={entity} cancel={() => setEditing(false)} saved={() => { setEditing(false); setRevision(revision + 1); }} /> : <DefinitionList className="space-y-4">{read.data?.fields.map((field) => <Stack key={field.name}><DefinitionTerm className="text-small text-muted">{field.name}</DefinitionTerm><DefinitionValue className="whitespace-pre-wrap break-words">{entity.values[field.name] == null ? '—' : field.type === 'json' || field.reference !== undefined ? JSON.stringify(entity.values[field.name], null, 2) : String(entity.values[field.name])}</DefinitionValue></Stack>)}</DefinitionList>}
    </>}
  </PageArticle>;
}
