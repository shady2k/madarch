import { useEffect, useState, type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { appPath } from './app-base.js';
import { adapterStateKey, agentRows, apiKeyVariable, installOffered, loginStateKey, rowFor, type WizardPayload } from './fill-wizard-model.js';

type Agent = { name: 'claude' | 'codex' | 'omp'; available: boolean; version?: string; reason?: string };
type Inventory = { files: Array<unknown>; repositories: Array<{ path: string }>; declaredRepositoryCount: number; languages: Record<string, number>; estimates: Array<{ stage: string; units: number; estimatedAgentCalls: number; estimatedInputTokens: number; estimatedOutputTokens: number; estimatedMs?: number; measuredCalls?: number }> };
type Wizard = WizardPayload & { agents?: Agent[] };

/**
 * The first-fill wizard and the later settings controls. Its agent step is the
 * ACP probe's own report: for each agent the fill can drive, what the adapter
 * is doing, whether the agent is signed in, and — for an adapter that is
 * missing — the install madarch would run into its own folder, with the
 * package, the pinned version and the size that install really costs. Beside
 * the agent, the person picks how the fill pays: the agent's own sign-in, or an
 * API key that lives in the environment madarch runs in and never in madarch's
 * files (docs/changes/madarch-tzte.22.5).
 */
export function FillWizard(): ReactElement {
  const { t } = useTranslation();
  const [wizard, setWizard] = useState<Wizard | null>(null);
  const [chosen, setChosen] = useState<'claude' | 'codex' | 'omp' | ''>('');
  const [auth, setAuth] = useState<'subscription' | 'api-key'>('subscription');
  const [runExists, setRunExists] = useState(false);
  const [showWizard, setShowWizard] = useState(true);
  const [inventory, setInventory] = useState<Inventory | null>(null);
  const [results, setResults] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [maxUnits, setMaxUnits] = useState(100);
  const [step, setStep] = useState(1);
  const [ompModel, setOmpModel] = useState('');
  const [installing, setInstalling] = useState('');
  const [installed, setInstalled] = useState('');
  /** The adapters whose install the person declined: nothing ran, and the by-hand way stays on the row. */
  const [declined, setDeclined] = useState<string[]>([]);

  const adopt = (data: Wizard): void => {
    setWizard(data);
    const adopted = data.chosen ?? '';
    setChosen(adopted);
    // A stored API-key choice for an agent whose client reads no key madarch
    // knows is no choice: the row shows its own sign-in instead of a radio the
    // start route would refuse.
    const stored = data.auth === 'api-key' && apiKeyVariable(rowFor(agentRows(data), adopted)) !== undefined;
    setAuth(stored ? 'api-key' : 'subscription');
    setOmpModel(typeof data.model === 'string' ? data.model : '');
    setRunExists(data.runExists === true);
    setShowWizard(data.runExists !== true);
  };
  const load = async (): Promise<void> => {
    try {
      const response = await fetch(appPath('/api/fill/wizard'));
      const data = await response.json();
      if (!response.ok) throw new Error(data.message ?? data.error?.message ?? `Server answered ${response.status}`);
      adopt(data as Wizard);
    } catch (error) { setError(error instanceof Error ? error.message : String(error)); }
  };
  useEffect(() => { const timer = window.setTimeout(() => { void load(); }, 150); return () => window.clearTimeout(timer); }, []);
  const post = async (path: string, body: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const response = await fetch(appPath(path), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.message ?? data.error?.message ?? `Server answered ${response.status}`);
    return data as Record<string, unknown>;
  };
  const doTest = async (agent: 'claude' | 'codex' | 'omp'): Promise<void> => {
    setBusy(true); setError('');
    try {
      const data = await post('/api/fill/test', { agent, ...(agent === 'omp' ? { model: ompModel } : {}) }) as { result: { status: string; reason?: string } };
      setResults({ ...results, [agent]: data.result.status + (data.result.reason ? `: ${data.result.reason}` : '') });
    } catch (error) { setError(error instanceof Error ? error.message : String(error)); } finally { setBusy(false); }
  };
  const doInstall = async (agentId: string): Promise<void> => {
    setInstalling(agentId); setError(''); setInstalled('');
    try {
      const data = await post('/api/fill/agent-install', { agent: agentId });
      const acp = data.acp as Wizard['acp'];
      if (acp !== undefined) setWizard({ ...(wizard ?? {}), acp });
      setInstalled(t('wizard.installed', { agent: rows.find((row) => row.adapter.id === agentId)?.label ?? agentId }));
    } catch (error) { setError(error instanceof Error ? error.message : String(error)); } finally { setInstalling(''); }
  };
  const inventoryNow = async (): Promise<void> => {
    setBusy(true); setError('');
    try {
      const response = await fetch(appPath('/api/fill/inventory'));
      const data = await response.json();
      if (!response.ok) throw new Error(data.message ?? data.error?.message ?? `Server answered ${response.status}`);
      setInventory({ ...data.inventory, declaredRepositoryCount: data.declaredRepositoryCount });
    } catch (error) { setError(error instanceof Error ? error.message : String(error)); } finally { setBusy(false); }
  };
  const start = async (): Promise<void> => {
    if (!chosen) return;
    setBusy(true); setError('');
    try {
      await post('/api/fill/start', { agent: chosen, auth, maxUnits, ...(chosen === 'omp' ? { model: ompModel } : {}) });
      setRunExists(true); setShowWizard(false);
      await load();
    } catch (error) { setError(error instanceof Error ? error.message : String(error)); } finally { setBusy(false); }
  };
  // A step ahead of the current one opens only when its own requirement holds:
  // the agent step always, the inventory step with an agent chosen, the start
  // step also with the inventory run. Going back is always allowed.
  const reachable = (target: number): boolean => target <= step || target === 1 || (target === 2) || (target === 3 && chosen !== '') || (target === 4 && chosen !== '' && inventory !== null);
  const rows = agentRows(wizard ?? undefined);
  /**
   * Choosing an agent. An agent whose client reads no API key of madarch's
   * knowing cannot be paid by one, so the auth choice returns to the agent's
   * own sign-in rather than leaving a checked choice the start route refuses.
   */
  const choose = (agent: 'claude' | 'codex' | 'omp'): void => {
    setChosen(agent);
    if (apiKeyVariable(rows.find((row) => row.agent === agent)) === undefined) setAuth('subscription');
  };
  // The key variable follows the agent, not whether its command is installed:
  // an agent whose command is missing still reads its own variable.
  const keyVariable = apiKeyVariable(rowFor(rows, chosen));
  const agentName = (agent: string): string => rows.find((row) => row.agent === agent)?.label ?? agent;

  if (runExists && !showWizard) {
    return (
      <section className="fill-wizard-settings">
        <p>{t('wizard.settings')}</p>
        <p>{t('wizard.chosen')} {chosen || t('wizard.choosePlaceholder')}</p>
        <p>{t('wizard.paysWith')} {auth === 'api-key' ? t('wizard.authApiKey') : t('wizard.authSubscription', { agent: chosen === '' ? t('wizard.choosePlaceholder') : agentName(chosen) })}</p>
        <button onClick={() => setShowWizard(true)}>{t('wizard.rerun')}</button>
      </section>
    );
  }
  return (
    <section className="fill-wizard" data-testid="fill-wizard">
      {!runExists && <p className="eyebrow">{t('wizard.stepCounter', { current: step })}</p>}
      <h1>{runExists ? t('wizard.settingsTitle') : t('wizard.title')}</h1>
      {!runExists && (
        <>
          <ol className="wizard-steps" aria-label={t('wizard.steps')}>
            <li aria-current={step === 1 ? 'step' : undefined}><button type="button" onClick={() => setStep(1)}><b>1</b> {t('wizard.stepWhat')}</button></li>
            <li aria-current={step === 2 ? 'step' : undefined}><button type="button" disabled={!reachable(2)} onClick={() => setStep(2)}><b>2</b> {t('wizard.stepAgent')}</button></li>
            <li aria-current={step === 3 ? 'step' : undefined}><button type="button" disabled={!reachable(3)} onClick={() => setStep(3)}><b>3</b> {t('wizard.stepInventory')}</button></li>
            <li aria-current={step === 4 ? 'step' : undefined}><button type="button" disabled={!reachable(4)} onClick={() => setStep(4)}><b>4</b> {t('wizard.stepStart')}</button></li>
          </ol>
          {step === 1 && (
            <div className="wizard-step">
              <h2>{t('wizard.stepWhat')}</h2>
              <p>{t('wizard.intro')}</p>
              <ul className="wizard-checklist">{['inventory', 'index', 'claims', 'code-map', 'synthesis', 'question-review'].map((stage) => <li key={stage}><span aria-hidden="true">□</span> {t(`fill.stages.${stage}`)}</li>)}</ul>
              <ul className="wizard-notes"><li>{t('wizard.readOnly')}</li><li>{t('wizard.branchWrites')}</li><li>{t('wizard.subscription')}</li><li>{t('wizard.limits')}</li><li>{t('wizard.spends')}</li></ul>
            </div>
          )}
          {step === 2 && (
            <div className="wizard-step">
              <h2>{t('wizard.stepAgent')}</h2>
              {rows.length === 0 || !rows.some((row) => row.selectable) ? (
                // No agent this machine can start: the note stands, and the
                // probe's rows stay under it — an adapter that is missing is
                // still the one a person installs from here.
                <div className="wizard-none" role="status">
                  <p><b>{t('wizard.noneTitle')}</b></p>
                  <p>{t('wizard.noneSupport')}</p>
                  <p>{t('wizard.noneInstall')}</p>
                </div>
              ) : null}
              {rows.length > 0 && (
                <fieldset>
                  <legend>{t('wizard.choose')}</legend>
                  {rows.map((row) => {
                    const offer = installOffered(row);
                    return (
                      <div className="wizard-agent" key={row.agent} data-agent={row.agent}>
                        <label>
                          <input type="radio" name="fill-agent" disabled={!row.selectable} checked={chosen === row.agent} onChange={() => choose(row.agent)} />
                          <b>{row.label}</b>{row.command?.available === true ? ` — ${row.command.version ?? ''}` : ` — ${row.command?.reason ?? t('wizard.notInstalledHere')}`}
                        </label>
                        <p className="wizard-adapter" data-status={row.adapter.status}>{t(adapterStateKey(row.adapter.status))}{row.adapter.agentInfo?.version === undefined ? '' : ` (${row.adapter.agentInfo.version})`}</p>
                        <p className="wizard-login" data-login={row.adapter.login.state}>{t(loginStateKey(row.adapter.login.state))}</p>
                        {offer !== undefined && (
                          <div className="wizard-install">
                            {declined.includes(row.adapter.id) ? (
                              // The person said no: nothing was installed, and
                              // the way to install it by hand stays on the row.
                              <p className="wizard-hint">{t('wizard.installDeclined', { command: offer.command })}</p>
                            ) : (
                              <>
                                <p>{offer.installedSize === undefined ? t('wizard.installOfferUnmeasured', { package: offer.package ?? '', version: offer.version ?? '' }) : t('wizard.installOffer', { package: offer.package ?? '', version: offer.version ?? '', size: offer.installedSize })}</p>
                                <button disabled={installing !== '' || busy} onClick={() => void doInstall(row.adapter.id)}>{installing === row.adapter.id ? t('wizard.installing') : t('wizard.install')}</button>
                                <button type="button" className="wizard-decline" onClick={() => setDeclined([...declined, row.adapter.id])}>{t('wizard.installNotNow')}</button>
                                <p className="wizard-hint">{t('wizard.installByHand', { command: offer.command })}</p>
                              </>
                            )}
                          </div>
                        )}
                        {row.command?.available === true && (
                          <>
                            <button disabled={busy} onClick={() => void doTest(row.agent)}>{t('wizard.test')}</button>
                            <span role="status">{results[row.agent]}</span>
                          </>
                        )}
                      </div>
                    );
                  })}
                </fieldset>
              )}
              <div className="wizard-auth">
                <p>{t('wizard.paysWith')}</p>
                <label><input type="radio" name="fill-auth" checked={auth !== 'api-key'} onChange={() => setAuth('subscription')} /> {t('wizard.authSubscription', { agent: chosen === '' ? t('wizard.choosePlaceholder') : agentName(chosen) })}</label>
                <label><input type="radio" name="fill-auth" disabled={keyVariable === undefined} checked={auth === 'api-key'} onChange={() => setAuth('api-key')} /> {t('wizard.authApiKey')}</label>
                  {auth === 'api-key' && keyVariable !== undefined && <p className="wizard-hint">{t('wizard.apiKeyFrom', { variable: keyVariable })}</p>}
                  {chosen !== '' && keyVariable === undefined && <p className="wizard-hint">{t('wizard.apiKeyNone')}</p>}
              </div>
              {chosen === 'omp' && (
                <>
                  <label className="wizard-model">{t('wizard.model')} <input type="text" value={ompModel} onChange={(event) => setOmpModel(event.target.value)} /></label>
                  <p className="wizard-hint">{t('wizard.modelHint')}</p>
                </>
              )}
            </div>
          )}
          {step === 3 && (
            <div className="wizard-step">
              <h2>{t('wizard.stepInventory')}</h2>
              <label>{t('wizard.maxUnits')} <input type="number" min={1} max={10000} value={maxUnits} onChange={(event) => setMaxUnits(Math.max(1, Number(event.target.value) || 1))} /></label>
              <p>{t('wizard.unitCap')}</p>
              <button className="wizard-run" disabled={busy} onClick={() => void inventoryNow()}>{t('wizard.inventory')}</button>
              {inventory !== null && (
                <div role="status">
                  <p>{t('wizard.inventoryCount', { count: inventory.files.length })} · {t('wizard.rough')}</p>
                  {inventory.declaredRepositoryCount > 1 && <p role="alert">{t('wizard.multipleRepos')}</p>}
                  <ul className="wizard-estimates">{inventory.estimates.map((estimate) => <li key={estimate.stage}><span>{t(`fill.stages.${estimate.stage}`)}</span><strong>{estimate.estimatedMs !== undefined && estimate.estimatedMs > 0 ? t('wizard.timeMinutes', { count: Math.max(1, Math.round(estimate.estimatedMs / 60000)) }) : t('wizard.timePending')}</strong></li>)}</ul>
                </div>
              )}
            </div>
          )}
          {step === 4 && (
            <div className="wizard-step">
              <h2>{t('wizard.stepStart')}</h2>
              <p>{t('wizard.readySummary', { agent: chosen === '' ? t('wizard.choosePlaceholder') : agentName(chosen), count: maxUnits })}</p>
              <p>{t('wizard.paysWith')} {auth === 'api-key' ? t('wizard.authApiKey') : t('wizard.authSubscription', { agent: chosen === '' ? t('wizard.choosePlaceholder') : agentName(chosen) })}</p>
              <button disabled={busy || chosen === '' || inventory === null || inventory.declaredRepositoryCount > 1} onClick={() => void start()}>{t('wizard.start')}</button>
            </div>
          )}
          <nav className="wizard-actions" aria-label={t('wizard.steps')}>
            <button type="button" disabled={step === 1} onClick={() => setStep(step - 1)}>{t('wizard.back')}</button>
            <button type="button" disabled={step === 4 || (step === 2 && chosen === '') || (step === 3 && inventory === null)} onClick={() => setStep(step + 1)}>{t('wizard.next')}</button>
          </nav>
        </>
      )}
      {runExists && (
        <>
          <p>{t('wizard.settings')}</p>
          {rows.length === 0 || !rows.some((row) => row.selectable) ? <p className="wizard-none" role="status">{t('wizard.noneTitle')}</p> : (
            <fieldset>
              <legend>{t('wizard.choose')}</legend>
              {rows.map((row) => <label className="wizard-agent" key={row.agent}><input type="radio" name="fill-agent" disabled={!row.selectable} checked={chosen === row.agent} onChange={() => choose(row.agent)} />{row.label}</label>)}
            </fieldset>
          )}
          <button disabled={chosen === '' || busy} onClick={() => void start()}>{t('wizard.rerun')}</button>
        </>
      )}
      {installed !== '' && <p role="status">{installed}</p>}
      {error !== '' && <p role="alert">{error}</p>}
    </section>
  );
}
