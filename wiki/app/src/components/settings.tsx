
/**
 * The product settings page (the old portal's «Настройки продукта»): the agent that writes the pages, the model and
 * reasoning level it reports, the model roles, the language of the pages, and the reader's own role on this machine.
 * Every read and write goes through the retained settings routes; the page names no kind and no model.
 */
import { useState, type ReactElement, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { useConnection } from '../connection.js';
import { Alert, AlertDescription } from './ui/alert.js';
import { Badge } from './ui/badge.js';
import { Button } from './ui/button.js';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card.js';
import { FieldLabel, ListItem, Paragraph, PlainList, Stack, Text } from './ui/typography.js';
import { Input } from './ui/input.js';
import { SegmentedChoice } from './ui/segmented-choice.js';
import { Select } from './ui/select.js';
import {
  chooseAgent, chooseModelRole, isOffline, readAgentChoices, readAgents, readProductSettings, readReaderSettings, saveProductSettings, saveReaderRole,
  useChangeStream, useCommandRead,
  type AgentChoice, type AgentChoicesAnswer, type AgentsAnswer, type ProductSettingsAnswer, type ReaderSettingsAnswer, type ResolvedModelRole,
} from './command.js';
import { agentNote } from './agent-words.js';
import type { SectionContext } from './types.js';

const SETTINGS_CONTROLS = {
  language: "settings-language",
  reader: "settings-reader",
} as const;

const message = (failure: unknown): string | null => isOffline(failure) ? null : failure instanceof Error ? failure.message : String(failure);

/** One card of the page. */
function Section({ id, title, intro, children }: { readonly id: string; readonly title: string; readonly intro?: string; readonly children: ReactNode }): ReactElement {
  return (
    <Card data-testid={`settings-${id}`}>
      <CardHeader><CardTitle>{title}</CardTitle></CardHeader>
      <CardContent>
        {intro === undefined ? null : <Paragraph className="mt-0 text-secondary">{intro}</Paragraph>}
        {children}
      </CardContent>
    </Card>
  );
}

/** One model or reasoning choice the agent reports. */
function ChoiceSelect({ id, label, choice, value, disabled, onChange }: {
  readonly id: string;
  readonly label: string;
  readonly choice: AgentChoice;
  readonly value: string | undefined;
  readonly disabled: boolean;
  readonly onChange: (value: string | null) => void;
}): ReactElement {
  const { t } = useTranslation();
  const picked = choice.values.find((entry) => entry.value === (value ?? choice.current));
  return (
    <Stack className="mb-3 last:mb-0">
      <FieldLabel className="mb-1 block text-small font-medium">{label}
        <Select
          data-testid={id}
          className="mt-1 w-full max-w-96"
          value={value ?? ''}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value === '' ? null : event.target.value)}
          options={[{ value: '', label: choice.current === null ? t('settings.model.agentsOwn') : t('settings.model.agentsOwnNamed', { name: choice.values.find((entry) => entry.value === choice.current)?.name ?? choice.current }) }, ...choice.values.map((entry) => ({ value: entry.value, label: entry.name }))]}
        />
      </FieldLabel>
      {picked?.description === undefined ? null : <Paragraph className="m-0 text-small text-muted">{picked.description}</Paragraph>}
    </Stack>
  );
}

/** One role's pair, and the agent's own model and reasoning for an assigned role. */
function RoleRow({ role, settings, base, names, options, disabled, assign, reload }: {
  readonly role: ResolvedModelRole;
  readonly settings: ProductSettingsAnswer;
  readonly base: string;
  readonly names: Readonly<Record<string, string>>;
  readonly options: readonly { readonly id: string; readonly name: string }[];
  readonly disabled: boolean;
  readonly assign: (role: string, agent: string | null) => void;
  readonly reload: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const connection = useConnection();
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const assigned = role.role !== 'writing' && role.source === 'assigned' && role.pair !== null;
  const agent = assigned ? role.pair!.agent : '';
  const choices = useCommandRead<AgentChoicesAnswer>(`settings-role-choices:${role.role}:${agent}`, (signal) => readAgentChoices(base, agent, signal), assigned && agent !== '');
  const pairLabel = role.pair === null ? t('settings.roles.unassigned') : `${names[role.pair.agent] ?? role.pair.agent} · ${role.pair.model ?? t('settings.roles.agentsOwn')}`;
  const save = (change: { model?: string | null; reasoning?: string | null }): void => {
    if (connection.offline) return;
    setWorking(true);
    setError(null);
    chooseModelRole(base, role.role, agent, change).then(() => { setWorking(false); reload(); }, (failure: unknown) => { setWorking(false); setError(message(failure)); });
  };
  return (
    <ListItem className="rounded-lg border border-line p-3" data-testid={`settings-role-${role.role}`} data-source={role.source}>
      <Stack className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <Text className="font-medium">{t(`settings.roles.${role.role}`, { defaultValue: role.role })}</Text>
        <Text className="text-small text-secondary" data-testid={`settings-role-pair-${role.role}`}>{pairLabel}</Text>
      </Stack>
      {role.source === 'fallback' && role.fallbackFrom !== undefined ? <Paragraph className="mb-0 mt-1 text-small text-muted" data-testid={`settings-role-fallback-${role.role}`}>{t('settings.roles.fallback', { role: t(`settings.roles.${role.fallbackFrom}`) })}</Paragraph> : null}
      {role.source === 'none' ? <Paragraph className="mb-0 mt-1 text-small text-muted" data-testid={`settings-role-none-${role.role}`}>{t('settings.roles.noDefault')}</Paragraph> : null}
      {assigned && choices.data !== null ? (
        <Stack className="mt-3" data-testid={`settings-role-choices-${role.role}`}>
          {choices.data.choices.model === null ? null : <ChoiceSelect id={`settings-role-model-${role.role}`} label={t('settings.model.model')} choice={choices.data.choices.model} value={role.pair?.model} disabled={connection.offline || working || disabled || settings.busy} onChange={(value) => save({ model: value })} />}
          {choices.data.choices.reasoning === null ? null : <ChoiceSelect id={`settings-role-reasoning-${role.role}`} label={t('settings.model.reasoning')} choice={choices.data.choices.reasoning} value={role.pair?.reasoning} disabled={connection.offline || working || disabled || settings.busy} onChange={(value) => save({ reasoning: value })} />}
        </Stack>
      ) : null}
      {role.role === 'writing' ? null : (
        <Stack className="mt-2">
          <FieldLabel className="mb-1 block text-small font-medium">{t('settings.roles.assign', { role: t(`settings.roles.${role.role}`) })}
            <Select
              data-testid={`settings-role-select-${role.role}`}
              className="mt-1 w-full max-w-96"
              value={assigned ? role.pair!.agent : ''}
              disabled={connection.offline || working || disabled || settings.busy}
              onChange={(event) => assign(role.role, event.target.value === '' ? null : event.target.value)}
              options={[{ value: '', label: settings.roles.defaultPair === null ? t('settings.roles.unassigned') : t('settings.roles.useDefault', { role: t('settings.roles.writing') }) }, ...options.map((option) => ({ value: option.id, label: option.name }))]}
            />
          </FieldLabel>
        </Stack>
      )}
      {error === null ? null : <Paragraph className="mb-0 mt-2 text-small" role="alert" data-testid={`settings-role-error-${role.role}`}>{error}</Paragraph>}
    </ListItem>
  );
}

/** The settings page. */
export function SettingsSection({ context }: { readonly context: SectionContext }): ReactElement {
  const { t } = useTranslation();
  const connection = useConnection();
  const base = context.base;
  const settings = useCommandRead<ProductSettingsAnswer>('product-settings', (signal) => readProductSettings(base, signal));
  const agents = useCommandRead<AgentsAnswer>('agents', (signal) => readAgents(base, signal));
  const reader = useCommandRead<ReaderSettingsAnswer>('reader-settings', (signal) => readReaderSettings(base, signal));
  useChangeStream(base, () => { settings.reload(); agents.reload(); reader.reload(); });
  const [round, setRound] = useState(0);
  const [working, setWorking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The default token cap, as typed: `null` until the person edits the number the product holds.
  const [cap, setCap] = useState<string | null>(null);
  const data = settings.data;
  const chosen = data?.chosenAgent ?? null;
  const choices = useCommandRead<AgentChoicesAnswer>(`settings-choices:${chosen?.id ?? ''}:${String(round)}`, (signal) => readAgentChoices(base, chosen!.id, signal, round > 0), chosen !== null);
  const saveSettings = (change: { language?: string; model?: string | null; reasoning?: string | null; tokenCap?: number }): void => {
    if (connection.offline) return;
    setWorking('settings');
    setError(null);
    saveProductSettings(base, change).then(() => { setWorking(null); settings.reload(); choices.reload(); }, (failure: unknown) => { setWorking(null); setError(message(failure)); });
  };
  const choose = (agent: string | null): void => {
    if (connection.offline) return;
    setWorking('agent');
    setError(null);
    chooseAgent(base, agent, true).then(() => { setWorking(null); settings.reload(); agents.reload(); choices.reload(); }, (failure: unknown) => { setWorking(null); setError(message(failure)); });
  };
  const assign = (role: string, agent: string | null): void => {
    if (connection.offline) return;
    setWorking(`role:${role}`);
    setError(null);
    chooseModelRole(base, role, agent, { install: true }).then(() => { setWorking(null); settings.reload(); }, (failure: unknown) => { setWorking(null); setError(message(failure)); });
  };
  const saveReader = (role: string): void => {
    if (connection.offline) return;
    setWorking('reader');
    setError(null);
    saveReaderRole(base, role).then(() => { setWorking(null); reader.reload(); context.onRole?.(role); }, (failure: unknown) => { setWorking(null); setError(message(failure)); });
  };
  const capValue = Number(cap ?? data?.tokenCap ?? 0);
  const capValid = Number.isSafeInteger(capValue) && capValue > 0;
  const namedAgents = Object.entries(data?.agentNames ?? {});
  const roleOptions = [
    ...namedAgents.map(([id, name]) => {
      const offered = agents.data?.agents.find((agent) => agent.id === id);
      return { id, name: offered === undefined || offered.installed ? name : t('settings.roles.installs', { agent: name }) };
    }),
    ...(agents.data?.agents ?? []).filter((agent) => !namedAgents.some(([id]) => id === agent.id)).map((agent) => ({
      id: agent.id,
      name: agent.installed ? agent.label : t('settings.roles.installs', { agent: agent.label }),
    })),
  ];
  const roles = data?.roles.roles ?? [];
  const allNames = Object.fromEntries([...namedAgents, ...(agents.data?.agents ?? []).map((agent) => [agent.id, agent.label] as const)]);

  if (settings.error !== null) return <Alert variant="problem" data-testid="settings-error"><AlertDescription>{settings.error}</AlertDescription></Alert>;
  if (data === null) return <Alert data-testid="settings-loading"><AlertDescription>{t('knowledge.loading')}</AlertDescription></Alert>;

  return (
    <Stack className="grid gap-5" data-testid="settings-page">
      <Paragraph className="m-0 text-secondary" data-testid="settings-intro">{t('settings.intro', { product: data.product.name })}</Paragraph>
      {data.own === true ? <Alert data-testid="settings-own"><AlertDescription>{t('settings.own')}</AlertDescription></Alert> : null}
      {error === null ? null : <Alert variant="problem" data-testid="settings-error-action"><AlertDescription>{error}</AlertDescription></Alert>}
      {data.busy ? <Paragraph className="m-0 text-small text-muted">{t('settings.busy')}</Paragraph> : null}

      <Section id="agent" title={t('settings.agent.title')} intro={t('settings.agent.intro')}>
        <PlainList className="m-0 grid list-none gap-2 p-0">
          {(agents.data?.agents ?? []).map((agent) => (
            <ListItem key={agent.id} className="flex flex-wrap items-center gap-3 rounded-lg border border-line p-3" data-testid={`settings-agent-${agent.id}`} data-chosen={chosen?.id === agent.id ? 'true' : 'false'}>
              <Text className="min-w-0 flex-1">
                <Text className="block font-medium">{agent.label}</Text>
                <Text className="block min-w-0 break-words text-small text-muted">
                  {agentNote(t, agent)}
                  {agent.login === 'signed-in' ? ` ${t('knowledge.writer.signedIn')}` : agent.login === 'not-signed-in' ? ` ${t('knowledge.writer.notSignedIn', { agent: agent.label })}` : ''}
                </Text>
              </Text>
              {chosen?.id === agent.id ? <Badge variant="solid" data-testid="settings-agent-chosen">{t('settings.agent.chosen')}</Badge> : (
                <Button variant="default" size="default" disabled={connection.offline || working !== null || data.busy} onClick={() => choose(agent.id)} data-testid={`settings-agent-choose-${agent.id}`}>{agent.installed ? t('settings.agent.choose') : t('settings.agent.installAndChoose')}</Button>
              )}
            </ListItem>
          ))}
          {agents.data === null && agents.error === null ? <ListItem className="text-muted">{t('knowledge.loading')}</ListItem> : null}
        </PlainList>
        {agents.error === null ? null : <Paragraph className="mb-0 mt-3 text-small" role="alert">{agents.error}</Paragraph>}
        {chosen === null ? null : <Paragraph className="mb-0 mt-3"><Button variant="default" size="default" disabled={connection.offline || working !== null || data.busy} onClick={() => choose(null)} data-testid="settings-agent-none">{t('settings.agent.none')}</Button></Paragraph>}
      </Section>

      <Section id="model" title={t('settings.model.title')} intro={t('settings.model.intro')}>
        {chosen === null ? <Paragraph className="m-0 text-muted" data-testid="settings-model-none">{t('settings.model.noAgent')}</Paragraph> : null}
        {chosen !== null && choices.data === null && choices.error === null ? <Paragraph className="m-0 text-muted" data-testid="settings-model-asking">{t('settings.model.asking', { agent: chosen.label })}</Paragraph> : null}
        {choices.data !== null && choices.data.choices.model === null && choices.data.choices.reasoning === null ? <Paragraph className="m-0 text-muted" data-testid="settings-model-reports-none">{t('settings.model.reportsNone', { agent: chosen?.label ?? '' })}</Paragraph> : null}
        {choices.data?.choices.model == null ? null : <ChoiceSelect id="settings-model-select" label={t('settings.model.model')} choice={choices.data.choices.model} value={chosen?.model} disabled={connection.offline || working !== null || data.busy} onChange={(value) => saveSettings({ model: value })} />}
        {choices.data?.choices.reasoning == null ? null : <ChoiceSelect id="settings-reasoning-select" label={t('settings.model.reasoning')} choice={choices.data.choices.reasoning} value={chosen?.reasoning} disabled={connection.offline || working !== null || data.busy} onChange={(value) => saveSettings({ reasoning: value })} />}
        {choices.error === null ? null : (
          <Alert variant="problem" data-testid="settings-model-error">
            <AlertDescription>
              {t('settings.model.failed')}{t('common.labelSeparator')}{choices.error}
              <Paragraph className="mt-2"><Button variant="default" size="default" disabled={connection.offline} onClick={() => setRound(round + 1)}>{t('settings.model.retry')}</Button></Paragraph>
            </AlertDescription>
          </Alert>
        )}
        {choices.data === null ? null : <Paragraph className="mb-0 mt-3 text-small text-muted">{t('settings.model.note')}</Paragraph>}
      </Section>

      <Section id="roles" title={t('settings.roles.title')} intro={t('settings.roles.intro')}>
        <PlainList className="m-0 grid list-none gap-3 p-0">
          {roles.map((role) => (
            <RoleRow key={role.role} role={role} settings={data} base={base} names={allNames} options={roleOptions} disabled={working !== null} assign={assign} reload={settings.reload} />
          ))}
        </PlainList>
        <Paragraph className="mb-0 mt-3 text-small text-muted">{t('settings.roles.note')}</Paragraph>
      </Section>

      <Section id="language" title={t('settings.language.title')} intro={t('settings.language.intro')}>
        <SegmentedChoice
          label={t('settings.language.title')}
          testId={SETTINGS_CONTROLS.language}
          value={data.language}
          options={[
            { value: 'ru', label: t('navigation.russian'), testId: 'settings-language-ru' },
            { value: 'en', label: t('navigation.english'), testId: 'settings-language-en' },
          ]}
          disabled={connection.offline}
          onChange={(value) => saveSettings({ language: value })}
        />
        <Paragraph className="mb-0 mt-2 text-small text-muted">{t('settings.language.note')}</Paragraph>
      </Section>

      <Section id="fills" title={t('settings.fills.title')} intro={t('settings.fills.intro')}>
        <Stack className="flex flex-wrap items-end gap-3">
          <FieldLabel className="grid gap-1 text-small">{t('settings.fills.tokenCap')}
            <Input data-testid="settings-token-cap" type="number" min={1} step={1} value={cap ?? String(data.tokenCap)} aria-invalid={!capValid} onInput={(event) => setCap(event.currentTarget.value)} />
          </FieldLabel>
          <Button variant="default" size="default" disabled={connection.offline || working !== null || !capValid || capValue === data.tokenCap} onClick={() => saveSettings({ tokenCap: capValue })} data-testid="settings-token-cap-save">{t('settings.fills.save')}</Button>
        </Stack>
        <Paragraph className="mb-0 mt-2 text-small text-muted" data-testid="settings-token-cap-note">{capValid ? t('settings.fills.tokenCapNote', { cap: capValue }) : t('settings.fills.tokenCapInvalid')}</Paragraph>
      </Section>

      <Section id="reader" title={t('settings.reader.title')} intro={t('settings.reader.intro')}>
        {reader.data === null ? <Paragraph className="m-0 text-muted">{t('knowledge.loading')}</Paragraph> : (
          <SegmentedChoice
            label={t('settings.reader.title')}
            testId={SETTINGS_CONTROLS.reader}
            value={reader.data.role}
            options={reader.data.roles.map((role) => ({
              value: role,
              label: t(`knowledge.roles.names.${role}`, { defaultValue: role }),
              testId: `settings-reader-${role}`,
            }))}
            disabled={connection.offline}
            onChange={saveReader}
          />
        )}
        {reader.error === null ? null : <Paragraph className="mb-0 mt-2 text-small" role="alert">{reader.error}</Paragraph>}
      </Section>
    </Stack>
  );
}
