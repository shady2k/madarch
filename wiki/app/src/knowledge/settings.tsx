/**
 * The product settings page (madarch-m38l.11), reached from the bottom of the sidebar: the agent that writes the pages,
 * the model and the reasoning level that agent reports over ACP (madarch holds no list of models), the language of the
 * pages, the writer's bounds, where the product lives on this machine, and the two dangerous actions. Every action says
 * in plain words that it is local to this machine and what it does to which files; nothing here is sent anywhere.
 */
import { useEffect, useState, type ReactElement, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangleIcon } from 'lucide-react';
import { appPath } from '../app-base.js';
import { navigateTo } from '../hold.js';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert.js';
import { Badge } from '@/components/ui/badge.js';
import { Button } from '@/components/ui/button.js';
import { chooseAgent, chooseModelRole, getAgentChoices, getAgentChoicesFor, getAgents, getProductSettings, rewritePages, saveProductSettings, startFresh } from './api.js';
import { useRead } from './live.js';
import { PageSkeleton } from './skeleton.js';
import { useTabTitle } from './tabs.js';
import { K_HOME } from './routes.js';
import type { AgentChoices, AgentOffer, Choice, ModelRoleId, ProductSettings, WikiStatus } from './types.js';

const message = (failure: unknown): string => (failure instanceof Error ? failure.message : String(failure));

function Section({ id, title, intro, children, danger = false }: { id: string; title: string; intro?: string; children: ReactNode; danger?: boolean }): ReactElement {
  return (
    <section className={`mb-6 rounded-[var(--radius-card)] border p-4 ${danger ? 'border-dashed border-ink' : 'border-line'}`} data-testid={`settings-${id}`}>
      <h2 className="!mt-0 flex items-center gap-2">{danger && <AlertTriangleIcon aria-hidden="true" className="size-5" />}{title}</h2>
      {intro !== undefined && <p className="text-secondary">{intro}</p>}
      {children}
    </section>
  );
}

/** The agent: which one writes the pages. A choice is saved at once; an adapter that is not here is fetched on the yes the button is. */
function AgentSection({ settings, reload }: { settings: ProductSettings; reload: () => void }): ReactElement {
  const { t } = useTranslation();
  const [agents, setAgents] = useState<AgentOffer[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    getAgents(controller.signal).then((answer) => setAgents(answer.agents), (failure: unknown) => { if (!controller.signal.aborted) setError(message(failure)); });
    return () => controller.abort();
  }, []);
  const chosen = settings.chosenAgent?.id ?? null;
  const choose = (id: string | null): void => {
    setWorking(id ?? 'none');
    setError(null);
    chooseAgent(id, true).then(() => { setWorking(null); reload(); }, (failure: unknown) => { setWorking(null); setError(message(failure)); });
  };
  return (
    <Section id="agent" title={t('settings.agent.title')} intro={t('settings.agent.intro')}>
      <ul className="m-0 grid list-none gap-2 p-0">
        {(agents ?? []).map((agent) => (
          <li key={agent.id} className="flex flex-wrap items-center gap-3 rounded-[var(--radius-card)] border border-line p-3" data-testid={`settings-agent-${agent.id}`} data-chosen={chosen === agent.id ? 'true' : 'false'}>
            <span className="min-w-0 flex-1">
              <span className="block font-medium text-ink">{agent.label}</span>
              <span className="block text-small text-muted">
                {agent.installed ? t('knowledge.writer.installed') : t('knowledge.writer.notInstalled', { package: agent.install?.package ?? agent.label, version: agent.install?.version ?? '', size: agent.install?.size ?? '', folder: agent.install?.folder ?? '' })}
                {agent.login === 'signed-in' ? ` ${t('knowledge.writer.signedIn')}` : agent.login === 'not-signed-in' ? ` ${t('knowledge.writer.notSignedIn', { agent: agent.label })}` : ''}
              </span>
            </span>
            {chosen === agent.id
              ? <Badge variant="solid" data-testid="settings-agent-chosen">{t('settings.agent.chosen')}</Badge>
              : <Button variant="default" size="default" disabled={working !== null || settings.busy} onClick={() => choose(agent.id)} data-testid={`settings-agent-choose-${agent.id}`}>{agent.installed ? t('settings.agent.choose') : t('settings.agent.installAndChoose')}</Button>}
          </li>
        ))}
        {agents === null && error === null && <li className="text-muted">{t('knowledge.loading')}</li>}
      </ul>
      {chosen !== null && <p className="mb-0 mt-3"><Button variant="default" size="default" disabled={working !== null || settings.busy} onClick={() => choose(null)} data-testid="settings-agent-none">{t('settings.agent.none')}</Button></p>}
      {settings.busy && <p className="mb-0 mt-3 text-small text-muted">{t('settings.busy')}</p>}
      {error !== null && <p className="mb-0 mt-3 text-small" role="alert" data-testid="settings-agent-error">{error}</p>}
    </Section>
  );
}

function ChoiceSelect({ id, label, choice, value, onChange, disabled }: { id: string; label: string; choice: Choice; value: string | undefined; onChange: (value: string | null) => void; disabled: boolean }): ReactElement {
  const { t } = useTranslation();
  const picked = choice.values.find((entry) => entry.value === (value ?? choice.current));
  return (
    <div className="mb-4 last:mb-0">
      <label htmlFor={id} className="mb-1 block text-small font-medium text-ink">{label}</label>
      <select
        id={id}
        data-testid={id}
        className="w-full max-w-[28rem] rounded-[var(--radius-control)] border border-line bg-page px-2.5 py-2 text-body text-ink"
        value={value ?? ''}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value === '' ? null : event.target.value)}
      >
        <option value="">{choice.current === null ? t('settings.model.agentsOwn') : t('settings.model.agentsOwnNamed', { name: choice.values.find((entry) => entry.value === choice.current)?.name ?? choice.current })}</option>
        {choice.values.map((entry) => <option key={entry.value} value={entry.value}>{entry.name}</option>)}
      </select>
      {picked?.description !== undefined && <p className="mb-0 mt-1 text-small text-muted">{picked.description}</p>}
    </div>
  );
}

/** The model and reasoning level, exactly as the chosen agent reports them over ACP. */
function ModelSection({ settings, reload }: { settings: ProductSettings; reload: () => void }): ReactElement {
  const { t } = useTranslation();
  const [answer, setAnswer] = useState<AgentChoices | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [round, setRound] = useState(0);
  const chosen = settings.chosenAgent;
  useEffect(() => {
    if (chosen === null) { setAnswer(null); setError(null); return; }
    const controller = new AbortController();
    setAnswer(null);
    setError(null);
    getAgentChoices(round > 0, controller.signal).then(setAnswer, (failure: unknown) => { if (!controller.signal.aborted) setError(message(failure)); });
    return () => controller.abort();
  }, [chosen?.id, round]);
  const save = (change: { model?: string | null; reasoning?: string | null }): void => {
    setSaving(true);
    setError(null);
    saveProductSettings(change).then(() => { setSaving(false); reload(); }, (failure: unknown) => { setSaving(false); setError(message(failure)); });
  };
  return (
    <Section id="model" title={t('settings.model.title')} intro={t('settings.model.intro')}>
      {chosen === null && <p className="m-0 text-muted" data-testid="settings-model-none">{t('settings.model.noAgent')}</p>}
      {chosen !== null && answer === null && error === null && <p className="m-0 text-muted" data-testid="settings-model-asking">{t('settings.model.asking', { agent: chosen.label })}</p>}
      {answer !== null && answer.choices.model === null && answer.choices.reasoning === null && <p className="m-0 text-muted" data-testid="settings-model-reports-none">{t('settings.model.reportsNone', { agent: chosen?.label ?? '' })}</p>}
      {answer !== null && answer.choices.model !== null && <ChoiceSelect id="settings-model-select" label={t('settings.model.model')} choice={answer.choices.model} value={chosen?.model} disabled={saving || settings.busy} onChange={(value) => save({ model: value })} />}
      {answer !== null && answer.choices.reasoning !== null && <ChoiceSelect id="settings-reasoning-select" label={t('settings.model.reasoning')} choice={answer.choices.reasoning} value={chosen?.reasoning} disabled={saving || settings.busy} onChange={(value) => save({ reasoning: value })} />}
      {error !== null && (
        <Alert variant="problem" className="mt-3" data-testid="settings-model-error">
          <AlertTitle>{t('settings.model.failed')}</AlertTitle>
          <AlertDescription><p>{error}</p><p className="mt-2"><Button variant="default" size="default" onClick={() => setRound(round + 1)}>{t('settings.model.retry')}</Button></p></AlertDescription>
        </Alert>
      )}
      {answer !== null && <p className="mb-0 mt-3 text-small text-muted">{t('settings.model.note')}</p>}
    </Section>
  );
}

/**
 * The model roles (madarch-j6ho.2): writing, classification and analysis. A role is assigned a pair; an unassigned
 * role shows, in words, that it uses writing's pair. No feature names a model, so this page is the only place a pair
 * is chosen for a role.
 */
function RolesSection({ settings, reload }: { settings: ProductSettings; reload: () => void }): ReactElement {
  const { t } = useTranslation();
  const [agents, setAgents] = useState<AgentOffer[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState<ModelRoleId | null>(null);
  const [round, setRound] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    getAgents(controller.signal).then((answer) => setAgents(answer.agents), (failure: unknown) => { if (!controller.signal.aborted) setError(message(failure)); });
    return () => controller.abort();
  }, [round]);
  // The settings bring the names of the agents they name (madarch-j6ho.2): a row stands with the name at once, and the
  // agents read later fill in the names of the agents no role names.
  const label = (id: string): string => settings.agentNames?.[id] ?? agents?.find((agent) => agent.id === id)?.label ?? id;
  // The selector's options come from the names the settings bring, so it never stands with the fallback alone while the
  // agents are read; the agents list only adds availability and the install wording for a name it knows (madarch-j6ho.2).
  const namedAgents = Object.entries(settings.agentNames ?? {});
  const options = [
    ...namedAgents.map(([id, name]) => {
      const offered = agents?.find((agent) => agent.id === id);
      return { id, name: offered === undefined || offered.installed ? name : t('settings.roles.installs', { agent: name }) };
    }),
    ...(agents ?? []).filter((agent) => !namedAgents.some(([id]) => id === agent.id)).map((agent) => ({
      id: agent.id,
      name: agent.installed ? agent.label : t('settings.roles.installs', { agent: agent.label }),
    })),
  ];
  // A role assigned to an agent gets that agent's own model and reasoning level to choose from (madarch-j6ho.2,
  // finding 3); the answers are asked once per agent and kept for every role using it.
  const [choices, setChoices] = useState<Record<string, AgentChoices | null>>({});
  const askFor = [...new Set(settings.roles.roles.flatMap((role) => role.role !== 'writing' && role.source === 'assigned' && role.pair !== null ? [role.pair.agent] : []))].sort();
  const askForKey = askFor.join(',');
  useEffect(() => {
    if (askForKey === '') return;
    const controller = new AbortController();
    for (const agent of askForKey.split(',')) {
      getAgentChoicesFor(agent, false, controller.signal).then(
        (answer) => setChoices((held) => ({ ...held, [agent]: answer })),
        () => setChoices((held) => ({ ...held, [agent]: null })),
      );
    }
    return () => controller.abort();
  }, [askForKey, round]);
  const save = (role: ModelRoleId, agent: string, change: { model?: string | null; reasoning?: string | null }): void => {
    setWorking(role);
    setError(null);
    chooseModelRole(role, agent, change).then(() => { setWorking(null); reload(); }, (failure: unknown) => { setWorking(null); setError(message(failure)); });
  };
  const assign = (role: ModelRoleId, agent: string | null): void => {
    setWorking(role);
    setError(null);
    chooseModelRole(role, agent, { install: true }).then(() => { setWorking(null); reload(); }, (failure: unknown) => { setWorking(null); setError(message(failure)); });
  };
  return (
    <Section id="roles" title={t('settings.roles.title')} intro={t('settings.roles.intro')}>
      <ul className="m-0 grid list-none gap-3 p-0">
        {settings.roles.roles.map((role) => {
          const roleLabel = t(`settings.roles.${role.role}`);
          const pairLabel = role.pair === null
            ? t('settings.roles.unassigned')
            : `${label(role.pair.agent)} · ${role.pair.model ?? t('settings.roles.agentsOwn')}`;
          const assignedChoices = role.role !== 'writing' && role.source === 'assigned' && role.pair !== null ? choices[role.pair.agent] : undefined;
          const modelChoice = assignedChoices?.choices.model ?? null;
          const reasoningChoice = assignedChoices?.choices.reasoning ?? null;
          const assignedAgent = role.pair?.agent ?? '';
          return (
            <li key={role.role} className="rounded-[var(--radius-card)] border border-line p-3" data-testid={`settings-role-${role.role}`} data-source={role.source}>
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span className="font-medium text-ink">{roleLabel}</span>
                <span className="text-small text-secondary" data-testid={`settings-role-pair-${role.role}`}>{pairLabel}</span>
              </div>
              {role.source === 'fallback' && role.fallbackFrom !== undefined && (
                <p className="mb-0 mt-1 text-small text-muted" data-testid={`settings-role-fallback-${role.role}`}>
                  {t('settings.roles.fallback', { role: t(`settings.roles.${role.fallbackFrom}`) })}
                </p>
              )}
              {role.source === 'none' && role.pair === null && (
                <p className="mb-0 mt-1 text-small text-muted" data-testid={`settings-role-none-${role.role}`}>{t('settings.roles.noDefault')}</p>
              )}
              {(modelChoice !== null || reasoningChoice !== null) && (
                <div className="mt-3" data-testid={`settings-role-choices-${role.role}`}>
                  {modelChoice !== null && (
                    <ChoiceSelect id={`settings-role-model-${role.role}`} label={t('settings.model.model')} choice={modelChoice} value={role.pair?.model} disabled={working !== null || settings.busy} onChange={(value) => save(role.role, assignedAgent, { model: value })} />
                  )}
                  {reasoningChoice !== null && (
                    <ChoiceSelect id={`settings-role-reasoning-${role.role}`} label={t('settings.model.reasoning')} choice={reasoningChoice} value={role.pair?.reasoning} disabled={working !== null || settings.busy} onChange={(value) => save(role.role, assignedAgent, { reasoning: value })} />
                  )}
                </div>
              )}
              {role.role !== 'writing' && (
                <div className="mt-2">
                  <label htmlFor={`settings-role-select-${role.role}`} className="mb-1 block text-small font-medium text-ink">{t('settings.roles.assign', { role: roleLabel })}</label>
                  <select
                    id={`settings-role-select-${role.role}`}
                    data-testid={`settings-role-select-${role.role}`}
                    className="w-full max-w-[28rem] rounded-[var(--radius-control)] border border-line bg-page px-2.5 py-2 text-body text-ink"
                    value={role.source === 'assigned' && role.pair !== null ? role.pair.agent : ''}
                    disabled={working !== null || settings.busy}
                    onChange={(event) => assign(role.role, event.target.value === '' ? null : event.target.value)}
                  >
                    <option value="">{settings.roles.defaultPair === null ? t('settings.roles.unassigned') : t('settings.roles.useDefault', { role: t('settings.roles.writing') })}</option>
                    {options.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
                  </select>
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {agents === null && error === null && <p className="mb-0 mt-3 text-small text-muted">{t('knowledge.loading')}</p>}
      {settings.busy && <p className="mb-0 mt-3 text-small text-muted">{t('settings.busy')}</p>}
      {error !== null && (
        <Alert variant="problem" className="mt-3" data-testid="settings-roles-error">
          <AlertTitle>{t('settings.roles.failed')}</AlertTitle>
          <AlertDescription><p>{error}</p><p className="mt-2"><Button variant="default" size="default" onClick={() => setRound(round + 1)}>{t('settings.model.retry')}</Button></p></AlertDescription>
        </Alert>
      )}
      <p className="mb-0 mt-3 text-small text-muted">{t('settings.roles.note')}</p>
    </Section>
  );
}

function LanguageSection({ settings, reload }: { settings: ProductSettings; reload: () => void }): ReactElement {
  const { t } = useTranslation();
  const [error, setError] = useState<string | null>(null);
  const set = (language: string): void => {
    setError(null);
    saveProductSettings({ language }).then(reload, (failure: unknown) => setError(message(failure)));
  };
  return (
    <Section id="language" title={t('settings.language.title')} intro={t('settings.language.intro')}>
      <div className="flex flex-wrap gap-2" role="radiogroup" aria-label={t('settings.language.title')}>
        {(['ru', 'en'] as const).map((code) => (
          <label key={code} className="flex cursor-pointer items-center gap-2 rounded-[var(--radius-card)] border border-line px-3 py-1.5 has-[:checked]:border-ink" data-testid={`settings-language-${code}`}>
            <input type="radio" name="settings-language" checked={settings.language === code} disabled={settings.busy} onChange={() => set(code)} />
            <span>{t(code === 'ru' ? 'navigation.russian' : 'navigation.english')}</span>
          </label>
        ))}
      </div>
      <p className="mb-0 mt-2 text-small text-muted">{t('settings.language.note')}</p>
      {error !== null && <p className="mb-0 mt-2 text-small" role="alert">{error}</p>}
    </Section>
  );
}

function BoundsSection({ settings }: { settings: ProductSettings }): ReactElement {
  const { t } = useTranslation();
  const bounds = settings.bounds;
  return (
    <Section id="bounds" title={t('settings.bounds.title')} intro={t('settings.bounds.intro')}>
      <dl className="m-0 grid grid-cols-[max-content_1fr] gap-x-6 gap-y-1 text-small">
        <dt className="text-secondary">{t('settings.bounds.turns')}</dt><dd className="m-0" data-testid="bound-turns">{bounds.turns}</dd>
        <dt className="text-secondary">{t('settings.bounds.minutes')}</dt><dd className="m-0" data-testid="bound-minutes">{bounds.minutes}</dd>
        <dt className="text-secondary">{t('settings.bounds.calls')}</dt><dd className="m-0">{bounds.toolCalls}</dd>
        <dt className="text-secondary">{t('settings.bounds.attempts')}</dt><dd className="m-0">{bounds.writeAttempts}</dd>
        <dt className="text-secondary">{t('settings.bounds.domains')}</dt><dd className="m-0">{bounds.maxDomains}</dd>
      </dl>
    </Section>
  );
}

function PlacesSection({ settings }: { settings: ProductSettings }): ReactElement {
  const { t } = useTranslation();
  return (
    <Section id="places" title={t('settings.places.title')} intro={t('settings.places.intro')}>
      <dl className="m-0 grid grid-cols-1 gap-x-6 gap-y-1 text-small sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <dt className="text-secondary">{t('settings.places.folder')}</dt><dd className="m-0 break-all"><code data-testid="places-folder">{settings.folder}</code></dd>
        <dt className="text-secondary">{t('settings.places.store')}</dt><dd className="m-0 break-all"><code data-testid="places-store">{settings.store}</code></dd>
      </dl>
      <p className="mb-0 mt-3 text-small text-muted" data-testid="places-push">{t('settings.places.noPush')}</p>
    </Section>
  );
}

type Danger = 'rewrite' | 'fresh';

/** The question that comes before either action, opened under its button: what goes, what stays, and that it is local. */
function DangerPanel({ kind, settings, onClose, done }: { kind: Danger; settings: ProductSettings; onClose: () => void; done: (leave: boolean) => void }): ReactElement {
  const { t } = useTranslation();
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const plan = settings.danger;
  const confirm = (): void => {
    setWorking(true);
    setError(null);
    (kind === 'rewrite' ? rewritePages().then(() => ({} as { fillRefused?: string })) : startFresh(plan.fresh)).then(
      (result) => {
        setWorking(false);
        // The pages and the graph are gone but the fill could not start: say why and keep the panel, with what to do.
        if (result.fillRefused !== undefined) { setError(t('settings.danger.fresh.fillRefused', { reason: result.fillRefused })); done(false); return; }
        onClose();
        done(true);
      },
      (failure: unknown) => { setWorking(false); setError(message(failure)); },
    );
  };
  const pages = kind === 'fresh' ? plan.fresh.agentPages : plan.rewrite.agentPages;
  const kept = kind === 'fresh' ? plan.fresh.keptPages : plan.rewrite.keptPages;
  const title = kind === 'fresh' ? t('settings.danger.fresh.title') : t('settings.danger.rewrite.title');
  return (
    <div role="group" aria-label={title} className="mt-3 grid min-w-0 gap-2 rounded-[var(--radius-card)] border border-dashed border-ink bg-[var(--surface-soft)] p-4 text-small text-secondary [overflow-wrap:anywhere]" data-testid="danger-dialog" data-kind={kind}>
      <p className="m-0 font-medium text-ink">{t('settings.danger.local', { folder: settings.folder })}</p>
      <p className="m-0">{t('settings.danger.willDo')}</p>
      <ul className="m-0 list-disc ps-5">
        <li data-testid="danger-pages">{pages.length === 0 ? t('knowledge.reset.noPages') : t('knowledge.reset.pages', { count: pages.length, list: pages.join(', ') })}</li>
        {kind === 'fresh' && <li>{t('settings.danger.fresh.graph', { store: settings.store })}</li>}
        {kind === 'fresh' && <li data-testid="danger-questions">{t('knowledge.reset.questions', { count: plan.fresh.unansweredQuestions.length })}</li>}
        {kind === 'fresh' && <li data-testid="danger-answers">{t('knowledge.reset.answers', { count: plan.fresh.keptAnswers.length })}</li>}
        {kind === 'fresh' && <li data-testid="danger-starter">{t('settings.danger.fresh.starter', { files: plan.fresh.replacedStarterFiles.length })}</li>}
        <li>{kind === 'fresh' ? t('settings.danger.fresh.fill') : t('settings.danger.rewrite.fill')}</li>
      </ul>
      {kind === 'fresh' && plan.fresh.editedStarterFiles.length > 0 && <p className="m-0" data-testid="danger-edited">{t('settings.danger.fresh.edited', { list: plan.fresh.editedStarterFiles.join(', ') })}</p>}
      {pages.length > 0 && <p className="m-0" data-testid="danger-agent-edits">{t('settings.danger.agentEdits')}</p>}
      {kept.length > 0 && <p className="m-0">{t('knowledge.reset.keptPages', { list: kept.join(', ') })}</p>}
      <p className="m-0">{t('settings.danger.keeps')}</p>
      <p className="m-0">{t('settings.danger.nothingSent')}</p>
      {error !== null && <p className="m-0" role="alert" data-testid="danger-error">{error}</p>}
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="default" size="default" onClick={onClose} data-testid="danger-cancel">{t('knowledge.reset.cancel')}</Button>
        <Button variant="default" size="default" className="!border-ink !bg-ink !text-page" onClick={confirm} disabled={working} data-testid="danger-confirm">{kind === 'fresh' ? t('settings.danger.fresh.confirm') : t('settings.danger.rewrite.confirm')}</Button>
      </div>
    </div>
  );
}

function DangerSection({ settings, refresh }: { settings: ProductSettings; refresh: () => void }): ReactElement {
  const { t } = useTranslation();
  const [kind, setKind] = useState<Danger | null>(null);
  const noAgent = settings.chosenAgent === null;
  const blocked = settings.busy || settings.dangerError !== undefined;
  const finish = (leave: boolean): void => { if (leave) navigateTo(appPath(K_HOME)); refresh(); };
  return (
    <Section id="danger" title={t('settings.danger.title')} intro={t('settings.danger.intro')} danger>
      <div className="grid gap-4">
        <div data-testid="danger-rewrite">
          <h3 className="!mt-0">{t('settings.danger.rewrite.title')}</h3>
          <p className="mt-0 text-secondary">{t('settings.danger.rewrite.what')}</p>
          <p className="text-small text-muted">{t('settings.danger.local', { folder: settings.folder })}</p>
          <Button variant="default" size="default" disabled={blocked || noAgent || kind === 'rewrite'} onClick={() => setKind('rewrite')} data-testid="danger-rewrite-open">{t('settings.danger.rewrite.title')}</Button>
          {noAgent && <p className="mb-0 mt-2 text-small text-muted">{t('settings.danger.rewrite.needsAgent')}</p>}
          {kind === 'rewrite' && <DangerPanel kind="rewrite" settings={settings} onClose={() => setKind(null)} done={finish} />}
        </div>
        <div data-testid="danger-fresh">
          <h3 className="!mt-0">{t('settings.danger.fresh.title')}</h3>
          <p className="mt-0 text-secondary">{t('settings.danger.fresh.what')}</p>
          <p className="text-small text-muted">{t('settings.danger.local', { folder: settings.folder })}</p>
          <Button variant="default" size="default" disabled={blocked || kind === 'fresh'} onClick={() => setKind('fresh')} data-testid="danger-fresh-open">{t('settings.danger.fresh.title')}</Button>
          {kind === 'fresh' && <DangerPanel kind="fresh" settings={settings} onClose={() => setKind(null)} done={finish} />}
        </div>
        {settings.busy && <p className="m-0 text-small text-muted">{t('settings.busy')}</p>}
        {settings.dangerError !== undefined && <p className="m-0 text-small" role="alert" data-testid="danger-unavailable">{settings.dangerError}</p>}
      </div>
    </Section>
  );
}

/** The page: settings of this product on this machine. */
export function SettingsPage({ version, status, refresh }: { version: number; status: WikiStatus; refresh: () => void }): ReactElement {
  const { t } = useTranslation();
  const { data, error } = useRead('product-settings', version, (signal) => getProductSettings(signal));
  useTabTitle(t('settings.title'));
  if (data === null && error === null) return <PageSkeleton testId="settings-loading" rows />;
  if (data === null) return <Alert variant="problem" data-testid="settings-error"><AlertTitle>{t('settings.missing')}</AlertTitle><AlertDescription><p>{error}</p></AlertDescription></Alert>;
  const again = refresh;
  return (
    <section data-testid="settings-page">
      <header className="mb-6">
        <h1>{t('settings.title')}</h1>
        <p className="text-secondary">{t('settings.intro', { product: status.product.name })}</p>
      </header>
      <AgentSection settings={data} reload={again} />
      <ModelSection settings={data} reload={again} />
      <RolesSection settings={data} reload={again} />
      <LanguageSection settings={data} reload={again} />
      <BoundsSection settings={data} />
      <PlacesSection settings={data} />
      <DangerSection settings={data} refresh={again} />
    </section>
  );
}
