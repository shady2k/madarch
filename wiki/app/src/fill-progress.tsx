import { useEffect, useMemo, useState, type ReactElement } from 'react';
import { appPath } from './app-base.js';
import { useTranslation } from 'react-i18next';

/**
 * One fill's progress, as the server answers it (`GET /api/fill`, madarch-tzte.26.2).
 *
 * The answer is one run: its state, the units it planned with their states, and
 * its durable progress events. A run written to the product's `.madarch/fill`
 * state and a run the orchestrator keeps in the server's own database have the
 * same shape, so this panel shows both — the update the background server starts
 * by itself after a commit to the default branch is one of the server's runs and
 * appears here the moment it is created.
 *
 * The stages are the answer's own, not a list fixed here: the fill's declared
 * stages are data (decision 0027), and a stage the panel does not know by name is
 * shown under its own id rather than hidden.
 */
type Unit = { stage: string; status: string };
type Run = { id: string; status: string; createdAt: string };
type Event = { stage: string; unitId: string; at: string; type: string; summary: string };

/** The order the fill's stages stand in, for the stages this panel knows: the orchestrator's own, then the landed pipeline's. */
const stageOrder = [
  'snapshot', 'inventory', 'build-configuration', 'syntax', 'semantic-resolution', 'modules', 'document-index', 'history', 'agent-unit',
  'index', 'claims', 'code-map', 'synthesis', 'question-review',
];
/** The run states a run never leaves: its stop is its own end, so the panel offers none. */
const terminalStates = new Set(['stopped', 'complete', 'succeeded', 'completed_partial', 'failed', 'cancelled', 'blocked']);
/** The unit states that mean a unit's work stands, and the ones that mean it is being worked on now. */
const doneStates = new Set(['complete', 'published']);
const workingStates = new Set(['running', 'leased', 'draft', 'validating']);

/** The stages the answer holds, in the panel's order, with a stage it does not know after them in code-point order. */
function stageListOf(units: readonly Unit[]): string[] {
  const held = [...new Set(units.map((unit) => unit.stage).filter((stage) => stage !== ''))];
  const known = stageOrder.filter((stage) => held.includes(stage));
  const unknown = held.filter((stage) => !stageOrder.includes(stage)).sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  return [...known, ...unknown];
}

function elapsed(start: string, now: number): string {
  const seconds = Math.max(0, Math.floor((now - Date.parse(start)) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}
/** Live reader for atomic fill state and journal; controls operate on the product server API. */
export function FillProgressPanel({ open }: { open: boolean }): ReactElement {
  const { t } = useTranslation();
  const [run, setRun] = useState<Run | null>(null);
  const [units, setUnits] = useState<Unit[]>([]);
  const [events, setEvents] = useState<Event[]>([]);
  const [now, setNow] = useState(Date.now());
  const [error, setError] = useState('');
  const refresh = async (): Promise<void> => {
    try {
      const response = await fetch(appPath('/api/fill'));
      if (!response.ok) { if (response.status === 404) { setRun(null); return; } throw new Error(`server answered ${response.status}`); }
      const data = await response.json() as { run?: Run; units?: Unit[]; events?: Event[] };
      setRun(data.run ?? null); setUnits(data.units ?? []); setEvents(data.events ?? []); setError('');
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
  };
  useEffect(() => { void refresh(); const timer = window.setInterval(() => { void refresh(); setNow(Date.now()); }, 5000); return () => window.clearInterval(timer); }, []);
  const stages = useMemo(() => stageListOf(units), [units]);
  const counts = useMemo(
    () => new Map(stages.map((stage) => {
      const of = units.filter((unit) => unit.stage === stage);
      return [stage, { done: of.filter((unit) => doneStates.has(unit.status)).length, working: of.filter((unit) => workingStates.has(unit.status)).length, total: of.length }];
    })),
    [stages, units],
  );
  const latest = events.at(-1);
  const control = async (action: 'pause' | 'stop'): Promise<void> => {
    if (!run) return;
    try {
      const response = await fetch(appPath(`/api/fill/control?runId=${encodeURIComponent(run.id)}&action=${action}`), { method: 'POST' });
      if (!response.ok) throw new Error(`server answered ${response.status}`);
      await refresh();
    } catch (caught) { setError(caught instanceof Error ? caught.message : String(caught)); }
  };
  return <aside className="context-panel fill-progress" aria-label={t('fill.title')} data-testid="fill-progress-panel" hidden={!open}>
    <h2>{t('fill.title')}</h2>
    {!run ? <p>{error || t('fill.idle')}</p> : <>
      <p className="fill-run-state" data-testid="fill-run-id">{t(`fill.status.${run.status}`, { defaultValue: run.status })} · {elapsed(run.createdAt, now)}</p>
      <ol className="fill-stages">{stages.map((stage) => <li key={stage} data-stage={stage}><span>{t(`fill.stages.${stage}`, { defaultValue: stage })}</span><small>{counts.get(stage)?.done ?? 0}/{counts.get(stage)?.total ?? 0} · {counts.get(stage)?.working ?? 0} {t('fill.running')}</small></li>)}</ol>
      <p className="fill-activity" aria-live="polite">{latest?.summary ?? t('fill.waiting')}</p>
      <div className="fill-controls"><button type="button" disabled={run.status !== 'running'} onClick={() => void control('pause')}>{t('fill.pause')}</button><button type="button" disabled={terminalStates.has(run.status)} onClick={() => void control('stop')}>{t('fill.stop')}</button></div>
      {error && <p role="alert">{error}</p>}
    </>}
  </aside>;
}
