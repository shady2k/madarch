/**
 * The loop that closes the wiki (decision 0029; madarch-m38l.7): the agent
 * asks what it could not settle, a person answers here, and the next refresh
 * edits the pages the answer touches. This file draws the three places the
 * loop shows: «Вопросы» (the questions and a question's page where a person
 * answers), «Проблемы» (corrections and what the engine found) and the refresh
 * plan (which pages the next refresh touches, and why, before the agent starts).
 * It holds no kind and no page of the product: it draws the rows the server
 * reads from the product's files.
 */
import { useEffect, useState, type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert.js';
import { Badge } from '@/components/ui/badge.js';
import { Button } from '@/components/ui/button.js';
import { addStarter, answerQuestion, closeTask, createTask, getProblems, getQuestion, getQuestions, getRefreshPlan, getScopeImpact, getTask, getTasks, proposeTask, runTask } from './api.js';
import { CodePlace, KLink, brokenWords } from './blocks.js';
import { addressOfEntity, addressOfQuestion, addressOfStatement, addressOfTask, K_QUESTIONS, K_TASKS } from './routes.js';
import { useRead } from './live.js';
import { useTabTitle } from './tabs.js';
import { PageSkeleton } from './skeleton.js';
import type { Author, PlaceView, Problem, QuestionDetail, StarterOffer, QuestionRow, QuestionState, RefreshPlan, RefreshPreview, Resolution, TaskDetail, TaskImpact, TaskProposal, TaskScope } from './types.js';

const message = (failure: unknown): string => (failure instanceof Error ? failure.message : String(failure));

/** The title of a page by its id, for a link: `domain:payments` reads as its slug until the page is named. */
const shortId = (id: string): string => id.slice(id.indexOf(':') + 1);

function whenWords(iso: string | null, language: string): string {
  if (iso === null) return '';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString(language, { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'UTC' }) + ' UTC';
}

const useLanguage = (): string => {
  const { i18n } = useTranslation();
  return (i18n.resolvedLanguage ?? 'en').startsWith('ru') ? 'ru' : 'en';
};

/** A target the question or problem names, as a link when it resolves and as its reason when it does not. */
function Target({ target, resolutions }: { target: string; resolutions: Record<string, Resolution> }): ReactElement {
  const { t } = useTranslation();
  const resolution = resolutions[target];
  if (resolution === undefined) return <code className="text-small">{target}</code>;
  if (resolution.state === 'broken') return <span className="ref-broken" title={brokenWords(resolution, t)} data-testid="ref-broken">{target}<span className="ref-broken-mark">{t('knowledge.broken')}</span></span>;
  if (resolution.location !== undefined) return <CodePlace location={resolution.location} />;
  if (resolution.href !== null) return <KLink href={resolution.href}>{resolution.label}</KLink>;
  return <span>{resolution.label}</span>;
}

function AuthorLine({ by, at }: { by: Author; at: string | null }): ReactElement {
  const { t } = useTranslation();
  const language = useLanguage();
  return (
    <span className="text-small text-muted" data-testid="author-line">
      {t('loop.by', { name: by.name, email: by.email })}{at !== null && `, ${whenWords(at, language)}`}
      {' · '}
      <span data-testid="verified-mark" title={t('loop.verifiedHint')}>{t('loop.localUnverified')}</span>
    </span>
  );
}

const STATE_KEY: Record<QuestionState, string> = { open: 'loop.stateOpen', answered: 'loop.stateAnswered', closed: 'loop.stateClosed' };

function QuestionItem({ row }: { row: QuestionRow }): ReactElement {
  const { t } = useTranslation();
  return (
    <li className="border-b border-line py-3 last:border-b-0" data-testid="question-row" data-question={row.slug} data-state={row.state}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <KLink href={addressOfQuestion(row.slug)} className="font-medium">{row.title}</KLink>
        <Badge>{t(`loop.type.${row.type}`)}</Badge>
        <Badge variant={row.state === 'open' ? 'solid' : 'outline'}>{t(STATE_KEY[row.state])}</Badge>
      </div>
      <div className="mt-1 text-small text-muted">
        {row.askedIn !== null && <span>{t('loop.askedIn')} <KLink href={addressOfEntity(row.askedIn)}>{shortId(row.askedIn)}</KLink></span>}
        {row.state === 'closed' && row.closedBy.length > 0 && <span> · {t('loop.closedBy')} {row.closedBy.map((id, index) => <span key={id}>{index > 0 && ', '}<KLink href={addressOfEntity(id)}>{shortId(id)}</KLink></span>)}</span>}
        {row.state === 'answered' && <span> · {t('loop.waitsForRefresh')}</span>}
      </div>
    </li>
  );
}

/** «Вопросы»: the questions the agent asked, open first. */
export function QuestionsPage({ version }: { version: number }): ReactElement {
  const { t } = useTranslation();
  const { data, error } = useRead('questions', version, (signal) => getQuestions(signal));
  useTabTitle(t('loop.questionsTitle'));
  if (data === null && error === null) return <PageSkeleton testId="questions-loading" rows />;
  if (data === null) {
    return <Alert variant="problem" data-testid="questions-error"><AlertTitle>{t('loop.questionsMissing')}</AlertTitle><AlertDescription><p>{error}</p></AlertDescription></Alert>;
  }
  const groups: { state: QuestionState; heading: string }[] = [
    { state: 'open', heading: t('loop.openHeading', { count: data.open }) },
    { state: 'answered', heading: t('loop.answeredHeading', { count: data.answered }) },
    { state: 'closed', heading: t('loop.closedHeading', { count: data.closed }) },
  ];
  return (
    <section data-testid="questions-page">
      <header className="mb-6">
        <h1>{t('loop.questionsTitle')}</h1>
        <p className="text-secondary" data-testid="questions-intro">{t('loop.questionsIntro')}</p>
      </header>
      {data.problems.length > 0 && (
        <Alert variant="problem" className="mb-6" data-testid="questions-files">
          <AlertTitle>{t('loop.unreadableFiles')}</AlertTitle>
          <AlertDescription><ul className="m-0 list-none p-0">{data.problems.map((line) => <li key={line}><code>{line}</code></li>)}</ul></AlertDescription>
        </Alert>
      )}
      {data.rows.length === 0 && <p className="text-muted" data-testid="questions-empty">{t('loop.noQuestions')}</p>}
      {groups.map((group) => {
        const rows = data.rows.filter((row) => row.state === group.state);
        if (rows.length === 0) return null;
        return (
          <section key={group.state} className="mb-8" data-testid="questions-group" data-state={group.state}>
            <h2>{group.heading}</h2>
            <ul className="m-0 list-none p-0">{rows.map((row) => <QuestionItem key={row.slug} row={row} />)}</ul>
          </section>
        );
      })}
    </section>
  );
}

function AnswerForm({ question, onSaved }: { question: QuestionDetail; onSaved: (note: string | null) => void }): ReactElement {
  const { t } = useTranslation();
  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  const save = (): void => {
    setSaving(true);
    setRefused(null);
    answerQuestion(question.slug, text).then(
      (result) => { setSaving(false); const told = result.committed ? null : (result.note ?? t('loop.notCommitted')); onSaved(told); },
      (failure: unknown) => { setSaving(false); setRefused(message(failure)); },
    );
  };
  return (
    <form className="mt-2 grid gap-3" data-testid="answer-form" onSubmit={(event) => { event.preventDefault(); if (text.trim() !== '' && !saving) save(); }}>
      <label className="grid gap-1.5">
        <span className="text-small font-medium text-ink">{t('loop.yourAnswer')}</span>
        <textarea
          value={text}
          onChange={(event) => setText(event.target.value)}
          rows={5}
          placeholder={t('loop.answerPlaceholder')}
          data-testid="answer-text"
          className="ui-input w-full rounded-[var(--radius-control)] border border-line bg-page px-3 py-2 text-small text-ink outline-none placeholder:text-muted focus-visible:ring-2 focus-visible:ring-ink focus-visible:ring-offset-2 focus-visible:ring-offset-page"
        />
      </label>
      <p className="m-0 text-small text-muted" data-testid="answer-where">{t('loop.answerWhere', { file: question.file })}</p>
      <div className="flex flex-wrap gap-2"><Button variant="default" size="default" type="submit" disabled={saving || text.trim() === ''} data-testid="answer-save">{t('loop.saveAnswer')}</Button></div>
      {refused !== null && <p className="m-0 text-small" role="alert" data-testid="answer-refused">{refused}</p>}
    </form>
  );
}

/** One question: both sides with their grounds, and where a person answers. */
export function QuestionPage({ slug, version, refresh }: { slug: string; version: number; refresh: () => void }): ReactElement {
  const { t } = useTranslation();
  // What the form says of a save that was not committed outlives the form, which goes when the answer shows.
  const [commitNote, setCommitNote] = useState<string | null>(null);
  const language = useLanguage();
  const { data: question, error } = useRead<QuestionDetail>(`question:${slug}`, version, (signal) => getQuestion(slug, signal));
  // The tasks this question's answer became: the reader confirms one, and then fixes the pages it reaches.
  const { data: tasks } = useRead('tasks', version, (signal) => getTasks(signal));
  useTabTitle(question?.title ?? (error !== null ? t('loop.noSuchQuestion') : null));
  if (question === null && error === null) return <PageSkeleton testId="question-loading" />;
  if (question === null) {
    return <Alert variant="problem" data-testid="question-error"><AlertTitle>{t('loop.noSuchQuestion')}</AlertTitle><AlertDescription><p>{error}</p></AlertDescription></Alert>;
  }
  const affected = [...new Set(question.about.map((entry) => entry.split('#')[0]!).filter((entry) => /^(product|domain):/.test(entry)))];
  const mine = (tasks?.tasks ?? []).filter((row) => row.question === `question:${question.slug}`);
  return (
    <article data-testid="question-page" data-question={question.slug} data-state={question.state}>
      <header className="mb-6">
        <nav aria-label="trail" className="mb-2 flex flex-wrap items-center gap-x-2 text-small text-muted"><KLink href={K_QUESTIONS}>{t('loop.questionsTitle')}</KLink></nav>
        <div className="mb-2 flex items-center gap-2">
          <Badge>{t(`loop.type.${question.type}`)}</Badge>
          <Badge variant={question.state === 'open' ? 'solid' : 'outline'} data-testid="question-state">{t(STATE_KEY[question.state])}</Badge>
        </div>
        <h1 data-testid="question-title">{question.title}</h1>
        {question.askedIn !== null && <p className="m-0 text-small text-muted">{t('loop.askedBy', { when: whenWords(question.askedAt, language) })} <KLink href={addressOfEntity(question.askedIn)}>{shortId(question.askedIn)}</KLink></p>}
      </header>
      <section className="mb-6">
        <p className="text-body" data-testid="question-text">{question.question}</p>
        <h2>{t('loop.whyItMatters')}</h2>
        <p className="text-secondary" data-testid="question-why">{question.why}</p>
      </section>
      <section className="mb-8" data-testid="question-sides">
        <h2>{t('loop.whatSourcesSay')}</h2>
        <ul className="m-0 grid min-w-0 list-none gap-3 p-0 [overflow-wrap:anywhere]">
          {question.sides.map((side, index) => (
            <li key={index} className="min-w-0 rounded-[var(--radius-card)] border border-line p-3" data-testid="question-side">
              <p className="m-0 text-body">{side.claim}</p>
              <p className="m-0 mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-small text-muted">
                <span>{t('loop.grounds')}</span>
                {side.grounds.map((ground) => <Target key={ground} target={ground} resolutions={question.resolutions} />)}
              </p>
            </li>
          ))}
        </ul>
      </section>
      {affected.length > 0 && (
        <p className="mb-8 text-small text-muted" data-testid="question-affects">{t('loop.affects')} {affected.map((id, index) => <span key={id}>{index > 0 && ', '}<KLink href={addressOfEntity(id)}>{shortId(id)}</KLink></span>)}</p>
      )}
      {commitNote !== null && <Alert variant="problem" className="mb-6" data-testid="answer-note"><AlertDescription><p>{commitNote}</p></AlertDescription></Alert>}
      {question.state === 'open' && (
        <section data-testid="question-answer-section">
          <h2>{t('loop.answerHeading')}</h2>
          <AnswerForm question={question} onSaved={(note) => { setCommitNote(note); refresh(); }} />
        </section>
      )}
      {question.answer !== null && (
        <section data-testid="question-answer">
          <h2>{t('loop.answerHeading')}</h2>
          <blockquote className="m-0 whitespace-pre-wrap rounded-[var(--radius-card)] border border-line bg-[var(--surface-soft)] p-3 text-body" data-testid="answer-quote">{question.answer.text}</blockquote>
          <p className="mb-0 mt-2"><AuthorLine by={question.answer.by} at={question.answer.at} /></p>
          {question.state === 'answered' && <Alert className="mt-4" data-testid="answer-waiting"><AlertDescription><p>{t('loop.answerWaiting')}</p></AlertDescription></Alert>}
          {question.state === 'closed' && (
            <Alert className="mt-4" data-testid="answer-closed">
              <AlertDescription><p>{t('loop.answerClosed', { when: whenWords(question.resolvedAt, language) })} {question.closedBy.map((id, index) => <span key={id}>{index > 0 && ', '}<KLink href={addressOfEntity(id)}>{shortId(id)}</KLink></span>)}</p></AlertDescription>
            </Alert>
          )}
        </section>
      )}
      {question.answer !== null && mine.length > 0 && mine.map((task) => <TaskCard key={task.id} id={task.id} version={version} refresh={refresh} />)}
      {question.answer !== null && mine.length === 0 && <ProposeTaskForm question={question} refresh={refresh} />}
    </article>
  );
}

// ---- problems ---------------------------------------------------------------------------------

function ProblemItem({ problem }: { problem: Problem }): ReactElement {
  const { t } = useTranslation();
  const where = problem.page === null ? null : <KLink href={addressOfEntity(problem.page)}>{problem.pageTitle ?? shortId(problem.page)}</KLink>;
  const missingGroup = /^kind "([^"]+)": "group" names a group of "groups" (?:\([^)]*\)|.*?), got "([^"]+)"$/.exec(problem.reason);
  const readerReason = missingGroup === null ? problem.reason : t('knowledge.manifestMissingGroup', {
    kind: t(`knowledge.manifestKinds.${missingGroup[1]}`, { defaultValue: missingGroup[1] }), group: missingGroup[2],
  });
  return (
    <li className="border-b border-line py-3 last:border-b-0" data-testid="problem-row" data-kind={problem.kind} data-closed={problem.closed ? 'true' : 'false'}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="font-medium">{t(`loop.problem.${problem.kind}`)}</span>
        <Badge variant={problem.fixer === 'agent' ? 'outline' : 'solid'} data-testid="problem-fixer">{t(`loop.fixer.${problem.fixer}`)}</Badge>
        {problem.closed && <Badge>{t('loop.stateClosed')}</Badge>}
      </div>
      {problem.sentence !== null && <p className="mb-0 mt-1.5 text-secondary" data-testid="problem-sentence">«{problem.sentence}»</p>}
      <p className="mb-0 mt-1 text-small">{t(`loop.because.${problem.kind}`)} <span data-testid="problem-reason">{readerReason}</span></p>
      {missingGroup !== null && <details className="mt-1 text-small text-muted" data-testid="problem-details"><summary className="cursor-pointer underline">{t('knowledge.findingsDetails')}</summary><code>{problem.reason}</code></details>}
      <p className="mb-0 mt-1 text-small text-muted">
        {where !== null && <span>{t('loop.onPage')} {where} · </span>}
        <code>{problem.file}{problem.line === null ? '' : `:${problem.line}`}</code>
        {problem.source !== undefined && <> · <code data-testid="problem-source">{problem.source}</code></>}
        {problem.by !== null && <span> · <AuthorLine by={problem.by} at={problem.at} /></span>}
      </p>
      <p className="mb-0 mt-1 text-small text-muted" data-testid="problem-who">{problem.closed ? t('loop.fixedNote') : t(`loop.whoFixes.${problem.kind}`)}</p>
    </li>
  );
}

/** What the starter set holds and the product's own (edited) manifest lacks, each added on a press (madarch-m38l.11). */
export function StarterOffers({ offers, refresh }: { offers: readonly StarterOffer[]; refresh: () => void }): ReactElement | null {
  const { t } = useTranslation();
  const language = useLanguage();
  const [working, setWorking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  if (offers.length === 0) return null;
  const add = (ids: string[], key: string): void => {
    setWorking(key);
    setError(null);
    addStarter(ids).then(() => { setWorking(null); refresh(); }, (failure: unknown) => { setWorking(null); setError(message(failure)); });
  };
  const nameOf = (offer: StarterOffer): string => {
    const label = offer.labels?.[language as 'en' | 'ru'];
    switch (offer.type) {
      case 'kind': return t('loop.starter.kind', { name: label ?? offer.name, key: offer.name });
      case 'fields': return t('loop.starter.fields', { name: label ?? offer.name, key: offer.name, fields: (offer.fields ?? []).join(', ') });
      case 'group': return t('loop.starter.group', { name: label ?? offer.name });
      case 'roles': return t('loop.starter.roles');
      case 'role': return t('loop.starter.role', { name: t(`knowledge.roles.names.${offer.name}`, { defaultValue: offer.name }) });
      case 'documents': return t('loop.starter.documents');
    }
  };
  const grouped = new Map<string, StarterOffer[]>();
  for (const offer of offers) {
    const group = offer.group ?? (offer.type === 'group' ? offer.name : 'product');
    const entries = grouped.get(group) ?? [];
    entries.push(offer);
    grouped.set(group, entries);
  }
  const groupOrder = ['code', 'contracts', 'data', 'operations', 'tests', 'history', 'product'];
  const groupRank = (group: string): number => { const rank = groupOrder.indexOf(group); return rank < 0 ? groupOrder.length : rank; };
  const groupLabel = (group: string): string => t(`loop.starter.groups.${group}`, { defaultValue: group });
  return (
    <section className="mb-8" data-testid="problems-starter">
      <h2>{t('loop.starter.summary', { count: offers.length })}</h2>
      <p className="mb-3 flex flex-wrap items-center gap-3">
        <Button variant="default" size="default" disabled={working !== null} onClick={() => add(offers.map((offer) => offer.id), '*')} data-testid="starter-add-all">{t('loop.starter.addAll')}</Button>
        <button type="button" className="cursor-pointer bg-transparent p-0 text-left text-secondary underline" aria-expanded={expanded} onClick={() => setExpanded(!expanded)} data-testid="starter-toggle">{expanded ? t('loop.starter.hideItems') : t('loop.starter.showItems')}</button>
      </p>
      {expanded && <div data-testid="starter-items">{[...grouped.keys()].sort((a, b) => groupRank(a) - groupRank(b)).map((group) => (
        <section key={group} className="mb-4" data-testid="starter-group" data-group={group}>
          <h3 className="mb-1 text-base font-semibold">{groupLabel(group)}</h3>
          <ul className="m-0 list-none p-0">{grouped.get(group)!.map((offer) => (
            <li key={offer.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line py-2.5 last:border-b-0" data-testid="starter-offer" data-offer={offer.id}>
              <span className="min-w-0 flex-1"><span className="block font-medium">{nameOf(offer)}</span>{offer.description !== undefined && <span className="block text-small text-muted">{offer.description[language as 'en' | 'ru']}</span>}</span>
              <Button variant="default" size="default" disabled={working !== null} onClick={() => add([offer.id], offer.id)} data-testid="starter-add">{t('loop.starter.add')}</Button>
            </li>
          ))}</ul>
        </section>
      ))}</div>}
      {error !== null && <p className="mb-0 mt-3 text-small" role="alert" data-testid="starter-error">{error}</p>}
    </section>
  );
}

/** «Проблемы»: corrections people made and what the engine found, each with who fixes it. */
export function ProblemsPage({ version, refresh = () => undefined }: { version: number; refresh?: () => void }): ReactElement {
  const { t } = useTranslation();
  const { data, error } = useRead('problems', version, (signal) => getProblems(signal));
  useTabTitle(t('loop.problemsTitle'));
  if (data === null && error === null) return <PageSkeleton testId="problems-loading" rows />;
  if (data === null) {
    return <Alert variant="problem" data-testid="problems-error"><AlertTitle>{t('loop.problemsMissing')}</AlertTitle><AlertDescription><p>{error}</p></AlertDescription></Alert>;
  }
  const open = data.problems.filter((problem) => !problem.closed);
  const closed = data.problems.filter((problem) => problem.closed);
  return (
    <section data-testid="problems-page">
      <header className="mb-6">
        <h1>{t('loop.problemsTitle')}</h1>
        <p className="text-secondary" data-testid="problems-intro">{t('loop.problemsIntro')}</p>
      </header>
      {data.notes.map((note) => <Alert key={note} className="mb-4" data-testid="problems-note"><AlertDescription><p>{note}</p></AlertDescription></Alert>)}
      <StarterOffers offers={data.starter ?? []} refresh={refresh} />
      {data.problems.length === 0 && (data.starter ?? []).length === 0 && <p className="text-muted" data-testid="problems-empty">{t('loop.noProblems')}</p>}
      {open.length > 0 && (
        <section className="mb-8" data-testid="problems-open">
          <h2>{t('loop.openProblems', { count: open.length })}</h2>
          <ul className="m-0 list-none p-0">{open.map((problem, index) => <ProblemItem key={`${problem.kind}:${problem.file}:${problem.line ?? ''}:${problem.target ?? ''}:${index}`} problem={problem} />)}</ul>
        </section>
      )}
      {closed.length > 0 && (
        <section className="mb-8" data-testid="problems-closed">
          <h2>{t('loop.closedProblems', { count: closed.length })}</h2>
          <ul className="m-0 list-none p-0">{closed.map((problem, index) => <ProblemItem key={`${problem.kind}:${problem.file}:${index}`} problem={problem} />)}</ul>
        </section>
      )}
    </section>
  );
}

// ---- the refresh plan -------------------------------------------------------------------------

function ReasonText({ reason }: { reason: RefreshPlan['pages'][number]['reasons'][number] }): ReactElement {
  const { t } = useTranslation();
  switch (reason.kind) {
    case 'missing': return <>{t('loop.reason.missing')}</>;
    case 'language': return <>{t('loop.reason.language', { from: reason.from ?? '?', to: reason.to })}</>;
    case 'ground-changed': return <>{t('loop.reason.groundChanged', { ground: reason.ground, statement: reason.statement })}</>;
    case 'ground-removed': return <>{t('loop.reason.groundRemoved', { ground: reason.ground, statement: reason.statement })}</>;
    case 'answer': return <>{t('loop.reason.answer', { title: reason.title })}</>;
    case 'correction': return <>{t('loop.reason.correction', { statement: reason.statement.slice(reason.statement.indexOf('#') + 1) })}</>;
    case 'new-service': return <>{t('loop.reason.newService', { services: reason.services.join(', ') })}</>;
    case 'missing-domain': return <>{t('loop.reason.missingDomain', { domain: reason.domain })}</>;
    case 'task': return <>{t('loop.reasonTask', { title: reason.title })}</>;
  }
}

/** The pages a refresh touches and why, and how many it leaves alone. */
export function PlanList({ plan, compact = false }: { plan: RefreshPlan; compact?: boolean }): ReactElement {
  const { t } = useTranslation();
  return (
    <div data-testid="refresh-plan">
      {plan.pages.length === 0
        ? <p className="m-0 text-small" data-testid="plan-nothing">{t('loop.plan.nothing')}</p>
        : <p className="mb-2 mt-0 text-small font-medium text-ink" data-testid="plan-summary">{t('loop.plan.touches', { count: plan.pages.length })}{plan.unchanged.length > 0 && <span className="font-normal text-muted"> {t('loop.plan.leaves', { count: plan.unchanged.length })}</span>}</p>}
      <ul className="m-0 list-none p-0 text-small" data-testid="plan-pages">
        {plan.pages.map((page) => (
          <li key={page.path} className="border-b border-line py-1.5 last:border-b-0" data-testid="plan-page" data-path={page.path}>
            <code>{page.path}</code>
            <ul className={`m-0 list-disc ps-5 text-secondary ${compact ? 'mt-0.5' : 'mt-1'}`}>
              {page.reasons.map((reason, index) => <li key={index} data-testid="plan-reason" data-kind={reason.kind}><ReasonText reason={reason} /></li>)}
            </ul>
          </li>
        ))}
      </ul>
      {plan.unplaced.map((miss) => <p key={`${miss.kind}:${miss.slug}`} className="mb-0 mt-2 text-small" role="alert" data-testid="plan-unplaced">{t('loop.plan.unplaced', { title: miss.title })} {miss.reason}</p>)}
      {plan.problems.map((line) => <p key={line} className="mb-0 mt-2 text-small" role="alert" data-testid="plan-problem"><code>{line}</code></p>)}
    </div>
  );
}

/** What the next refresh would do, read when the menu opens: before the press, not after. */
export function RefreshPreviewView({ language, refreshKey }: { language: string; refreshKey: string }): ReactElement {
  const { t } = useTranslation();
  const [preview, setPreview] = useState<RefreshPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    setError(null);
    getRefreshPlan(language, controller.signal).then(setPreview, (failure: unknown) => { if (!controller.signal.aborted) setError(message(failure)); });
    return () => controller.abort();
  }, [language, refreshKey]);
  if (error !== null) return <p className="m-0 text-small" role="alert" data-testid="plan-error">{error}</p>;
  if (preview === null) return <p className="m-0 text-small text-muted" data-testid="plan-loading">{t('loop.plan.reading')}</p>;
  if (!preview.available) return <p className="m-0 text-small text-muted" data-testid="plan-unavailable">{preview.reason}</p>;
  return (
    <div data-testid="refresh-preview">
      <div className="mb-1 text-small font-medium text-ink">{t('loop.plan.title')}</div>
      <PlanList plan={preview.plan} compact />
      {preview.commitsNotRead !== null && preview.commitsNotRead > 0 && <p className="mb-0 mt-2 text-small text-muted" data-testid="plan-commits">{t('loop.plan.commits', { count: preview.commitsNotRead })}</p>}
    </div>
  );
}

// ---- the scoped tasks of answers (madarch-m38l.14) -------------------------------------------

/** A scope as a reader says it: `README.md#what-it-does`, `src/a.ts:12-20`, a code symbol's graph key, a statement's, or a path. */
export function scopeWords(scope: TaskScope): string {
  switch (scope.type) {
    case 'section': return `${scope.path}#${scope.anchor}`;
    case 'lines': return `${scope.path}:${scope.start}-${scope.end}`;
    case 'file': return scope.path;
    case 'symbol': return scope.key.startsWith('code.symbol:') ? scope.key : `code.symbol:${scope.key}`;
    case 'statement': return scope.key;
  }
}

const SYMBOL_KEY = /^code\.symbol:/;
const LINES_WORDS = /^(.+):(\d+)-(\d+)$/;
const STATEMENT_KEY = /^(?:product|domain):[a-z][a-z0-9-]*#[^#]+$/;

/**
 * The scope a person typed: a path (a whole file), `path#section`, `path:12-20`, a statement of a page, or a code symbol.
 * Words that name no place of the product are refused with the words themselves, never guessed at.
 */
export function scopeOfWords(words: string): TaskScope | undefined {
  const text = words.trim();
  if (text === '') return undefined;
  const lines = LINES_WORDS.exec(text);
  if (lines !== null && Number(lines[2]) > 0 && Number(lines[3]) >= Number(lines[2])) return { type: 'lines', path: lines[1]!, start: Number(lines[2]), end: Number(lines[3]) };
  if (SYMBOL_KEY.test(text)) return { type: 'symbol', key: text };
  if (STATEMENT_KEY.test(text)) return { type: 'statement', key: text };
  const hash = text.indexOf('#');
  if (hash > 0) return hash === text.length - 1 ? undefined : { type: 'section', path: text.slice(0, hash), anchor: text.slice(hash + 1).toLowerCase() };
  if (text.includes(' ')) return undefined;
  return { type: 'file', path: text };
}

/** A place a task changes, as a reader says it: the heading and its document's title, each a link; the path is small. */
export function PlaceName({ place }: { place: PlaceView }): ReactElement {
  const { t } = useTranslation();
  const label = place.href === null ? <span>{place.label}</span> : <KLink href={place.href}>{place.label}</KLink>;
  return (
    <span className="place" data-testid="place" data-kind={place.kind} title={place.words}>
      {label}
      {place.where !== null && place.where !== place.label && <span className="text-muted"> — {place.where}</span>}
      {place.path !== null && place.path !== place.label && place.kind !== 'section' && <code className="ms-2 text-muted">{place.path}</code>}
      {place.kind === 'section' && place.path !== null && <code className="ms-2 text-muted" data-testid="place-path">{place.path}</code>}
    </span>
  );
}

/** What a change reaches, computed through the graph: every page and statement, before anything runs. */
function ImpactList({ impact }: { impact: TaskImpact }): ReactElement {
  const { t } = useTranslation();
  return (
    <div className="mt-2" data-testid="task-impact-list">
      <p className="m-0 text-small font-medium text-ink" data-testid="impact-counts">{t('loop.taskImpactSummary', { pages: impact.counts.pages, statements: impact.counts.statements })}</p>
      {impact.pages.length === 0 && impact.statements.length === 0 && <p className="m-0 mt-1 text-small text-muted" data-testid="impact-none">{t('loop.taskImpactNone')}</p>}
      {impact.unindexed.length > 0 && <p className="m-0 mt-1 text-small text-muted" role="status" data-testid="impact-unindexed" title={impact.unindexed.join(', ')}>{t('loop.taskImpactUnindexed', { count: impact.unindexed.length })}</p>}
      {impact.pages.length > 0 && (
        <section className="mt-2" data-testid="impact-pages">
          <h4 className="mb-1 text-small font-semibold">{t('loop.taskImpactPages')}</h4>
          <ul className="m-0 list-none p-0 text-small">
            {impact.pages.map((page) => (
              <li key={page.id} className="flex flex-wrap items-center gap-x-2 py-0.5" data-testid="impact-page" data-id={page.id} data-because={page.because}>
                <KLink href={addressOfEntity(page.id)}>{page.title}</KLink>
                <code className="text-muted">{page.file}</code>
                {page.because === 'link' && <span className="text-muted">· {t('loop.taskImpactLinked')}</span>}
              </li>
            ))}
          </ul>
        </section>
      )}
      {impact.statements.length > 0 && (
        <section className="mt-2" data-testid="impact-statements">
          <h4 className="mb-1 text-small font-semibold">{t('loop.taskImpactStatements')}</h4>
          <ul className="m-0 list-none p-0 text-small">
            {impact.statements.map((statement) => (
              <li key={`${statement.page}#${statement.statement}`} className="py-0.5" data-testid="impact-statement" data-page={statement.page} data-statement={statement.statement}>
                <KLink href={addressOfStatement(statement.page, statement.text)}>«{statement.text}»</KLink>
                <span className="ms-2 text-muted">{statement.pageTitle}</span>
                <code className="ms-2 text-muted" title={statement.grounds.join(', ')}>{statement.file}:{statement.line}</code>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

/**
 * The task an answer proposes: the reader chooses what needs to change, and the engine turns the answer's grounds into
 * an editable scope and the impact through the graph. Nothing is written before the reader confirms.
 */
export function ProposeTaskForm({ question, refresh }: { question: QuestionDetail; refresh: () => void }): ReactElement {
  const { t } = useTranslation();
  const [choice, setChoice] = useState<'code' | 'docs' | 'other'>('code');
  const [proposal, setProposal] = useState<TaskProposal | null>(null);
  const [title, setTitle] = useState('');
  const [scope, setScope] = useState<TaskScope[]>([]);
  // The impact the reader sees is read again from the scope as they edit it: what they confirm is what runs.
  const [impact, setImpact] = useState<TaskImpact | null>(null);
  const [adding, setAdding] = useState('');
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  // The places the server worded, by the scope itself: a reader's edit keeps the places of what they did not change.
  const places = new Map((proposal?.scope ?? []).map((one, index) => [JSON.stringify(one), proposal?.places?.[index]]));
  const language = useLanguage();
  const propose = (): void => {
    if (choice === 'other') return;
    setBusy(true); setRefused(null);
    proposeTask(question.slug, choice, language).then(
      (answered) => { setBusy(false); setProposal(answered); setTitle(answered.title); setScope(answered.scope); setImpact(answered.impact); },
      (failure: unknown) => { setBusy(false); setRefused(message(failure)); },
    );
  };
  const withScope = (next: TaskScope[]): void => {
    setScope(next);
    setRefused(null);
    if (next.length === 0) { setImpact(null); return; }
    getScopeImpact(next).then(setImpact, (failure: unknown) => { setImpact(null); setRefused(message(failure)); });
  };
  const add = (): void => {
    const parsed = scopeOfWords(adding);
    if (parsed === undefined) { setRefused(t('loop.taskScopeWrong', { place: adding })); return; }
    setAdding('');
    withScope([...scope.filter((one) => JSON.stringify(one) !== JSON.stringify(parsed)), parsed]);
  };
  const confirm = (): void => {
    if (proposal === null) return;
    if (scope.length === 0) { setRefused(t('loop.taskScopeEmpty')); return; }
    setBusy(true); setRefused(null);
    createTask({ question: question.slug, title, grounds: [...proposal.grounds], scope }).then(
      () => { setBusy(false); refresh(); },
      (failure: unknown) => { setBusy(false); setRefused(message(failure)); },
    );
  };
  return (
    <section className="mt-6" data-testid="task-proposal">
      <h2>{t('loop.taskChoice')}</h2>
      <div role="radiogroup" aria-label={t('loop.taskChoice')} className="grid gap-2" data-testid="task-choice">
        {([['code', t('loop.taskDocsWrong')], ['docs', t('loop.taskCodeWrong')], ['other', t('loop.taskOther')]] as const).map(([value, label]) => (
          <label key={value} className="flex cursor-pointer items-center gap-2 text-small">
            <input type="radio" name="task-choice" value={value} checked={choice === value} onChange={() => setChoice(value)} data-testid={`task-choice-${value}`} />
            <span>{label}</span>
          </label>
        ))}
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button variant="default" size="default" type="button" disabled={busy || choice === 'other'} onClick={propose} data-testid="task-propose">{t('loop.taskPropose')}</Button>
      </div>
      {proposal !== null && (
        <section className="mt-4 rounded-[var(--radius-card)] border border-line p-3" data-testid="task-proposed">
          <label className="grid gap-1">
            <span className="text-small font-medium text-ink">{t('loop.taskTitle')}</span>
            <input value={title} onChange={(event) => setTitle(event.target.value)} data-testid="task-title" className="ui-input w-full rounded-[var(--radius-control)] border border-line bg-page px-3 py-2 text-small text-ink outline-none focus-visible:ring-2 focus-visible:ring-ink" />
          </label>
          <p className="mb-1 mt-3 flex flex-wrap items-baseline gap-2 text-small font-medium text-ink">{t('loop.taskScope')} <span className="text-muted" data-testid="task-scope-count">({scope.length})</span></p>
          <ul className="m-0 grid list-none gap-1.5 p-0" data-testid="task-scope">
            {scope.map((one) => (
              <li key={JSON.stringify(one)} className="flex flex-wrap items-center gap-2 text-small" data-testid="task-scope-item" data-scope={scopeWords(one)} data-type={one.type}>
                <PlaceName place={places.get(JSON.stringify(one)) ?? { kind: one.type, label: scopeWords(one), where: null, href: null, path: null, words: scopeWords(one) }} />
                <button type="button" className="cursor-pointer bg-transparent p-0 text-small text-muted underline" onClick={() => withScope(scope.filter((held) => JSON.stringify(held) !== JSON.stringify(one)))} data-testid="task-scope-remove">{t('loop.taskScopeRemove')}</button>
              </li>
            ))}
          </ul>
          {scope.length === 0 && <p className="m-0 text-small text-muted" data-testid="task-scope-empty">{t('loop.taskScopeEmpty')}</p>}
          <div className="mt-2 flex flex-wrap items-end gap-2">
            <label className="grid gap-1 text-small">
              <span>{t('loop.taskScopeAdd')}</span>
              <input value={adding} onChange={(event) => setAdding(event.target.value)} placeholder={t('loop.taskScopeAddPlaceholder')} data-testid="task-scope-add-input" className="ui-input w-[18rem] rounded-[var(--radius-control)] border border-line bg-page px-2 py-1.5 text-small text-ink outline-none focus-visible:ring-2 focus-visible:ring-ink" />
            </label>
            <Button variant="default" size="default" type="button" onClick={add} disabled={adding.trim() === ''} data-testid="task-scope-add">{t('loop.taskScopeAddButton')}</Button>
          </div>
          <h3 className="mb-0 mt-4 text-base font-semibold">{t('loop.taskImpact')}</h3>
          {impact === null ? <p className="m-0 mt-1 text-small text-muted" data-testid="impact-none">{t('loop.taskImpactNone')}</p> : <ImpactList impact={impact} />}
          <div className="mt-4 flex flex-wrap gap-2">
            <Button variant="default" size="default" type="button" disabled={busy} onClick={confirm} data-testid="task-confirm">{t('loop.taskConfirm')}</Button>
          </div>
        </section>
      )}
      {refused !== null && <p className="m-0 mt-3 text-small" role="alert" data-testid="task-refused">{refused}</p>}
    </section>
  );
}

/**
 * One confirmed task where its answer stands: its scope, what the change reaches, and «Поправить страницы сейчас» — a
 * run over exactly those pages — or «Позже, вместе с другими ответами», which runs nothing.
 */
/** One task's card away from its page: it reads the task, then draws the same body the task page draws. */
export function TaskCard({ id, version, refresh }: { id: string; version: number; refresh: () => void }): ReactElement {
  const { t } = useTranslation();
  const { data: task, error } = useRead<TaskDetail>(`task:${id}`, version, (signal) => getTask(id, signal));
  if (task === null && error === null) return <PageSkeleton testId="task-loading" rows />;
  if (task === null) {
    return <Alert variant="problem" data-testid="task-error"><AlertTitle>{t('loop.taskPageTitle')}</AlertTitle><AlertDescription><p>{error}</p></AlertDescription></Alert>;
  }
  return <TaskBody task={task} refresh={refresh} />;
}

/** A confirmed task as both its page and its answer's page draw it: its impact, then the press that fixes the pages. */
export function TaskBody({ task, refresh, headline = true }: { task: TaskDetail; refresh: () => void; headline?: boolean }): ReactElement {
  const { t } = useTranslation();
  const language = useLanguage();
  const [working, setWorking] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  const [said, setSaid] = useState<string | null>(null);
  const run = (): void => {
    setWorking(true); setRefused(null); setSaid(null);
    runTask(task.id).then(
      (started) => { setWorking(false); setSaid(t('loop.refreshStarted', { count: started.pages.length })); refresh(); },
      (failure: unknown) => { setWorking(false); setRefused(message(failure)); },
    );
  };
  const close = (): void => {
    setWorking(true); setRefused(null);
    closeTask(task.id).then(() => { setWorking(false); refresh(); }, (failure: unknown) => { setWorking(false); setRefused(`${t('loop.taskCloseRefused')}: ${message(failure)}`); });
  };
  const nothingToRun = task.writable.length === 0;
  return (
    <section className="mt-6 rounded-[var(--radius-card)] border border-line p-3" data-testid="task-card" data-task={task.id} data-state={task.status}>
      {headline && (
        <div className="flex flex-wrap items-center gap-2">
          <KLink href={addressOfTask(task.id)} className="font-medium" data-testid="task-title-link">{task.title}</KLink>
          <Badge variant={task.status === 'open' ? 'solid' : 'outline'} data-testid="task-state">{task.status === 'open' ? t('loop.taskStateOpen') : t('loop.taskStateClosed')}</Badge>
          <Badge variant="outline" data-testid="task-marks">{t('loop.plannedChange')}</Badge>
        </div>
      )}
      <p className="mb-0 mt-1 flex flex-wrap items-center gap-x-3 text-small text-muted" data-testid="task-scope-words">{task.scope.map((one) => <PlaceName key={one.words} place={one.place} />)}</p>
      {task.closedBy !== null && (
        <p className="mb-0 mt-1 text-small text-muted" data-testid="task-closed-by">
          {'person' in task.closedBy
            ? t('loop.taskClosedByPerson', { when: whenWords(task.closedBy.at, language) })
            : t('loop.taskClosedByCommit', { commit: task.closedBy.commit.slice(0, 10), repository: task.closedBy.repository || t('knowledge.productRepository'), subject: task.closedBy.subject })}
        </p>
      )}
      {task.impact !== null && <ImpactList impact={task.impact} />}
      {task.problem !== undefined && <p className="m-0 mt-2 text-small" role="alert" data-testid="task-impact-problem">{task.problem}</p>}
      {task.status === 'open' && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button variant="default" size="default" type="button" disabled={working || nothingToRun} onClick={run} data-testid="task-fix-now">{t('loop.refreshNow')}</Button>
          <Button variant="default" size="default" type="button" disabled={working} onClick={() => setSaid(t('loop.refreshDeferred'))} data-testid="task-fix-later">{t('loop.laterAnswers')}</Button>
          <button type="button" className="cursor-pointer bg-transparent p-0 text-small text-muted underline" disabled={working} onClick={close} data-testid="task-close">{t('loop.taskClose')}</button>
        </div>
      )}
      {nothingToRun && task.status === 'open' && <p className="m-0 mt-2 text-small text-muted" data-testid="task-nothing-to-run">{t('loop.refreshNothing')}</p>}
      {said !== null && <p className="m-0 mt-2 text-small" role="status" data-testid="task-said">{said}</p>}
      {refused !== null && <p className="m-0 mt-2 text-small" role="alert" data-testid="task-refused">{refused}</p>}
    </section>
  );
}

/** «Задачи»: every task of the product, open first, each with its scope and what its change reaches. */
export function TasksPage({ version }: { version: number }): ReactElement {
  const { t } = useTranslation();
  const { data, error } = useRead('tasks', version, (signal) => getTasks(signal));
  useTabTitle(t('loop.tasksTitle'));
  if (data === null && error === null) return <PageSkeleton testId="tasks-loading" rows />;
  if (data === null) return <Alert variant="problem" data-testid="tasks-error"><AlertTitle>{t('loop.tasksMissing')}</AlertTitle><AlertDescription><p>{error}</p></AlertDescription></Alert>;
  const groups = [
    { state: 'open' as const, heading: t('loop.openTasks', { count: data.open }), rows: data.tasks.filter((row) => row.status === 'open') },
    { state: 'closed' as const, heading: t('loop.closedTasks', { count: data.closed }), rows: data.tasks.filter((row) => row.status === 'closed') },
  ];
  return (
    <section data-testid="tasks-page">
      <header className="mb-6">
        <h1>{t('loop.tasksTitle')}</h1>
        <p className="text-secondary" data-testid="tasks-intro">{t('loop.tasksIntro')}</p>
      </header>
      {data.problems.length > 0 && <Alert variant="problem" className="mb-6" data-testid="tasks-files"><AlertTitle>{t('loop.unreadableFiles')}</AlertTitle><AlertDescription><ul className="m-0 list-none p-0">{data.problems.map((line) => <li key={line}><code>{line}</code></li>)}</ul></AlertDescription></Alert>}
      {data.notes.length > 0 && <Alert className="mb-6" data-testid="tasks-notes"><AlertDescription><ul className="m-0 list-none p-0">{data.notes.map((note) => <li key={note}>{note}</li>)}</ul></AlertDescription></Alert>}
      {data.tasks.length === 0 && <p className="text-muted" data-testid="tasks-empty">{t('loop.noTasks')}</p>}
      {groups.map((group) => {
        if (group.rows.length === 0) return null;
        return (
          <section key={group.state} className="mb-8" data-testid="tasks-group" data-state={group.state}>
            <h2>{group.heading}</h2>
            <ul className="m-0 list-none p-0">
              {group.rows.map((row) => (
                <li key={row.id} className="border-b border-line py-3 last:border-b-0" data-testid="task-row" data-state={row.status} data-task={row.id}>
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <KLink href={addressOfTask(row.id)} className="font-medium">{row.title}</KLink>
                    <Badge variant={row.status === 'open' ? 'solid' : 'outline'}>{row.status === 'open' ? t('loop.taskStateOpen') : t('loop.taskStateClosed')}</Badge>
                  </div>
                  <p className="mb-0 mt-1 flex flex-wrap items-center gap-x-3 text-small text-muted" data-testid="task-row-scope">{row.scope.map((one) => <PlaceName key={one.words} place={one.place} />)}</p>
                  {row.impact !== null && <p className="mb-0 mt-1 text-small text-muted" data-testid="task-row-impact">{t('loop.taskImpactSummary', { pages: row.impact.pages, statements: row.impact.statements })}</p>}
                  {row.closedBy !== null && !('person' in row.closedBy) && <p className="mb-0 mt-1 text-small text-muted">{t('loop.taskClosedByCommit', { commit: row.closedBy.commit.slice(0, 10), repository: row.closedBy.repository || t('knowledge.productRepository'), subject: row.closedBy.subject })}</p>}
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </section>
  );
}

/** One task's page: its grounds, its scope, what the change reaches, and the way to fix the pages now or later. */
export function TaskPage({ id, version, refresh }: { id: string; version: number; refresh: () => void }): ReactElement {
  const { t } = useTranslation();
  const language = useLanguage();
  const { data: task, error } = useRead<TaskDetail>(`task:${id}`, version, (signal) => getTask(id, signal));
  useTabTitle(task?.title ?? null);
  if (task === null && error === null) return <PageSkeleton testId="task-page-loading" />;
  if (task === null) {
    return <Alert variant="problem" data-testid="task-page-error"><AlertTitle>{t('loop.tasksMissing')}</AlertTitle><AlertDescription><p>{error}</p></AlertDescription></Alert>;
  }
  const slug = task.question.startsWith('question:') ? task.question.slice('question:'.length) : task.question;
  return (
    <article data-testid="task-page" data-task={task.id} data-state={task.status}>
      <header className="mb-6">
        <nav aria-label="trail" className="mb-2 flex flex-wrap items-center gap-x-2 text-small text-muted"><KLink href={K_TASKS}>{t('loop.tasksTitle')}</KLink></nav>
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <Badge variant={task.status === 'open' ? 'solid' : 'outline'} data-testid="task-page-state">{task.status === 'open' ? t('loop.taskStateOpen') : t('loop.taskStateClosed')}</Badge>
          <code className="text-small text-muted">{task.file}</code>
        </div>
        <h1 data-testid="task-page-title">{task.title}</h1>
        <p className="m-0 text-small text-muted">
          <KLink href={addressOfQuestion(slug)}>{t('loop.taskFromAnswer', { title: slug })}</KLink>
          {' · '}
          <AuthorLine by={task.by} at={task.at} />
        </p>
        {task.closedBy !== null && (
          <p className="mb-0 mt-1 text-small" data-testid="task-page-closed-by">
            {'person' in task.closedBy
              ? t('loop.taskClosedByPerson', { when: whenWords(task.closedBy.at, language) })
              : t('loop.taskClosedByCommit', { commit: task.closedBy.commit.slice(0, 10), repository: task.closedBy.repository || t('knowledge.productRepository'), subject: task.closedBy.subject })}
          </p>
        )}
      </header>
      <section className="mb-6" data-testid="task-page-scope">
        <h2>{t('loop.taskScope')}</h2>
        <ul className="m-0 list-none p-0">
          {task.scope.map((one) => <li key={JSON.stringify(one.scope)} className="py-0.5 text-small" data-testid="task-page-scope-item" data-type={one.scope.type}><PlaceName place={one.place} /></li>)}
        </ul>
      </section>
      <section className="mb-6" data-testid="task-page-grounds">
        <h2>{t('loop.grounds')}</h2>
        <ul className="m-0 list-none p-0">
          {task.grounds.map((ground) => <li key={ground} className="py-0.5 text-small"><code>{ground}</code></li>)}
        </ul>
      </section>
      <section className="mb-6" data-testid="task-page-impact">
        <h2>{t('loop.taskImpact')}</h2>
        {task.impact === null
          ? <p className="m-0 text-small" role="alert">{task.problem ?? t('loop.taskImpactNone')}</p>
          : <ImpactList impact={task.impact} />}
        <p className="mb-0 mt-2 text-small text-muted" data-testid="task-page-marks">{t('loop.taskMarks', { sections: task.marks.sections, statements: task.marks.statements, entities: task.marks.entities })}</p>
      </section>
      {task.status === 'open' && <TaskBody task={task} refresh={refresh} headline={false} />}
    </article>
  );
}
