/**
 * The Problems page (decision 0036, section 7; the old portal's page): the open findings the server computes from the
 * graph and the fill, grouped by rule, each saying what it needs, where it stands and — opened — its sentence, its
 * evidence and the two actions the retained routes offer: «Не проблема» and «Создать задачу». The server sends a
 * sentence code and its values, and the page says it in the reader's language (madarch-64o5.92); every action is a kit
 * Button (madarch-64o5.93). The sidebar's «Ждёт вас» count reads the same listing's open total.
 */
import { useState, type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, AlertDescription } from './ui/alert.js';
import { Badge } from './ui/badge.js';
import { Button } from './ui/button.js';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card.js';
import { Disclosure, DisclosureSummary } from './ui/disclosure.js';
import { InlineCode } from './ui/inline-content.js';
import { SegmentedChoice } from './ui/segmented-choice.js';
import { Textarea } from './ui/textarea.js';
import { FieldLabel, ListItem, Paragraph, PlainList, Stack, Text, TextLink } from './ui/typography.js';
import { dismissProblem, isOffline, makeProblemTask, readProblems, useChangeStream, useCommandRead, type Problem, type ProblemLink, type ProblemListing } from './command.js';
import type { SectionContext } from './types.js';

const message = (failure: unknown): string | null => isOffline(failure) ? null : failure instanceof Error ? failure.message : String(failure);

/** A place or entity the wiki can open; a source file's `/src` address is not a page of the new app, so its label stands. */
function Place({ link, base, open }: { readonly link: ProblemLink; readonly base: string; readonly open: (path: string) => void }): ReactElement {
  const address = link.href !== null && (/^\/e\/[^/:]+\/[^/]+$/u.test(link.href) || link.href.startsWith('/p/')) ? link.href : null;
  return address === null ? <InlineCode>{link.label}</InlineCode> : (
    <TextLink href={base + address} onClick={(event) => { event.preventDefault(); open(address); }}>{link.label}</TextLink>
  );
}

/**
 * One problem's sentence, in the reader's language, from the code the server sent and its values (madarch-64o5.92). A
 * code a locale lacks is said with the locale's own fallback, never as a key: the app's tests read both catalogues.
 */
function sentenceOf(problem: Problem, say: (key: string, values: Record<string, string | number>) => string): string {
  return say(`loop.problemText.${problem.text.code}`, problem.text.args ?? {});
}

/** One problem: what it is and where in its summary; opened, its sentence, evidence and the two actions. */
function ProblemRow({ problem, base, open, refresh, say }: {
  readonly problem: Problem;
  readonly base: string;
  readonly open: (path: string) => void;
  readonly refresh: () => void;
  readonly say: (key: string, values: Record<string, string | number>) => string;
}): ReactElement {
  const { t } = useTranslation();
  const [asking, setAsking] = useState(false);
  const [reason, setReason] = useState('');
  const [working, setWorking] = useState<'dismiss' | 'task' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const act = (): void => {
    setWorking('dismiss');
    setError(null);
    dismissProblem(base, problem.id, reason).then(
      () => { setWorking(null); setAsking(false); setDone(t('loop.problemDismissed')); refresh(); },
      (failure: unknown) => { setWorking(null); setError(message(failure)); },
    );
  };
  // A problem that already has its task opens it: the page never writes a second one (madarch-64o5.104).
  const task = (): void => {
    if (problem.task !== undefined && problem.task.href !== null) {
      open(problem.task.href);
      return;
    }
    setWorking('task');
    setError(null);
    makeProblemTask(base, problem.id).then(
      (answer) => {
        setWorking(null);
        if (answer.state === 'existing' && answer.task.href !== null) { open(answer.task.href); return; }
        setDone(t('loop.problemTaskCreated', { title: answer.task.label }));
        // The row now links to the task: the listing is read again so the page says «есть задача» at once.
        refresh();
      },
      (failure: unknown) => { setWorking(null); setError(message(failure)); },
    );
  };
  const sentence = problem.sentence ?? problem.statement;
  return (
    <Disclosure data-testid="problem-row" data-kind={problem.kind} data-rule={problem.rule}>
      <DisclosureSummary className="flex cursor-pointer flex-wrap items-center gap-x-3 gap-y-1 py-3" data-testid="problem-summary">
        <Text className="font-medium" data-testid="problem-rule">{t(`loop.rule.${problem.rule}`, { defaultValue: t(`loop.problem.${problem.kind}`, { defaultValue: problem.kind }) })}</Text>
        <Badge variant="outline" data-testid="problem-sonar">{t(`loop.sonar.${problem.sonar}`, { defaultValue: problem.sonar })}</Badge>
        <Badge variant={problem.severity === 'blocker' || problem.severity === 'critical' ? 'solid' : 'outline'} data-testid="problem-severity">{t(`loop.severity.${problem.severity}`, { defaultValue: problem.severity })}</Badge>
        <Badge variant="outline" data-testid="problem-needs">{t(`loop.needs.${problem.section}`)}</Badge>
        <InlineCode data-testid="problem-summary-place">{problem.place.label}</InlineCode>
      </DisclosureSummary>
      <Stack className="pb-3">
        <Paragraph className="mb-0 text-small" data-testid="problem-place">
          {t('loop.problemPlace')} <Place link={problem.place} base={base} open={open} />
          {problem.entity === null ? null : <>{t('common.separator')}{t('loop.problemEntity')} <Place link={problem.entity} base={base} open={open} /></>}
        </Paragraph>
        {sentence === null ? null : <Paragraph className="mb-0 mt-1.5 text-secondary" data-testid="problem-sentence">{t('common.quoted', { text: sentence })}</Paragraph>}
        <Paragraph className="mb-0 mt-1 text-small" data-testid="problem-text">{sentenceOf(problem, say)}</Paragraph>
        {problem.evidence.length === 0 ? null : (
          <Paragraph className="mb-0 mt-1 text-small text-muted" data-testid="problem-evidence">
            {t('loop.problemEvidence')} {problem.evidence.map((link, at) => <Text key={`${String(at)}:${link.label}`}>{at > 0 ? ' → ' : ''}<Place link={link} base={base} open={open} /></Text>)}
          </Paragraph>
        )}
        {problem.task === undefined ? null : (
          <Paragraph className="mb-0 mt-1 text-small" data-testid="problem-task">
            {t('loop.problemHasTask')} <Place link={problem.task} base={base} open={open} />
          </Paragraph>
        )}
        <Paragraph className="mb-0 mt-1 text-small text-muted">
          <InlineCode>{problem.file}{problem.line === null ? '' : `:${problem.line}`}</InlineCode>
          {problem.by === null || problem.at === null ? null : <Text>{t('common.separator')}{t('loop.by', { name: problem.by.name, email: problem.by.email })}</Text>}
        </Paragraph>
        <Stack className="mt-2 flex flex-wrap items-center gap-2">
          <Button size="default" disabled={working !== null} onClick={() => setAsking((held) => !held)} data-testid="problem-not-a-problem">{t('loop.problemNotAProblem')}</Button>
          <Button size="default" disabled={working !== null} onClick={task} data-testid="problem-create-task">{problem.task === undefined ? t('loop.problemCreateTask') : t('loop.problemOpenTask')}</Button>
          {done === null ? null : <Text className="text-small text-muted" data-testid="problem-done">{done}</Text>}
          {error === null ? null : <Text className="text-small" role="alert" data-testid="problem-action-error">{error}</Text>}
        </Stack>
        {asking ? (
          <Stack className="mt-2" data-testid="problem-dismiss">
            <FieldLabel className="block text-small">{t('loop.problemDismissPrompt')}
              <Textarea className="mt-1 w-full" rows={2} value={reason} onInput={(event) => setReason(event.currentTarget.value)} data-testid="problem-dismiss-reason" />
            </FieldLabel>
            <Stack className="mt-1 flex gap-2">
              <Button size="default" data-testid="problem-dismiss-confirm" disabled={working !== null || reason.trim() === ''} onClick={act}>{t('loop.problemDismissConfirm')}</Button>
              <Button size="default" onClick={() => setAsking(false)}>{t('loop.cancel')}</Button>
            </Stack>
          </Stack>
        ) : null}
      </Stack>
    </Disclosure>
  );
}

/** The Problems page. */
export function ProblemsSection({ context }: { readonly context: SectionContext }): ReactElement {
  const { t, i18n } = useTranslation();
  const language = context.language !== undefined && context.language !== '' ? context.language : (i18n.resolvedLanguage ?? 'en').startsWith('ru') ? 'ru' : 'en';
  const read = useCommandRead<ProblemListing>('problems', (signal) => readProblems(context.base, signal));
  useChangeStream(context.base, read.reload);
  const [section, setSection] = useState<string>('all');
  const listing = read.data;
  const say = (key: string, values: Record<string, string | number>): string => t(key, { ...values, defaultValue: '' });
  const filters = [
    { value: 'all', label: t('loop.problemFilterAll'), testId: 'problems-filter-all' },
    { value: 'code', label: t('loop.sectionCode'), testId: 'problems-filter-code' },
    { value: 'documents', label: t('loop.sectionDocuments'), testId: 'problems-filter-documents' },
    { value: 'wiki', label: t('loop.sectionWiki'), testId: 'problems-filter-wiki' },
  ];
  const selected = section === 'all' ? undefined : section;
  const categories = (listing?.categories ?? []).filter((category) => category.open > 0 && (selected === undefined || category.section === selected));
  return (
    <Stack className="grid gap-4" data-testid="problems-page">
      <Paragraph className="m-0 text-secondary" data-testid="problems-intro">{t('loop.problemsIntro')}</Paragraph>
      {read.error === null ? null : <Alert variant="problem" data-testid="problems-error"><AlertDescription>{read.error}</AlertDescription></Alert>}
      {listing?.notes.map((note) => <Alert key={note.message} data-testid="problems-note"><AlertDescription>{note.textKey === undefined ? note.message : t(`loop.problemNote.${note.textKey}`, { ...(note.textArgs ?? {}), defaultValue: note.message })}</AlertDescription></Alert>)}
      <Stack data-testid="problems-filters">
        <SegmentedChoice label={t('loop.problemFilterLabel')} testId="problems-filters-segments" value={section} options={filters.map((filter) => ({ value: filter.value, label: filter.label, testId: filter.testId }))} onChange={setSection} />
      </Stack>
      {listing === null ? null : <Paragraph className="m-0 text-secondary" data-testid="problems-total">{t('loop.problemCount', { count: listing.open, total: listing.open + listing.closed })}</Paragraph>}
      {listing === null ? null : categories.length === 0 ? <Paragraph className="text-muted" data-testid="problems-empty">{t('loop.noProblems')}</Paragraph> : (
        <Card>
          <CardHeader><CardTitle>{t('loop.problemsTitle')}</CardTitle></CardHeader>
          <CardContent>
            <PlainList className="m-0 grid list-none gap-0 p-0">
              {categories.map((category) => {
                const rows = listing.problems.filter((problem) => !problem.closed && problem.rule === category.rule && (selected === undefined || problem.section === selected));
                const meaning = t(`loop.ruleMeaning.${category.rule}`, { defaultValue: '' });
                return (
                  <ListItem key={category.rule} className="border-b border-line py-2 last:border-b-0">
                    <Disclosure data-testid="problem-category" data-rule={category.rule}>
                      <DisclosureSummary className="flex cursor-pointer flex-wrap items-center gap-x-3 gap-y-1">
                        <Text className="font-medium">{t(`loop.rule.${category.rule}`, { defaultValue: category.label?.[language] ?? category.rule })}</Text>
                        <Badge variant={category.severity === 'blocker' || category.severity === 'critical' ? 'solid' : 'outline'} data-testid="problem-category-severity">{t(`loop.severity.${category.severity}`, { defaultValue: category.severity })}</Badge>
                        <Text className="text-small text-secondary" data-testid="problem-category-needs">{t(`loop.needs.${category.section}`)}</Text>
                        <Text className="ml-auto font-medium" data-testid="problem-category-count">{rows.length}</Text>
                      </DisclosureSummary>
                      {meaning === '' ? null : <Paragraph className="mb-2 mt-1 text-small text-secondary" data-testid="problem-category-meaning">{meaning}</Paragraph>}
                      <PlainList className="m-0 list-none p-0">
                        {rows.map((problem) => (
                          <ProblemRow key={problem.id} problem={problem} base={context.base} open={context.open} refresh={read.reload} say={say} />
                        ))}
                      </PlainList>
                    </Disclosure>
                  </ListItem>
                );
              })}
            </PlainList>
          </CardContent>
        </Card>
      )}
      {listing !== null && listing.dismissed > 0 ? <Paragraph className="m-0 text-small text-muted" data-testid="problems-dismissed">{t('loop.problemDismissedCount', { count: listing.dismissed })}</Paragraph> : null}
    </Stack>
  );
}
