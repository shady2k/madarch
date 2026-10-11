/**
 * The SDLC stages view (docs/changes/wiki-sdlc/capabilities/product-wiki.md,
 * requirement `stages`): the stages navigator, one section per stage in the
 * life cycle's order — Idea, Requirements, Design, Build, Verify, Release,
 * Operate — each listing what the product holds there now, read from the
 * real files the skills write, with a link to the page that shows it whole.
 * A stage that holds nothing says which skill fills it, in a quiet missing
 * line; there is no dead control anywhere on the view: every link opens a
 * page the wiki serves, every shown artifact is one the index read.
 *
 * The tasks part of Build is read-only: the tracker's own export is the one
 * source, and nothing here writes, closes or edits a task. The sections
 * other features own — the Architecture section (the model's views) and the
 * Repositories section (the code repositories) — are linked, never built or
 * duplicated here.
 */
import { useEffect, useState, type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { CircleDashedIcon, CircleIcon, CircleCheckBigIcon, FlaskConicalIcon, ListTodoIcon } from 'lucide-react';
import { getStages, type StagesIndex, type TaskFeature, type StageSection } from './api.js';
import { PageLink } from './view.js';

/** Reads the stages once for the open wiki; the caller rerenders it on the wiki's revision. */
export function useStages(revision: string): StagesIndex | null {
  const [index, setIndex] = useState<StagesIndex | null>(null);
  useEffect(() => {
    let alive = true;
    const controller = new AbortController();
    getStages(controller.signal)
      .then((read) => {
        if (alive) setIndex(read);
      })
      .catch(() => {
        if (alive) setIndex(null);
      });
    return () => {
      alive = false;
      controller.abort();
    };
  }, [revision]);
  return index;
}

/** The address of one stage's page: the stage route, then the stage id. */
export function addressOfStage(id: string): string {
  return `/s/${encodeURIComponent(id)}`;
}

/** The status glyph a task row carries: open, in progress, or done. */
export function TaskStatusGlyph({ status }: { status: 'open' | 'in_progress' | 'done' }): ReactElement {
  if (status === 'done') return <CircleCheckBigIcon aria-hidden="true" className="size-4 shrink-0 text-muted" />;
  if (status === 'in_progress') return <CircleDashedIcon aria-hidden="true" className="size-4 shrink-0 text-muted" />;
  return <CircleIcon aria-hidden="true" className="size-4 shrink-0 text-muted" />;
}

/**
 * One stage's tasks grouped by feature: the feature's title (or its id when
 * the title is empty), its counts, then its tasks in id order — the shapes
 * the server's index already ordered. The tasks are read-only here.
 */
export function TaskGroups({ groups }: { groups: readonly TaskFeature[] }): ReactElement {
  const { t } = useTranslation();
  return (
    <div className="stage-tasks" data-testid="stage-tasks">
      <p className="stage-tasks-title">
        <ListTodoIcon aria-hidden="true" className="mr-1.5 inline size-4 align-[-2px] text-muted" />
        {t('stages.tasksTitle')}
      </p>
      {groups.map((feature) => (
        <div key={feature.id} className="stage-feature" data-stage-feature={feature.id}>
          <p className="stage-feature-head">
            <b className="stage-feature-name">{feature.title !== '' ? feature.title : feature.id}</b>
            <span className="stage-feature-counts">
              {t('stages.counts', {
                open: feature.open,
                inProgress: feature.inProgress,
                done: feature.done,
                openUnit: t('units.taskOpen', { count: feature.open }),
              })}
            </span>
          </p>
          <ul className="stage-task-rows">
            {feature.tasks.map((task) => (
              <li key={task.id} className="stage-task-row">
                <TaskStatusGlyph status={task.status} />
                <span className="stage-task-title">{task.title}</span>
                <span className="stage-task-id">{task.id}</span>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

/** The line an empty stage carries: which skill fills the stage, and for what. */
function MissingLines({ section }: { section: StageSection }): ReactElement | null {
  const { t } = useTranslation();
  if (section.missing.length === 0) return null;
  return (
    <div className="stage-missing" data-testid="stage-missing">
      {section.missing.map((entry) => (
        <p key={entry.kind} className="stage-missing-line">
          {t('stages.missingLine', { kind: t(`stages.kinds.${entry.kind}`, { defaultValue: entry.kind }), skill: entry.skill })}
        </p>
      ))}
    </div>
  );
}

/** The one stage's own page: every artifact a link, the tasks of Build, the linked sections, the missing lines. */
export function StagePage({ stage, index }: { stage: StageSection; index: StagesIndex }): ReactElement {
  const { t } = useTranslation();
  return (
    <main id="stage" data-stage={stage.id}>
      <p className="eyebrow">{t('stages.eyebrow')}</p>
      <h1 className="app-title">{t(`stages.names.${stage.id}`)}</h1>
      <p className="home-lead">{t(`stages.leads.${stage.id}`)}</p>
      {index.problems.length > 0 && (
        <div className="stage-problems" data-testid="stage-problems">
          {index.problems.map((problem) => (
            <p key={problem.where} className="stage-problem">
              {t('stages.problem', { where: problem.where, message: problem.message })}
            </p>
          ))}
        </div>
      )}
      {stage.sections?.map((link) =>
        link.kind === 'architecture' ? (
          <p key={link.kind} className="stage-section-link" data-testid="stage-section-architecture">
            <FlaskConicalIcon aria-hidden="true" className="mr-1.5 inline size-4 align-[-2px] text-muted" />
            {t('stages.architectureLink')}
          </p>
        ) : (
          <p key={link.kind} className="stage-section-link" data-testid="stage-section-repositories">
            <ListTodoIcon aria-hidden="true" className="mr-1.5 inline size-4 align-[-2px] text-muted" />
            {t('stages.repositoriesLink')}
          </p>
        ),
      )}
      {stage.artifacts.length > 0 && (
        <div className="home-groups">
          {stage.artifacts.map((artifact) => (
            <div key={artifact.path} className="home-group" data-stage-artifact={artifact.path}>
              <PageLink path={artifact.path} className="home-row">
                <span className="home-row-title">{artifact.title}</span>
                <span className="home-count">{t(`stages.kinds.${artifact.kind}`, { defaultValue: artifact.kind })}</span>
              </PageLink>
            </div>
          ))}
        </div>
      )}
      {stage.tasks !== undefined && stage.tasks.length > 0 && <TaskGroups groups={stage.tasks} />}
      {stage.tasks !== undefined && stage.tasks.length === 0 && stage.artifacts.length === 0 && (
        <p className="stage-missing-line">{t('stages.noTasks')}</p>
      )}
      <MissingLines section={stage} />
    </main>
  );
}
