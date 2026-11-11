import { useState, type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button.js';
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
  return <form className="my-4 space-y-4 max-w-2xl" data-testid="authored-form" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
    <h2>{t(entity === undefined ? 'authored.new' : 'authored.edit')}</h2>
    {schema.error !== null && <p role="alert">{schema.error}</p>}
    {schema.data === null && schema.error === null && <p>{t('authored.loading')}</p>}
    {schema.data?.fields.map((field) => {
      const id = `authored-field-${field.name}`;
      const invalid = error?.field === field.name || error?.field === `values.${field.name}`;
      const props = { id, value: valueOf(field), disabled: busy, required: !field.nullable, 'aria-invalid': invalid, 'aria-describedby': invalid ? `${id}-error` : undefined, onChange: (event: { target: { value: string } }) => setDraft({ ...draft, [field.name]: event.target.value }) };
      return <div key={field.name}><label htmlFor={id} className="block mb-1">{field.name}{!field.nullable && <span aria-hidden="true"> *</span>} <span className="text-small text-muted">{field.type}</span></label>
        {field.type === 'boolean' ? <select {...props} className="rounded border border-line bg-transparent p-2"><option value="">—</option><option value="true">{t('authored.true')}</option><option value="false">{t('authored.false')}</option></select> : field.type === 'json' || field.type === 'text' || field.reference !== undefined ? <Textarea {...props} rows={field.type === 'json' || field.reference !== undefined ? 6 : 3} /> : <Input {...props} type="text" inputMode={field.type === 'integer' || field.type === 'bigint' ? 'numeric' : undefined} />}
        {invalid && <p id={`${id}-error`} role="alert" className="text-small">{error.message}{error.conflict !== undefined && <> {t('authored.conflict', { field: error.conflict.field, current: JSON.stringify(error.conflict.current), author: error.conflict.author })}</>}</p>}</div>;
    })}
    {error !== null && <p role="alert">{error.message}</p>}
    {error?.conflict !== undefined && <Button type="button" size="default" disabled={busy} onClick={() => void reload()}>{t('authored.reload')}</Button>}
    <div className="flex gap-2"><Button type="submit" size="default" variant="default" disabled={busy || schema.data === null}>{t(busy ? 'authored.saving' : 'authored.save')}</Button><Button type="button" size="default" disabled={busy} onClick={cancel}>{t('authored.cancel')}</Button></div>
  </form>;
}

export function AuthoredKindPage({ kind, version }: { kind: string; version: number }): ReactElement {
  const { t } = useTranslation();
  const kindName = useKindName();
  const [creating, setCreating] = useState(false);
  const [revision, setRevision] = useState(0);
  const [query, setQuery] = useState('');
  const read = useRead<AuthoredView>(kind, version + revision, (signal) => readAuthored(kind, undefined, signal));
  useTabTitle(kindName(kind, 'many'));
  return <section data-testid="authored-kind-page"><header className="mb-6"><h1>{kindName(kind, 'many')}</h1><Button size="default" variant="default" onClick={() => setCreating(true)}>{t('authored.new')}</Button></header>
    {creating && <AuthoredForm key={kind} kind={kind} cancel={() => setCreating(false)} saved={() => { setCreating(false); setRevision(revision + 1); }} />}
    <Input type="search" aria-label={t('knowledge.filter')} placeholder={t('knowledge.filter')} value={query} onChange={(event) => setQuery(event.target.value)} className="max-w-sm mb-4" />
    {read.error !== null && <p role="alert">{read.error}</p>}
    {read.data === null && read.error === null && <p>{t('authored.loading')}</p>}
    {read.data !== null && (read.data.entities ?? []).length === 0 && <p>{t('knowledge.nothingOfKind')}</p>}
    <ul>{read.data?.entities?.filter((entity) => titleOf(entity).toLowerCase().includes(query.toLowerCase())).map((entity) => <li key={entity.uid} className="border-b border-line py-3"><KLink href={addressOfAuthored(kind, entity.uid)}>{titleOf(entity)}</KLink></li>)}</ul>
  </section>;
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
  const remove = async (): Promise<void> => { setBusy(true); setError(null); try { await writeAuthored(kind, 'DELETE', uid); setDeleted(true); } catch (failure) { setError(words(failure)); } finally { setBusy(false); } };
  if (deleted) return <section><h1>{t('authored.deleted')}</h1><KLink href={addressOfKind(kind)}>{t('authored.back')}</KLink></section>;
  return <article data-testid="authored-page"><KLink href={addressOfKind(kind)}>{t('authored.back')}</KLink>
    {(error ?? read.error) !== null && <p role="alert">{error ?? read.error}</p>}
    {entity === undefined && read.error === null && <p>{t('authored.loading')}</p>}
    {entity !== undefined && <><h1>{titleOf(entity)}</h1>
      {!editing && <div className="flex gap-2 my-4"><Button size="default" variant="default" onClick={() => setEditing(true)}>{t('authored.edit')}</Button><Button size="default" onClick={() => setConfirming(true)}>{t('authored.delete')}</Button></div>}
      {confirming && <div role="alertdialog" aria-label={t('authored.delete')} className="border border-line rounded p-4 my-4"><p>{t('authored.confirmDelete', { title: titleOf(entity) })}</p><Button size="default" variant="default" disabled={busy} onClick={() => void remove()}>{t('authored.confirm')}</Button><Button size="default" disabled={busy} onClick={() => setConfirming(false)}>{t('authored.cancel')}</Button></div>}
      {editing ? <AuthoredForm key={uid} kind={kind} entity={entity} cancel={() => setEditing(false)} saved={() => { setEditing(false); setRevision(revision + 1); }} /> : <dl className="space-y-4">{read.data?.fields.map((field) => <div key={field.name}><dt className="text-small text-muted">{field.name}</dt><dd className="whitespace-pre-wrap break-words">{entity.values[field.name] == null ? '—' : field.type === 'json' || field.reference !== undefined ? JSON.stringify(entity.values[field.name], null, 2) : String(entity.values[field.name])}</dd></div>)}</dl>}
    </>}
  </article>;
}
