import { RadioInput } from '@/components/ui/radio-input.js';
import { Breadcrumb } from '@/components/ui/breadcrumb.js';
import { Textarea } from '@/components/ui/textarea.js';
import { Input } from '@/components/ui/input.js';
import { DetailTitle, ReadingPanel, ReadingPanelItem, ReadingQuote, WrappingList } from '@/components/ui/reading-layout.js';
import { Disclosure, DisclosureSummary } from '@/components/ui/disclosure.js';
import { InlineCode } from '@/components/ui/inline-content.js';
import { FieldLabel, Form, ListItem, PageArticle, PageHeader, PageSection, PageTitle, Paragraph, PlainList, SectionTitle, SmallTitle, Stack, Text } from '@/components/ui/typography.js';
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
import { answerQuestion, closeTask, createProblemTask, createTask, dismissProblem, getProblemCategories, getProblemItems, getProblemSources, getQuestion, getQuestions, getScopeImpact, getTask, getTasks, proposeTask, runTask } from './api.js';
import { CodePlace, KLink, brokenWords } from './blocks.js';
import { addressOfEntity, addressOfQuestion, addressOfStatement, addressOfTask, WIKI_QUESTIONS, WIKI_TASKS } from './routes.js';
import { useRead } from './live.js';
import { useTabTitle } from './tabs.js';
import { PageSkeleton } from './skeleton.js';
import type { Author, PlaceView, Problem, ProblemCategory, ProblemSection, ProblemSource, QuestionDetail, QuestionRow, QuestionState, RefreshPlan, Resolution, TaskDetail, TaskImpact, TaskProposal, TaskScope } from './types.js';

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
  if (resolution === undefined) return <InlineCode className="text-small">{target}</InlineCode>;
  if (resolution.state === 'broken') return <Text className="ref-broken" title={brokenWords(resolution, t)} data-testid="ref-broken">{target}<Text className="ref-broken-mark">{t('knowledge.broken')}</Text></Text>;
  if (resolution.location !== undefined) return <CodePlace location={resolution.location} />;
  if (resolution.href !== null) return <KLink href={resolution.href}>{resolution.label}</KLink>;
  return <Text>{resolution.label}</Text>;
}

function AuthorLine({ by, at }: { by: Author; at: string | null }): ReactElement {
  const { t } = useTranslation();
  const language = useLanguage();
  return (
    <Text className="text-small text-muted" data-testid="author-line">
      {t('loop.by', { name: by.name, email: by.email })}{at !== null && `, ${whenWords(at, language)}`}
      {' · '}
      <Text data-testid="verified-mark" title={t('loop.verifiedHint')}>{t('loop.localUnverified')}</Text>
    </Text>
  );
}

const STATE_KEY: Record<QuestionState, string> = { open: 'loop.stateOpen', answered: 'loop.stateAnswered', closed: 'loop.stateClosed' };

function QuestionItem({ row }: { row: QuestionRow }): ReactElement {
  const { t } = useTranslation();
  return (
    <ListItem className="border-b border-line py-3 last:border-b-0" data-testid="question-row" data-question={row.slug} data-state={row.state}>
      <Stack className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <KLink href={addressOfQuestion(row.slug)} className="font-medium">{row.title}</KLink>
        <Badge>{t(`loop.type.${row.type}`)}</Badge>
        <Badge variant={row.state === 'open' ? 'solid' : 'outline'}>{t(STATE_KEY[row.state])}</Badge>
      </Stack>
      <Stack className="mt-1 text-small text-muted">
        {row.askedIn !== null && <Text>{t('loop.askedIn')} <KLink href={addressOfEntity(row.askedIn)}>{shortId(row.askedIn)}</KLink></Text>}
        {row.state === 'closed' && row.closedBy.length > 0 && <Text> · {t('loop.closedBy')} {row.closedBy.map((id, index) => <Text key={id}>{index > 0 && ', '}<KLink href={addressOfEntity(id)}>{shortId(id)}</KLink></Text>)}</Text>}
        {row.state === 'answered' && <Text> · {t('loop.waitsForRefresh')}</Text>}
      </Stack>
    </ListItem>
  );
}

/** «Вопросы»: the questions the agent asked, open first. */
export function QuestionsPage({ version }: { version: number }): ReactElement {
  const { t } = useTranslation();
  const { data, error } = useRead('questions', version, (signal) => getQuestions(signal));
  useTabTitle(t('loop.questionsTitle'));
  if (data === null && error === null) return <PageSkeleton testId="questions-loading" rows />;
  if (data === null) {
    return <Alert variant="problem" data-testid="questions-error"><AlertTitle>{t('loop.questionsMissing')}</AlertTitle><AlertDescription><Paragraph>{error}</Paragraph></AlertDescription></Alert>;
  }
  const groups: { state: QuestionState; heading: string }[] = [
    { state: 'open', heading: t('loop.openHeading', { count: data.open }) },
    { state: 'answered', heading: t('loop.answeredHeading', { count: data.answered }) },
    { state: 'closed', heading: t('loop.closedHeading', { count: data.closed }) },
  ];
  return (
    <PageSection data-testid="questions-page">
      <PageHeader className="mb-6">
        <PageTitle>{t('loop.questionsTitle')}</PageTitle>
        <Paragraph className="text-secondary" data-testid="questions-intro">{t('loop.questionsIntro')}</Paragraph>
      </PageHeader>
      {data.problems.length > 0 && (
        <Alert variant="problem" className="mb-6" data-testid="questions-files">
          <AlertTitle>{t('loop.unreadableFiles')}</AlertTitle>
          <AlertDescription><PlainList className="m-0 list-none p-0">{data.problems.map((line) => <ListItem key={line}><InlineCode>{line}</InlineCode></ListItem>)}</PlainList></AlertDescription>
        </Alert>
      )}
      {data.rows.length === 0 && <Paragraph className="text-muted" data-testid="questions-empty">{t('loop.noQuestions')}</Paragraph>}
      {groups.map((group) => {
        const rows = data.rows.filter((row) => row.state === group.state);
        if (rows.length === 0) return null;
        return (
          <PageSection key={group.state} className="mb-8" data-testid="questions-group" data-state={group.state}>
            <SectionTitle>{group.heading}</SectionTitle>
            <PlainList className="m-0 list-none p-0">{rows.map((row) => <QuestionItem key={row.slug} row={row} />)}</PlainList>
          </PageSection>
        );
      })}
    </PageSection>
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
    <Form className="mt-2 grid gap-3" data-testid="answer-form" onSubmit={(event) => { event.preventDefault(); if (text.trim() !== '' && !saving) save(); }}>
      <FieldLabel className="grid gap-1.5">
        <Text className="text-small font-medium text-ink">{t('loop.yourAnswer')}</Text>
        <Textarea
          value={text}
          onChange={(event) => setText(event.target.value)}
          rows={5}
          placeholder={t('loop.answerPlaceholder')}
          data-testid="answer-text"
          
        />
      </FieldLabel>
      <Paragraph className="m-0 text-small text-muted" data-testid="answer-where">{t('loop.answerWhere', { file: question.file })}</Paragraph>
      <Stack className="flex flex-wrap gap-2"><Button variant="default" size="default" type="submit" disabled={saving || text.trim() === ''} data-testid="answer-save">{t('loop.saveAnswer')}</Button></Stack>
      {refused !== null && <Paragraph className="m-0 text-small" role="alert" data-testid="answer-refused">{refused}</Paragraph>}
    </Form>
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
    return <Alert variant="problem" data-testid="question-error"><AlertTitle>{t('loop.noSuchQuestion')}</AlertTitle><AlertDescription><Paragraph>{error}</Paragraph></AlertDescription></Alert>;
  }
  const affected = [...new Set(question.about.map((entry) => entry.split('#')[0]!).filter((entry) => /^(product|domain):/.test(entry)))];
  const mine = (tasks?.tasks ?? []).filter((row) => row.question === `question:${question.slug}`);
  return (
    <PageArticle data-testid="question-page" data-question={question.slug} data-state={question.state}>
      <PageHeader className="mb-6">
        <Breadcrumb aria-label="trail" className="mb-2 flex flex-wrap items-center gap-x-2 text-small text-muted"><KLink href={WIKI_QUESTIONS}>{t('loop.questionsTitle')}</KLink></Breadcrumb>
        <Stack className="mb-2 flex items-center gap-2">
          <Badge>{t(`loop.type.${question.type}`)}</Badge>
          <Badge variant={question.state === 'open' ? 'solid' : 'outline'} data-testid="question-state">{t(STATE_KEY[question.state])}</Badge>
        </Stack>
        <PageTitle data-testid="question-title">{question.title}</PageTitle>
        {question.askedIn !== null && <Paragraph className="m-0 text-small text-muted">{t('loop.askedBy', { when: whenWords(question.askedAt, language) })} <KLink href={addressOfEntity(question.askedIn)}>{shortId(question.askedIn)}</KLink></Paragraph>}
      </PageHeader>
      <PageSection className="mb-6">
        <Paragraph className="text-body" data-testid="question-text">{question.question}</Paragraph>
        <SectionTitle>{t('loop.whyItMatters')}</SectionTitle>
        <Paragraph className="text-secondary" data-testid="question-why">{question.why}</Paragraph>
      </PageSection>
      <PageSection className="mb-8" data-testid="question-sides">
        <SectionTitle>{t('loop.whatSourcesSay')}</SectionTitle>
        <WrappingList>
          {question.sides.map((side, index) => (
            <ReadingPanelItem key={index} data-testid="question-side">
              <Paragraph className="m-0 text-body">{side.claim}</Paragraph>
              <Paragraph className="m-0 mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-small text-muted">
                <Text>{t('loop.grounds')}</Text>
                {side.grounds.map((ground) => <Target key={ground} target={ground} resolutions={question.resolutions} />)}
              </Paragraph>
            </ReadingPanelItem>
          ))}
        </WrappingList>
      </PageSection>
      {affected.length > 0 && (
        <Paragraph className="mb-8 text-small text-muted" data-testid="question-affects">{t('loop.affects')} {affected.map((id, index) => <Text key={id}>{index > 0 && ', '}<KLink href={addressOfEntity(id)}>{shortId(id)}</KLink></Text>)}</Paragraph>
      )}
      {commitNote !== null && <Alert variant="problem" className="mb-6" data-testid="answer-note"><AlertDescription><Paragraph>{commitNote}</Paragraph></AlertDescription></Alert>}
      {question.state === 'open' && (
        <PageSection data-testid="question-answer-section">
          <SectionTitle>{t('loop.answerHeading')}</SectionTitle>
          <AnswerForm question={question} onSaved={(note) => { setCommitNote(note); refresh(); }} />
        </PageSection>
      )}
      {question.answer !== null && (
        <PageSection data-testid="question-answer">
          <SectionTitle>{t('loop.answerHeading')}</SectionTitle>
          <ReadingQuote data-testid="answer-quote">{question.answer.text}</ReadingQuote>
          <Paragraph className="mb-0 mt-2"><AuthorLine by={question.answer.by} at={question.answer.at} /></Paragraph>
          {question.state === 'answered' && <Alert className="mt-4" data-testid="answer-waiting"><AlertDescription><Paragraph>{t('loop.answerWaiting')}</Paragraph></AlertDescription></Alert>}
          {question.state === 'closed' && (
            <Alert className="mt-4" data-testid="answer-closed">
              <AlertDescription><Paragraph>{t('loop.answerClosed', { when: whenWords(question.resolvedAt, language) })} {question.closedBy.map((id, index) => <Text key={id}>{index > 0 && ', '}<KLink href={addressOfEntity(id)}>{shortId(id)}</KLink></Text>)}</Paragraph></AlertDescription>
            </Alert>
          )}
        </PageSection>
      )}
      {question.answer !== null && mine.length > 0 && mine.map((task) => <TaskCard key={task.id} id={task.id} version={version} refresh={refresh} />)}
      {question.answer !== null && mine.length === 0 && <ProposeTaskForm question={question} refresh={refresh} />}
    </PageArticle>
  );
}

// ---- problems ---------------------------------------------------------------------------------

/** A link the data layer built: its href when the wiki can open it, its label as plain text otherwise. */
function ProblemLinkView({ link }: { link: NonNullable<Problem['place']> }): ReactElement {
  return link.href === null ? <InlineCode>{link.label}</InlineCode> : <KLink href={link.href}>{link.label}</KLink>;
}

function ProblemItem({ problem, refresh }: { problem: Problem; refresh: () => void }): ReactElement {
  const { t } = useTranslation();
  const [asking, setAsking] = useState(false);
  const [reason, setReason] = useState('');
  const [working, setWorking] = useState<'dismiss' | 'task' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const where = problem.page === null ? null : <KLink href={addressOfEntity(problem.page)}>{problem.pageTitle ?? shortId(problem.page)}</KLink>;
  const missingGroup = /^kind "([^"]+)": "group" names a group of "groups" (?:\([^)]*\)|.*?), got "([^"]+)"$/.exec(problem.reason);
  const readerReason = missingGroup === null ? problem.reason : t('knowledge.manifestMissingGroup', {
    kind: t(`knowledge.manifestKinds.${missingGroup[1]}`, { defaultValue: missingGroup[1] }), group: missingGroup[2],
  });
  const ruleWords = problem.rule === undefined
    ? t(`loop.problem.${problem.kind}`, { defaultValue: problem.kind })
    : t(`loop.rule.${problem.rule}`, { defaultValue: t(`loop.problem.${problem.kind}`, { defaultValue: problem.kind }) });
  const act = (what: 'dismiss' | 'task'): void => {
    if (problem.id === undefined) return;
    setWorking(what);
    setError(null);
    const call = what === 'dismiss' ? dismissProblem(problem.id, reason) : createProblemTask(problem.id);
    call.then((result) => {
      setWorking(null);
      setAsking(false);
      setDone(what === 'dismiss' ? t('loop.problemDismissed') : t('loop.problemTaskCreated', { title: 'task' in result ? result.task.slug : '' }));
      refresh();
    }, (failure: unknown) => { setWorking(null); setError(message(failure)); });
  };
  const evidence = problem.evidence ?? [];
  return (
    <ListItem className="border-b border-line py-3 last:border-b-0" data-testid="problem-row" data-kind={problem.kind} data-rule={problem.rule} data-closed={problem.closed ? 'true' : 'false'}>
      <Stack className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Text className="font-medium" data-testid="problem-rule">{ruleWords}</Text>
        {problem.sonar !== undefined && <Badge variant="outline" data-testid="problem-sonar">{t(`loop.sonar.${problem.sonar}`)}</Badge>}
        {problem.severity !== undefined && <Badge variant={problem.severity === 'blocker' || problem.severity === 'critical' ? 'solid' : 'outline'} data-testid="problem-severity">{t(`loop.severity.${problem.severity}`)}</Badge>}
        <Badge variant={problem.fixer === 'agent' ? 'outline' : 'solid'} data-testid="problem-fixer">{t(`loop.fixer.${problem.fixer}`)}</Badge>
        {problem.closed && <Badge>{t('loop.stateClosed')}</Badge>}
      </Stack>
      {(problem.place !== undefined || where !== null) && (
        <Paragraph className="mb-0 mt-1.5 text-small" data-testid="problem-place">
          {t('loop.problemPlace')} {problem.place === undefined ? where : <ProblemLinkView link={problem.place} />}
          {problem.entity != null && <> · {t('loop.problemEntity')} <ProblemLinkView link={problem.entity} /></>}
        </Paragraph>
      )}
      {problem.sentence !== null && <Paragraph className="mb-0 mt-1.5 text-secondary" data-testid="problem-sentence">«{problem.sentence}»</Paragraph>}
      <Paragraph className="mb-0 mt-1 text-small"><Text data-testid="problem-reason">{readerReason}</Text></Paragraph>
      {evidence.length > 0 && (
        <Paragraph className="mb-0 mt-1 text-small text-muted" data-testid="problem-evidence">
          {t('loop.problemEvidence')} {evidence.map((link, index) => <Text key={`${link.key ?? link.label}:${index}`}>{index > 0 && ' → '}{link.href === null ? <InlineCode>{link.label}</InlineCode> : <KLink href={link.href}>{link.label}</KLink>}</Text>)}
        </Paragraph>
      )}
      {missingGroup !== null && <Disclosure className="mt-1 text-small text-muted" data-testid="problem-details"><DisclosureSummary className="cursor-pointer underline">{t('knowledge.findingsDetails')}</DisclosureSummary><InlineCode>{problem.reason}</InlineCode></Disclosure>}
      <Paragraph className="mb-0 mt-1 text-small text-muted">
        {where !== null && <Text>{t('loop.onPage')} {where} · </Text>}
        <InlineCode>{problem.file}{problem.line === null ? '' : `:${problem.line}`}</InlineCode>
        {problem.source !== undefined && <> · <InlineCode data-testid="problem-source">{problem.source}</InlineCode></>}
        {problem.by !== null && problem.by !== undefined && <Text> · <AuthorLine by={problem.by} at={problem.at ?? null} /></Text>}
      </Paragraph>
      <Paragraph className="mb-0 mt-1 text-small text-muted" data-testid="problem-who">{problem.closed ? t('loop.fixedNote') : t(`loop.whoFixes.${problem.kind}`, { defaultValue: t('loop.whoFixes.correction') })}</Paragraph>
      {!problem.closed && problem.id !== undefined && (
        <Stack className="mt-2 flex flex-wrap items-center gap-2">
          {problem.scope !== undefined && <Button size="default" variant="default" data-testid="problem-task" disabled={working !== null} onClick={() => act('task')}>{t('loop.problemCreateTask')}</Button>}
          <Button size="default" variant="ghost" data-testid="problem-not-a-problem" disabled={working !== null} onClick={() => setAsking((open) => !open)}>{t('loop.problemNotAProblem')}</Button>
          {done !== null && <Text className="text-small text-muted" data-testid="problem-done">{done}</Text>}
          {error !== null && <Text className="text-small" data-testid="problem-action-error">{error}</Text>}
        </Stack>
      )}
      {asking && problem.id !== undefined && (
        <Stack className="mt-2" data-testid="problem-dismiss">
          <FieldLabel className="block text-small" htmlFor={`dismiss-${problem.id}`}>{t('loop.problemDismissPrompt')}</FieldLabel>
          <Textarea id={`dismiss-${problem.id}`} data-testid="problem-dismiss-reason" className="mt-1 w-full" rows={2} value={reason} onChange={(event) => setReason(event.target.value)} />
          <Stack className="mt-1 flex gap-2">
            <Button size="default" data-testid="problem-dismiss-confirm" disabled={working !== null || reason.trim() === ''} onClick={() => act('dismiss')}>{t('loop.problemDismissConfirm')}</Button>
            <Button size="default" variant="ghost" onClick={() => setAsking(false)}>{t('loop.cancel')}</Button>
          </Stack>
        </Stack>
      )}
    </ListItem>
  );
}

/** A page of one level, appended to the pages already read; `next` is the server's exact cursor. */
function usePaged<T extends { next: string | null }>(key: string, version: number, load: (after?: string) => Promise<T>): { pages: T[]; error: string | null; loading: boolean; more: () => void } {
  const [pages, setPages] = useState<T[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    let live = true;
    setPages([]);
    setError(null);
    setLoading(true);
    load().then(
      (first) => { if (live) { setPages([first]); setLoading(false); } },
      (failure: unknown) => { if (live) { setError(message(failure)); setLoading(false); } },
    );
    return () => { live = false; };
  }, [key, version]);
  const more = (): void => {
    const last = pages[pages.length - 1];
    if (last === undefined || last.next === null || loading) return;
    setLoading(true);
    load(last.next).then(
      (next) => { setPages((held) => [...held, next]); setLoading(false); },
      (failure: unknown) => { setError(message(failure)); setLoading(false); },
    );
  };
  return { pages, error, loading, more };
}

/** One source of a category: its count, closed until a reader opens it; opening asks the server for its items. */
function ProblemSourceGroup({ rule, source, version, refresh }: { rule: string; source: ProblemSource; version: number; refresh: () => void }): ReactElement {
  const [opened, setOpened] = useState(false);
  return (
    <Disclosure
      className="border-b border-line py-3 last:border-b-0"
      data-testid="problem-source"
      data-source={source.key}
    >
      <DisclosureSummary className="flex cursor-pointer flex-wrap items-center gap-x-3 gap-y-1" onClick={() => setOpened(true)}>
        <Text className="font-medium">{source.label}</Text>
        <Badge variant="outline" data-testid="problem-source-count">{source.count}</Badge>
        {source.file !== null && <InlineCode className="text-small text-muted">{source.file}</InlineCode>}
      </DisclosureSummary>
      {opened && <ProblemItemsList rule={rule} source={source.key} version={version} refresh={refresh} />}
    </Disclosure>
  );
}

/** The items of one source, paged: the count of the whole source stands beside the rows shown. */
function ProblemItemsList({ rule, source, version, refresh }: { rule: string; source: string; version: number; refresh: () => void }): ReactElement {
  const { t } = useTranslation();
  const { pages, error, loading, more } = usePaged(`problem-items:${rule}:${source}`, version, (after) => getProblemItems(rule, source, after === undefined ? {} : { after }));
  const first = pages[0];
  const rows = pages.flatMap((page) => page.problems);
  const last = pages[pages.length - 1];
  if (error !== null) return <Alert variant="problem" data-testid="problem-items-error"><AlertDescription><Paragraph>{error}</Paragraph></AlertDescription></Alert>;
  return (
    <Stack className="mt-2 pl-4" data-testid="problem-items">
      <PlainList className="m-0 list-none p-0">{rows.map((problem) => <ProblemItem key={problem.id ?? `${problem.kind}:${problem.file}:${problem.line ?? ''}:${problem.target ?? ''}`} problem={problem} refresh={refresh} />)}</PlainList>
      {first !== undefined && (
        <Paragraph className="mb-0 mt-2 flex flex-wrap items-center gap-3 text-small text-muted" data-testid="problem-items-more">
          <Text>{t('loop.problemPageShown', { shown: rows.length, count: first.count })}</Text>
          {last?.next !== null && last !== undefined && <Button size="default" variant="ghost" disabled={loading} onClick={more} data-testid="problem-items-next">{t('loop.problemPageNext')}</Button>}
        </Paragraph>
      )}
    </Stack>
  );
}

/** The second level: the sources of one category, one bounded page at a time. */
function ProblemSources({ rule, version, onBack, refresh }: { rule: string; version: number; onBack: () => void; refresh: () => void }): ReactElement {
  const { t } = useTranslation();
  const { pages, error, loading, more } = usePaged(`problem-sources:${rule}`, version, (after) => getProblemSources(rule, after === undefined ? {} : { after }));
  const first = pages[0];
  const sources = pages.flatMap((page) => page.sources);
  const last = pages[pages.length - 1];
  if (error !== null) return <Alert variant="problem" data-testid="problems-error"><AlertTitle>{t('loop.problemsMissing')}</AlertTitle><AlertDescription><Paragraph>{error}</Paragraph></AlertDescription></Alert>;
  if (first === undefined) return <PageSkeleton testId="problems-loading" rows />;
  return (
    <PageSection data-testid="problem-sources" data-rule={rule}>
      <Paragraph className="mb-4"><Button size="default" variant="ghost" onClick={onBack} data-testid="problems-back">{t('loop.problemBack')}</Button></Paragraph>
      <SectionTitle>{t(`loop.rule.${rule}`, { defaultValue: rule })} <InlineCode className="text-small">{rule}</InlineCode></SectionTitle>
      <Paragraph className="text-secondary" data-testid="problem-sources-intro">{t('loop.problemSourcesIntro')}</Paragraph>
      <PlainList className="m-0 list-none p-0">{sources.map((source) => <ListItem key={source.key}><ProblemSourceGroup rule={rule} source={source} version={version} refresh={refresh} /></ListItem>)}</PlainList>
      <Paragraph className="mb-0 mt-3 flex flex-wrap items-center gap-3 text-small text-muted" data-testid="problem-sources-more">
        <Text>{t('loop.problemSourcesShown', { shown: sources.length, count: first.totalSources })}</Text>
        {last?.next !== null && last !== undefined && <Button size="default" variant="ghost" disabled={loading} onClick={more} data-testid="problem-sources-next">{t('loop.problemPageNext')}</Button>}
      </Paragraph>
    </PageSection>
  );
}

/** «Проблемы»: one row per category, its sources on opening it, and the items of a source on opening the source. */
export function ProblemsPage({ version, refresh = () => undefined }: { version: number; refresh?: () => void }): ReactElement {
  const { t } = useTranslation();
  const language = useLanguage();
  const [section, setSection] = useState<ProblemSection | undefined>(undefined);
  const [rule, setRule] = useState<string | null>(null);
  const { data, error } = useRead(`problem-categories:${section ?? 'all'}`, version, (signal) => getProblemCategories(section === undefined ? {} : { section }, signal));
  useTabTitle(t('loop.problemsTitle'));
  if (rule !== null) return <ProblemSources rule={rule} version={version} onBack={() => setRule(null)} refresh={refresh} />;
  if (data === null && error === null) return <PageSkeleton testId="problems-loading" rows />;
  if (data === null) {
    return <Alert variant="problem" data-testid="problems-error"><AlertTitle>{t('loop.problemsMissing')}</AlertTitle><AlertDescription><Paragraph>{error}</Paragraph></AlertDescription></Alert>;
  }
  const ruleName = (category: ProblemCategory): string => t(`loop.rule.${category.rule}`, { defaultValue: category.label?.[language] ?? category.rule });
  const meaning = (category: ProblemCategory): string => t(`loop.ruleMeaning.${category.rule}`, { defaultValue: '' });
  const filters: { key: string; section?: ProblemSection }[] = [
    { key: 'loop.problemFilterAll' },
    { key: 'loop.sectionCode', section: 'code' },
    { key: 'loop.sectionDocuments', section: 'documents' },
    { key: 'loop.sectionWiki', section: 'wiki' },
  ];
  return (
    <PageSection data-testid="problems-page">
      <PageHeader className="mb-6">
        <PageTitle>{t('loop.problemsTitle')}</PageTitle>
        <Paragraph className="text-secondary" data-testid="problems-intro">{t('loop.problemsIntro')}</Paragraph>
      </PageHeader>
      {data.notes.map((note) => (
        <Alert key={note.message} className="mb-4" data-testid="problems-note"><AlertDescription><Paragraph>{note.textKey === undefined ? note.message : t(`loop.problemNote.${note.textKey}`, { ...(note.textArgs ?? {}), defaultValue: note.message })}</Paragraph></AlertDescription></Alert>
      ))}
      <Paragraph className="mb-4 flex flex-wrap items-center gap-2" data-testid="problems-filters">
        {filters.map((filter) => (
          <Button key={filter.key} size="default" variant={section === filter.section ? 'default' : 'ghost'} data-testid={`problems-filter-${filter.section ?? 'all'}`} onClick={() => setSection(filter.section)}>{t(filter.key)}</Button>
        ))}
      </Paragraph>
      {data.categories.length === 0 && <Paragraph className="text-muted" data-testid="problems-empty">{t('loop.noProblems')}</Paragraph>}
      <Paragraph className="mb-2 text-secondary" data-testid="problems-total">{t('loop.problemCount', { count: data.open, total: data.total })}</Paragraph>
      <PlainList className="m-0 list-none p-0" data-testid="problem-categories">
        {data.categories.map((category) => (
          <ListItem key={category.rule} className="border-b border-line py-3 last:border-b-0">
            <Button type="button" size="content" className="w-full justify-start flex-wrap gap-x-3 gap-y-1" data-testid="problem-category" data-rule={category.rule} onClick={() => setRule(category.rule)}>
              <Text className="font-medium">{ruleName(category)}</Text>
              <InlineCode className="text-small">{category.rule}</InlineCode>
              <Badge variant={category.severity === 'blocker' || category.severity === 'critical' ? 'solid' : 'outline'} data-testid="problem-category-severity">{t(`loop.severity.${category.severity}`)}</Badge>
              <Text className="text-small text-secondary">{t(`loop.fixer.${category.fixer}`)}</Text>
              <Text className="ml-auto font-medium" data-testid="problem-category-count">{category.count}</Text>
            </Button>
            {meaning(category) !== '' && <Paragraph className="mb-0 mt-1 text-small text-secondary" data-testid="problem-category-meaning">{meaning(category)}</Paragraph>}
          </ListItem>
        ))}
      </PlainList>
      {(data.dismissed ?? 0) > 0 && <Paragraph className="text-small text-muted" data-testid="problems-dismissed">{t('loop.problemDismissedCount', { count: data.dismissed })}</Paragraph>}
    </PageSection>
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
    <Stack data-testid="refresh-plan">
      {plan.pages.length === 0
        ? <Paragraph className="m-0 text-small" data-testid="plan-nothing">{t('loop.plan.nothing')}</Paragraph>
        : <Paragraph className="mb-2 mt-0 text-small font-medium text-ink" data-testid="plan-summary">{t('loop.plan.touches', { count: plan.pages.length })}{plan.unchanged.length > 0 && <Text className="font-normal text-muted"> {t('loop.plan.leaves', { count: plan.unchanged.length })}</Text>}</Paragraph>}
      <PlainList className="m-0 list-none p-0 text-small" data-testid="plan-pages">
        {plan.pages.map((page) => (
          <ListItem key={page.path} className="border-b border-line py-1.5 last:border-b-0" data-testid="plan-page" data-path={page.path}>
            <InlineCode>{page.path}</InlineCode>
            <PlainList className={`m-0 list-disc ps-5 text-secondary ${compact ? 'mt-0.5' : 'mt-1'}`}>
              {page.reasons.map((reason, index) => <ListItem key={index} data-testid="plan-reason" data-kind={reason.kind}><ReasonText reason={reason} /></ListItem>)}
            </PlainList>
          </ListItem>
        ))}
      </PlainList>
      {plan.unplaced.map((miss) => <Paragraph key={`${miss.kind}:${miss.slug}`} className="mb-0 mt-2 text-small" role="alert" data-testid="plan-unplaced">{t('loop.plan.unplaced', { title: miss.title })} {miss.reason}</Paragraph>)}
      {plan.problems.map((line) => <Paragraph key={line} className="mb-0 mt-2 text-small" role="alert" data-testid="plan-problem"><InlineCode>{line}</InlineCode></Paragraph>)}
    </Stack>
  );
}

// ---- the scoped tasks of answers (madarch-m38l.14) -------------------------------------------

/** A scope as a reader says it: `README.md#what-it-does`, `src/a.ts:12-20`, a code symbol's graph key, a statement's, or a path. */
function scopeWords(scope: TaskScope): string {
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
function scopeOfWords(words: string): TaskScope | undefined {
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
function PlaceName({ place }: { place: PlaceView }): ReactElement {
  const label = place.href === null ? <Text>{place.label}</Text> : <KLink href={place.href}>{place.label}</KLink>;
  return (
    <Text className="place" data-testid="place" data-kind={place.kind} title={place.words}>
      {label}
      {place.where !== null && place.where !== place.label && <Text className="text-muted"> — {place.where}</Text>}
      {place.path !== null && place.path !== place.label && place.kind !== 'section' && <InlineCode className="ms-2 text-muted">{place.path}</InlineCode>}
      {place.kind === 'section' && place.path !== null && <InlineCode className="ms-2 text-muted" data-testid="place-path">{place.path}</InlineCode>}
    </Text>
  );
}

/** What a change reaches, computed through the graph: every page and statement, before anything runs. */
function ImpactList({ impact }: { impact: TaskImpact }): ReactElement {
  const { t } = useTranslation();
  return (
    <Stack className="mt-2" data-testid="task-impact-list">
      <Paragraph className="m-0 text-small font-medium text-ink" data-testid="impact-counts">{t('loop.taskImpactPages', { count: impact.counts.pages })} {t('loop.taskImpactStatements', { count: impact.counts.statements })}</Paragraph>
      {impact.pages.length === 0 && impact.statements.length === 0 && <Paragraph className="m-0 mt-1 text-small text-muted" data-testid="impact-none">{t('loop.taskImpactNone')}</Paragraph>}
      {impact.unindexed.length > 0 && <Paragraph className="m-0 mt-1 text-small text-muted" role="status" data-testid="impact-unindexed" title={impact.unindexed.join(', ')}>{t('loop.taskImpactUnindexed', { count: impact.unindexed.length })}</Paragraph>}
      {impact.pages.length > 0 && (
        <PageSection className="mt-2" data-testid="impact-pages">
          <DetailTitle className="mb-1 text-small font-semibold">{t('loop.taskImpactPages')}</DetailTitle>
          <PlainList className="m-0 list-none p-0 text-small">
            {impact.pages.map((page) => (
              <ListItem key={page.id} className="flex flex-wrap items-center gap-x-2 py-0.5" data-testid="impact-page" data-id={page.id} data-because={page.because}>
                <KLink href={addressOfEntity(page.id)}>{page.title}</KLink>
                <InlineCode className="text-muted">{page.file}</InlineCode>
                {page.because === 'link' && <Text className="text-muted">· {t('loop.taskImpactLinked')}</Text>}
              </ListItem>
            ))}
          </PlainList>
        </PageSection>
      )}
      {impact.statements.length > 0 && (
        <PageSection className="mt-2" data-testid="impact-statements">
          <DetailTitle className="mb-1 text-small font-semibold">{t('loop.taskImpactStatements')}</DetailTitle>
          <PlainList className="m-0 list-none p-0 text-small">
            {impact.statements.map((statement) => (
              <ListItem key={`${statement.page}#${statement.statement}`} className="py-0.5" data-testid="impact-statement" data-page={statement.page} data-statement={statement.statement}>
                <KLink href={addressOfStatement(statement.page, statement.text)}>«{statement.text}»</KLink>
                <Text className="ms-2 text-muted">{statement.pageTitle}</Text>
                <InlineCode className="ms-2 text-muted" title={statement.grounds.join(', ')}>{statement.file}:{statement.line}</InlineCode>
              </ListItem>
            ))}
          </PlainList>
        </PageSection>
      )}
    </Stack>
  );
}

/**
 * The task an answer proposes: the reader chooses what needs to change, and the engine turns the answer's grounds into
 * an editable scope and the impact through the graph. Nothing is written before the reader confirms.
 */
function ProposeTaskForm({ question, refresh }: { question: QuestionDetail; refresh: () => void }): ReactElement {
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
    <PageSection className="mt-6" data-testid="task-proposal">
      <SectionTitle>{t('loop.taskChoice')}</SectionTitle>
      <Stack role="radiogroup" aria-label={t('loop.taskChoice')} className="grid gap-2" data-testid="task-choice">
        {([['code', t('loop.taskDocsWrong')], ['docs', t('loop.taskCodeWrong')], ['other', t('loop.taskOther')]] as const).map(([value, label]) => (
          <FieldLabel key={value} className="flex cursor-pointer items-center gap-2 text-small">
            <RadioInput name="task-choice" value={value} checked={choice === value} onChange={() => setChoice(value)} data-testid={`task-choice-${value}`} />
            <Text>{label}</Text>
          </FieldLabel>
        ))}
      </Stack>
      <Stack className="mt-3 flex flex-wrap gap-2">
        <Button variant="default" size="default" type="button" disabled={busy || choice === 'other'} onClick={propose} data-testid="task-propose">{t('loop.taskPropose')}</Button>
      </Stack>
      {proposal !== null && (
        <ReadingPanel className="mt-4" data-testid="task-proposed">
          <FieldLabel className="grid gap-1">
            <Text className="text-small font-medium text-ink">{t('loop.taskTitle')}</Text>
            <Input value={title} onChange={(event) => setTitle(event.target.value)} data-testid="task-title"  />
          </FieldLabel>
          <Paragraph className="mb-1 mt-3 flex flex-wrap items-baseline gap-2 text-small font-medium text-ink">{t('loop.taskScope')} <Text className="text-muted" data-testid="task-scope-count">({scope.length})</Text></Paragraph>
          <PlainList className="m-0 grid list-none gap-1.5 p-0" data-testid="task-scope">
            {scope.map((one) => (
              <ListItem key={JSON.stringify(one)} className="flex flex-wrap items-center gap-2 text-small" data-testid="task-scope-item" data-scope={scopeWords(one)} data-type={one.type}>
                <PlaceName place={places.get(JSON.stringify(one)) ?? { kind: one.type, label: scopeWords(one), where: null, href: null, path: null, words: scopeWords(one) }} />
                <Button type="button" variant="link" size="content" onClick={() => withScope(scope.filter((held) => JSON.stringify(held) !== JSON.stringify(one)))} data-testid="task-scope-remove">{t('loop.taskScopeRemove')}</Button>
              </ListItem>
            ))}
          </PlainList>
          {scope.length === 0 && <Paragraph className="m-0 text-small text-muted" data-testid="task-scope-empty">{t('loop.taskScopeEmpty')}</Paragraph>}
          <Stack className="mt-2 flex flex-wrap items-end gap-2">
            <FieldLabel className="grid gap-1 text-small">
              <Text>{t('loop.taskScopeAdd')}</Text>
              <Input value={adding} onChange={(event) => setAdding(event.target.value)} placeholder={t('loop.taskScopeAddPlaceholder')} data-testid="task-scope-add-input" className="w-72" />
            </FieldLabel>
            <Button variant="default" size="default" type="button" onClick={add} disabled={adding.trim() === ''} data-testid="task-scope-add">{t('loop.taskScopeAddButton')}</Button>
          </Stack>
          <SmallTitle className="mb-0 mt-4 text-base font-semibold">{t('loop.taskImpact')}</SmallTitle>
          {impact === null ? <Paragraph className="m-0 mt-1 text-small text-muted" data-testid="impact-none">{t('loop.taskImpactNone')}</Paragraph> : <ImpactList impact={impact} />}
          <Stack className="mt-4 flex flex-wrap gap-2">
            <Button variant="default" size="default" type="button" disabled={busy} onClick={confirm} data-testid="task-confirm">{t('loop.taskConfirm')}</Button>
          </Stack>
        </ReadingPanel>
      )}
      {refused !== null && <Paragraph className="m-0 mt-3 text-small" role="alert" data-testid="task-refused">{refused}</Paragraph>}
    </PageSection>
  );
}

/**
 * One confirmed task where its answer stands: its scope, what the change reaches, and «Поправить страницы сейчас» — a
 * run over exactly those pages — or «Позже, вместе с другими ответами», which runs nothing.
 */
/** One task's card away from its page: it reads the task, then draws the same body the task page draws. */
function TaskCard({ id, version, refresh }: { id: string; version: number; refresh: () => void }): ReactElement {
  const { t } = useTranslation();
  const { data: task, error } = useRead<TaskDetail>(`task:${id}`, version, (signal) => getTask(id, signal));
  if (task === null && error === null) return <PageSkeleton testId="task-loading" rows />;
  if (task === null) {
    return <Alert variant="problem" data-testid="task-error"><AlertTitle>{t('loop.taskPageTitle')}</AlertTitle><AlertDescription><Paragraph>{error}</Paragraph></AlertDescription></Alert>;
  }
  return <TaskBody task={task} refresh={refresh} />;
}

/** A confirmed task as both its page and its answer's page draw it: its impact, then the press that fixes the pages. */
function TaskBody({ task, refresh, headline = true }: { task: TaskDetail; refresh: () => void; headline?: boolean }): ReactElement {
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
    <ReadingPanel className="mt-6" data-testid="task-card" data-task={task.id} data-state={task.status}>
      {headline && (
        <Stack className="flex flex-wrap items-center gap-2">
          <KLink href={addressOfTask(task.id)} className="font-medium" data-testid="task-title-link">{task.title}</KLink>
          <Badge variant={task.status === 'open' ? 'solid' : 'outline'} data-testid="task-state">{task.status === 'open' ? t('loop.taskStateOpen') : t('loop.taskStateClosed')}</Badge>
          <Badge variant="outline" data-testid="task-marks">{t('loop.plannedChange')}</Badge>
        </Stack>
      )}
      <Paragraph className="mb-0 mt-1 flex flex-wrap items-center gap-x-3 text-small text-muted" data-testid="task-scope-words">{task.scope.map((one) => <PlaceName key={one.words} place={one.place} />)}</Paragraph>
      {task.closedBy !== null && (
        <Paragraph className="mb-0 mt-1 text-small text-muted" data-testid="task-closed-by">
          {'person' in task.closedBy
            ? t('loop.taskClosedByPerson', { when: whenWords(task.closedBy.at, language) })
            : t('loop.taskClosedByCommit', { commit: task.closedBy.commit.slice(0, 10), repository: task.closedBy.repository || t('knowledge.productRepository'), subject: task.closedBy.subject })}
        </Paragraph>
      )}
      {task.impact !== null && <ImpactList impact={task.impact} />}
      {task.problem !== undefined && <Paragraph className="m-0 mt-2 text-small" role="alert" data-testid="task-impact-problem">{task.problem}</Paragraph>}
      {task.status === 'open' && (
        <Stack className="mt-3 flex flex-wrap items-center gap-2">
          <Button variant="default" size="default" type="button" disabled={working || nothingToRun} onClick={run} data-testid="task-fix-now">{t('loop.refreshNow')}</Button>
          <Button variant="default" size="default" type="button" disabled={working} onClick={() => setSaid(t('loop.refreshDeferred'))} data-testid="task-fix-later">{t('loop.laterAnswers')}</Button>
          <Button type="button" variant="link" size="content" disabled={working} onClick={close} data-testid="task-close">{t('loop.taskClose')}</Button>
        </Stack>
      )}
      {nothingToRun && task.status === 'open' && <Paragraph className="m-0 mt-2 text-small text-muted" data-testid="task-nothing-to-run">{t('loop.refreshNothing')}</Paragraph>}
      {said !== null && <Paragraph className="m-0 mt-2 text-small" role="status" data-testid="task-said">{said}</Paragraph>}
      {refused !== null && <Paragraph className="m-0 mt-2 text-small" role="alert" data-testid="task-refused">{refused}</Paragraph>}
    </ReadingPanel>
  );
}

/** «Задачи»: every task of the product, open first, each with its scope and what its change reaches. */
export function TasksPage({ version }: { version: number }): ReactElement {
  const { t } = useTranslation();
  const { data, error } = useRead('tasks', version, (signal) => getTasks(signal));
  useTabTitle(t('loop.tasksTitle'));
  if (data === null && error === null) return <PageSkeleton testId="tasks-loading" rows />;
  if (data === null) return <Alert variant="problem" data-testid="tasks-error"><AlertTitle>{t('loop.tasksMissing')}</AlertTitle><AlertDescription><Paragraph>{error}</Paragraph></AlertDescription></Alert>;
  const groups = [
    { state: 'open' as const, heading: t('loop.openTasks', { count: data.open }), rows: data.tasks.filter((row) => row.status === 'open') },
    { state: 'closed' as const, heading: t('loop.closedTasks', { count: data.closed }), rows: data.tasks.filter((row) => row.status === 'closed') },
  ];
  return (
    <PageSection data-testid="tasks-page">
      <PageHeader className="mb-6">
        <PageTitle>{t('loop.tasksTitle')}</PageTitle>
        <Paragraph className="text-secondary" data-testid="tasks-intro">{t('loop.tasksIntro')}</Paragraph>
      </PageHeader>
      {data.problems.length > 0 && <Alert variant="problem" className="mb-6" data-testid="tasks-files"><AlertTitle>{t('loop.unreadableFiles')}</AlertTitle><AlertDescription><PlainList className="m-0 list-none p-0">{data.problems.map((line) => <ListItem key={line}><InlineCode>{line}</InlineCode></ListItem>)}</PlainList></AlertDescription></Alert>}
      {data.notes.length > 0 && <Alert className="mb-6" data-testid="tasks-notes"><AlertDescription><PlainList className="m-0 list-none p-0">{data.notes.map((note) => <ListItem key={note}>{note}</ListItem>)}</PlainList></AlertDescription></Alert>}
      {data.tasks.length === 0 && <Paragraph className="text-muted" data-testid="tasks-empty">{t('loop.noTasks')}</Paragraph>}
      {groups.map((group) => {
        if (group.rows.length === 0) return null;
        return (
          <PageSection key={group.state} className="mb-8" data-testid="tasks-group" data-state={group.state}>
            <SectionTitle>{group.heading}</SectionTitle>
            <PlainList className="m-0 list-none p-0">
              {group.rows.map((row) => (
                <ListItem key={row.id} className="border-b border-line py-3 last:border-b-0" data-testid="task-row" data-state={row.status} data-task={row.id}>
                  <Stack className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <KLink href={addressOfTask(row.id)} className="font-medium">{row.title}</KLink>
                    <Badge variant={row.status === 'open' ? 'solid' : 'outline'}>{row.status === 'open' ? t('loop.taskStateOpen') : t('loop.taskStateClosed')}</Badge>
                  </Stack>
                  <Paragraph className="mb-0 mt-1 flex flex-wrap items-center gap-x-3 text-small text-muted" data-testid="task-row-scope">{row.scope.map((one) => <PlaceName key={one.words} place={one.place} />)}</Paragraph>
                  {row.impact !== null && <Paragraph className="mb-0 mt-1 text-small text-muted" data-testid="task-row-impact">{t('loop.taskImpactPages', { count: row.impact.pages })} {t('loop.taskImpactStatements', { count: row.impact.statements })}</Paragraph>}
                  {row.closedBy !== null && !('person' in row.closedBy) && <Paragraph className="mb-0 mt-1 text-small text-muted">{t('loop.taskClosedByCommit', { commit: row.closedBy.commit.slice(0, 10), repository: row.closedBy.repository || t('knowledge.productRepository'), subject: row.closedBy.subject })}</Paragraph>}
                </ListItem>
              ))}
            </PlainList>
          </PageSection>
        );
      })}
    </PageSection>
  );
}

/** One task's page: its grounds, its scope, what the change reaches, and the way to fix the pages now or later. */
export function TaskPage({ id, version, refresh }: { id: string; version: number; refresh: () => void }): ReactElement {
  const { t } = useTranslation();
  const language = useLanguage();
  const { data: task, error } = useRead<TaskDetail>(`task:${id}`, version, (signal) => getTask(id, signal));
  useTabTitle(task?.title ?? (error !== null ? t('loop.tasksMissing') : null));
  if (task === null && error === null) return <PageSkeleton testId="task-page-loading" />;
  if (task === null) {
    return <Alert variant="problem" data-testid="task-page-error"><AlertTitle>{t('loop.tasksMissing')}</AlertTitle><AlertDescription><Paragraph>{error}</Paragraph></AlertDescription></Alert>;
  }
  const slug = task.question.startsWith('question:') ? task.question.slice('question:'.length) : task.question;
  const fromProblem = task.problemId !== undefined;
  return (
    <PageArticle data-testid="task-page" data-task={task.id} data-state={task.status}>
      <PageHeader className="mb-6">
        <Breadcrumb aria-label="trail" className="mb-2 flex flex-wrap items-center gap-x-2 text-small text-muted"><KLink href={WIKI_TASKS}>{t('loop.tasksTitle')}</KLink></Breadcrumb>
        <Stack className="mb-2 flex flex-wrap items-center gap-2">
          <Badge variant={task.status === 'open' ? 'solid' : 'outline'} data-testid="task-page-state">{task.status === 'open' ? t('loop.taskStateOpen') : t('loop.taskStateClosed')}</Badge>
          <InlineCode className="text-small text-muted">{task.file}</InlineCode>
        </Stack>
        <PageTitle data-testid="task-page-title">{task.title}</PageTitle>
        <Paragraph className="m-0 text-small text-muted">
          {fromProblem
            ? <Text data-testid="task-from-problem">{t('loop.taskFromProblem')}</Text>
            : <KLink href={addressOfQuestion(slug)}>{t('loop.taskFromAnswer', { title: slug })}</KLink>}
          {' · '}
          <AuthorLine by={task.by} at={task.at} />
        </Paragraph>
        {task.closedBy !== null && (
          <Paragraph className="mb-0 mt-1 text-small" data-testid="task-page-closed-by">
            {'person' in task.closedBy
              ? t('loop.taskClosedByPerson', { when: whenWords(task.closedBy.at, language) })
              : t('loop.taskClosedByCommit', { commit: task.closedBy.commit.slice(0, 10), repository: task.closedBy.repository || t('knowledge.productRepository'), subject: task.closedBy.subject })}
          </Paragraph>
        )}
      </PageHeader>
      <PageSection className="mb-6" data-testid="task-page-scope">
        <SectionTitle>{t('loop.taskScope')}</SectionTitle>
        <PlainList className="m-0 list-none p-0">
          {task.scope.map((one) => <ListItem key={JSON.stringify(one.scope)} className="py-0.5 text-small" data-testid="task-page-scope-item" data-type={one.scope.type}><PlaceName place={one.place} /></ListItem>)}
        </PlainList>
      </PageSection>
      <PageSection className="mb-6" data-testid="task-page-grounds">
        <SectionTitle>{t('loop.grounds')}</SectionTitle>
        <PlainList className="m-0 list-none p-0">
          {task.grounds.map((ground) => <ListItem key={ground} className="py-0.5 text-small"><InlineCode>{ground}</InlineCode></ListItem>)}
        </PlainList>
      </PageSection>
      <PageSection className="mb-6" data-testid="task-page-impact">
        <SectionTitle>{t('loop.taskImpact')}</SectionTitle>
        {task.impact === null
          ? <Paragraph className="m-0 text-small" role="alert">{task.problem ?? t('loop.taskImpactNone')}</Paragraph>
          : <ImpactList impact={task.impact} />}
        <Paragraph className="mb-0 mt-2 text-small text-muted" data-testid="task-page-marks">{t('loop.taskMarksSections', { count: task.marks.sections })}{t('loop.taskMarksStatements', { count: task.marks.statements })}{t('loop.taskMarksEntities', { count: task.marks.entities })}</Paragraph>
      </PageSection>
      {task.status === 'open' && <TaskBody task={task} refresh={refresh} headline={false} />}
    </PageArticle>
  );
}
