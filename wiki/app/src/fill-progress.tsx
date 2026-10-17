import { useEffect, useMemo, useState, type ReactElement } from 'react';
import { appPath } from './app-base.js';
import { useTranslation } from 'react-i18next';

type FillStage = 'inventory' | 'index' | 'claims' | 'code-map' | 'synthesis' | 'question-review';
type Unit = { stage: FillStage; status: 'pending' | 'running' | 'complete' | 'blocked' | 'stale' };
type Run = { id: string; status: string; createdAt: string };
type Event = { stage: FillStage; unitId: string; at: string; type: string; summary: string };
const stages: FillStage[] = ['inventory', 'index', 'claims', 'code-map', 'synthesis', 'question-review'];
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
  const counts = useMemo(() => Object.fromEntries(stages.map((stage) => [stage, units.filter((unit) => unit.stage === stage).reduce((result, unit) => ({ ...result, [unit.status]: result[unit.status] + 1 }), { pending: 0, running: 0, complete: 0, blocked: 0, stale: 0 })])) as unknown as Record<FillStage, Record<string, number>>, [units]);
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
      <p className="fill-run-state">{t(`fill.status.${run.status}`, { defaultValue: run.status })} · {elapsed(run.createdAt, now)}</p>
      <ol className="fill-stages">{stages.map((stage) => <li key={stage} data-stage={stage}><span>{t(`fill.stages.${stage}`)}</span><small>{counts[stage].complete}/{units.filter((unit) => unit.stage === stage).length} · {counts[stage].running} {t('fill.running')}</small></li>)}</ol>
      <p className="fill-activity" aria-live="polite">{latest?.summary ?? t('fill.waiting')}</p>
      <div className="fill-controls"><button type="button" disabled={run.status !== 'running'} onClick={() => void control('pause')}>{t('fill.pause')}</button><button type="button" disabled={run.status === 'stopped' || run.status === 'complete'} onClick={() => void control('stop')}>{t('fill.stop')}</button></div>
      {error && <p role="alert">{error}</p>}
    </>}
  </aside>;
}
