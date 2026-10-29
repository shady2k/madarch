/**
 * The agent stage of the fill (decision 0029; madarch-m38l.3): the choice of
 * the agent that writes the product pages, with the bound stated in plain words
 * before the press, and the card that shows each unit as the agent writes it.
 * The reader presses once; the code fill flows into the agent stage on the
 * server, and the pages appear in the open wiki as each unit writes its page.
 */
import { useEffect, useState, type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert.js';
import { Button } from '@/components/ui/button.js';
import { Card, CardContent } from '@/components/ui/card.js';
import { chooseAgent, getAgents, startFill } from './api.js';
import { KLink } from './blocks.js';
import { kindNameOf } from './kind-names.js';
import { K_FILL } from './routes.js';
import { FailureNote } from './errors.js';
import type { AgentOffer, WikiStatus, WriterUnit } from './types.js';

/** The reader's pick: an agent's id, or `null` for no agent. `undefined` until the reader touches it. */
export type Pick = string | null | undefined;

/** The agents offered and the pick; `commit` saves the pick (installing an adapter on the reader's yes) and answers the agent chosen. */
export function useAgentChoice(status: WikiStatus): {
  agents: AgentOffer[] | null;
  pick: string | null;
  setPick: (id: string | null) => void;
  offer: AgentOffer | undefined;
  loadError: string | null;
  /** The language the pages are written in: the reader's pick, else the product's own, else the interface's. */
  language: string;
  setLanguage: (language: string) => void;
  commit: () => Promise<void>;
} {
  const { i18n } = useTranslation();
  const [agents, setAgents] = useState<AgentOffer[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [picked, setPicked] = useState<Pick>(undefined);
  useEffect(() => {
    const controller = new AbortController();
    getAgents(controller.signal).then(
      (answer) => setAgents(answer.agents),
      (failure: unknown) => { if (!controller.signal.aborted) setLoadError(failure instanceof Error ? failure.message : String(failure)); },
    );
    return () => controller.abort();
  }, []);
  const [pickedLanguage, setPickedLanguage] = useState<string | undefined>(undefined);
  const interfaceLanguage = (i18n.resolvedLanguage ?? 'en').startsWith('ru') ? 'ru' : 'en';
  // A product with pages keeps its language until the reader changes it; one without follows the interface.
  const language = pickedLanguage ?? (status.filled && status.kinds.some((kind) => kind.source === 'markdown' && kind.count > 0) ? status.language : interfaceLanguage);
  const saved = status.chosenAgent?.id ?? null;
  const pick = picked === undefined ? saved : picked;
  const offer = agents?.find((candidate) => candidate.id === pick);
  const commit = async (): Promise<void> => {
    if (pick === saved && (offer === undefined || offer.installed)) return;
    await chooseAgent(pick, true);
  };
  return { agents, pick, setPick: setPicked, offer, loadError, language, setLanguage: setPickedLanguage, commit };
}

function boundWords(status: WikiStatus, t: (key: string, options?: Record<string, unknown>) => string): string {
  return t('knowledge.writer.bound', { turns: status.bounds.turns, minutes: status.bounds.minutes, calls: status.bounds.toolCalls, attempts: status.bounds.writeAttempts, domains: status.bounds.maxDomains });
}

/** The choice of the agent, the cost of each in plain words and the bound; the press that follows is the consent. */
export function AgentChoice({ status, choice }: { status: WikiStatus; choice: ReturnType<typeof useAgentChoice> }): ReactElement {
  const { t } = useTranslation();
  const { agents, pick, setPick, loadError } = choice;
  const options: { id: string | null; label: string; note: string }[] = [
    ...(agents ?? []).map((agent) => ({
      id: agent.id,
      label: agent.label,
      note: [
        agent.installed ? t('knowledge.writer.installed') : t('knowledge.writer.notInstalled', { package: agent.install?.package ?? agent.label, version: agent.install?.version ?? '', size: agent.install?.size ?? '', folder: agent.install?.folder ?? '' }),
        agent.login === 'signed-in' ? t('knowledge.writer.signedIn') : agent.login === 'not-signed-in' ? t('knowledge.writer.notSignedIn', { agent: agent.label }) : '',
      ].filter((part) => part !== '').join(' '),
    })),
    { id: null, label: t('knowledge.writer.noAgent'), note: t('knowledge.writer.noAgentNote') },
  ];
  return (
    <fieldset className="mb-4 mt-0 border-0 p-0" data-testid="agent-choice">
      <legend className="mb-2 text-small font-medium text-ink">{t('knowledge.writer.chooseTitle')}</legend>
      <div className="grid gap-2">
        {options.map((option) => (
          <label key={option.id ?? 'none'} className="flex cursor-pointer items-start gap-3 rounded-[var(--radius-card)] border border-line p-3 has-[:checked]:border-ink" data-testid={`agent-${option.id ?? 'none'}`}>
            <input type="radio" name="agent" className="mt-1" checked={pick === option.id} onChange={() => setPick(option.id)} />
            <span>
              <span className="block font-medium text-ink">{option.label}</span>
              <span className="block text-small text-muted">{option.note}</span>
            </span>
          </label>
        ))}
      </div>
      {loadError !== null && <p className="mb-0 mt-2 text-small" role="alert">{loadError}</p>}
      {pick !== null && (
        <div className="mt-4" role="radiogroup" aria-label={t('knowledge.writer.languageTitle')} data-testid="content-language">
          <div className="mb-1.5 text-small font-medium text-ink">{t('knowledge.writer.languageTitle')}</div>
          <div className="flex flex-wrap gap-2">
            {(['ru', 'en'] as const).map((code) => (
              <label key={code} className="flex cursor-pointer items-center gap-2 rounded-[var(--radius-card)] border border-line px-3 py-1.5 has-[:checked]:border-ink" data-testid={`content-language-${code}`}>
                <input type="radio" name="content-language" checked={choice.language === code} onChange={() => choice.setLanguage(code)} />
                <span>{t(code === 'ru' ? 'navigation.russian' : 'navigation.english')}</span>
              </label>
            ))}
          </div>
          <p className="mb-0 mt-1.5 text-small text-muted">{t('knowledge.writer.languageNote')}</p>
        </div>
      )}
      <p className="mb-0 mt-3 text-small text-muted" data-testid="agent-bound">{boundWords(status, t)}</p>
    </fieldset>
  );
}

export const UNIT_STATE_KEY: Record<WriterUnit['state'], string> = {
  waiting: 'knowledge.writer.unitWaiting',
  writing: 'knowledge.writer.unitWriting',
  written: 'knowledge.writer.unitWritten',
  failed: 'knowledge.writer.unitFailed',
  'not-written': 'knowledge.writer.unitNotWritten',
};

/**
 * What a reader calls the page a unit writes: the kind's name the manifest declares and the page's own title, so «Термин
 * Capture» and never the writer's word for its work (madarch-m38l.23). A page whose kind or title the status could not
 * resolve is named by what it is known by.
 */
export function unitName(unit: WriterUnit, kinds: WikiStatus['kinds'], language: string): string {
  if (unit.title === undefined) return unit.unit;
  return unit.kind === undefined ? unit.title : `${kindNameOf(kinds, unit.kind, 'one', language)} ${unit.title}`;
}

/**
 * The agent stage on the pages of the product, in one line while it runs: who writes the pages, how far it is, and the way
 * to the fill page, where every page it takes up stands with its state and its journal (madarch-m38l.23). A failed run keeps
 * its reason and its two buttons here; a finished one is only the top bar's status.
 */
export function WriterLine({ status, refresh }: { status: WikiStatus; refresh: () => void }): ReactElement | null {
  const { t, i18n } = useTranslation();
  const [retrying, setRetrying] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  const writer = status.writer;
  const dismissKey = `${status.product.id}:${writer.finishedAt ?? ''}`;
  const [dismissed, setDismissed] = useState<string | null>(() => { try { return window.sessionStorage.getItem('madarch-writer-dismissed'); } catch { return null; } });
  if (writer.agent === null || writer.state === 'idle' || writer.state === 'done') return null;
  if (writer.state === 'failed' && dismissed === dismissKey) return null;
  const agent = writer.agent.label;
  const written = writer.units.filter((unit) => unit.state === 'written').length;
  // How many pages the run means to write, as the writer counted them: not the pages it has merely taken up, which
  // would make «1 из 2» look nearly done at the very start. Until the count comes, the line says only the count.
  const total = writer.total;
  const open = <KLink href={K_FILL} className="text-small" testId="writer-line-open">{t('knowledge.fillPage.open')}</KLink>;
  if (writer.state === 'failed') {
    const retry = (): void => {
      setRetrying(true);
      setRefused(null);
      startFill(writer.agent?.id).then(() => { setRetrying(false); refresh(); }, (failure: unknown) => { setRetrying(false); setRefused(failure instanceof Error ? failure.message : String(failure)); });
    };
    return (
      <Alert variant="problem" className="mb-8" data-testid="writer-line" data-state="failed">
        <AlertTitle>{t('knowledge.writer.failedTitle', { agent })}</AlertTitle>
        <AlertDescription>
          {writer.message !== undefined && <div data-testid="writer-message"><FailureNote scope="writer" code={writer.code} message={writer.message} /></div>}
          <p className="mb-0 mt-2">{open}</p>
          <p className="mb-0 mt-3">
            <Button variant="default" size="default" disabled={retrying} data-testid="writer-retry" onClick={retry}>{t('knowledge.writer.retry')}</Button>
            {' '}
            <Button variant="default" size="default" data-testid="writer-dismiss" onClick={() => { try { window.sessionStorage.setItem('madarch-writer-dismissed', dismissKey); } catch { /* the dismissal lasts until the page is read again */ } setDismissed(dismissKey); }}>{t('knowledge.writer.dismiss')}</Button>
          </p>
          {refused !== null && <p className="mb-0 mt-3 text-small" role="alert">{refused}</p>}
        </AlertDescription>
      </Alert>
    );
  }
  const language = i18n.resolvedLanguage ?? 'en';
  const current = writer.units.find((unit) => unit.unit === writer.current) ?? writer.units.find((unit) => unit.state === 'writing');
  const name = current === undefined ? null : unitName(current, status.kinds, language);
  const words = writer.state === 'waiting'
    ? t('knowledge.writer.lineWaiting', { agent })
    : total === undefined
      ? name === null ? t('knowledge.writer.lineWritingCountShort', { agent, done: written }) : t('knowledge.writer.lineWritingCount', { agent, done: written, name })
      : name === null ? t('knowledge.writer.lineWritingShort', { agent, done: written, total }) : t('knowledge.writer.lineWriting', { agent, done: written, total, name });
  return (
    <Card className="mb-8" data-testid="writer-line" data-state={writer.state}>
      <CardContent className="pt-6">
        <p className="m-0 flex flex-wrap items-center gap-x-2 gap-y-1 text-small">
          <span className="text-ink" data-testid="writer-line-words">{words}</span>
          {open}
        </p>
      </CardContent>
    </Card>
  );
}

export { startFill };
