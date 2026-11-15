
/**
 * The Problems page (decision 0036, section 7; the old portal's page): the open findings the server computes from the
 * graph and the fill, grouped by rule, each with its place, its reason and the two actions the retained routes offer —
 * «Не проблема» and «Создать задачу». The sidebar's «Ждёт вас» count reads the same listing's open total.
 */
import { useState, type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, AlertDescription } from './ui/alert.js';
import { Badge } from './ui/badge.js';
import { Button } from './ui/button.js';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card.js';
import { Disclosure, DisclosureSummary } from './ui/disclosure.js';
import { InlineCode } from './ui/inline-content.js';
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

/** One problem: what it is, where, why, and the two actions. */
function ProblemRow({ problem, base, open, refresh }: {
  readonly problem: Problem;
  readonly base: string;
  readonly open: (path: string) => void;
  readonly refresh: () => void;
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
    <ListItem className="border-b border-line py-3 last:border-b-0" data-testid="problem-row" data-kind={problem.kind} data-rule={problem.rule}>
      <Stack className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Text className="font-medium" data-testid="problem-rule">{t(`loop.rule.${problem.rule}`, { defaultValue: t(`loop.problem.${problem.kind}`, { defaultValue: problem.kind }) })}</Text>
        <Badge variant="outline" data-testid="problem-sonar">{t(`loop.sonar.${problem.sonar}`, { defaultValue: problem.sonar })}</Badge>
        <Badge variant={problem.severity === 'blocker' || problem.severity === 'critical' ? 'solid' : 'outline'} data-testid="problem-severity">{t(`loop.severity.${problem.severity}`, { defaultValue: problem.severity })}</Badge>
        <Badge variant={problem.fixer === 'agent' ? 'outline' : 'solid'} data-testid="problem-fixer">{t(`loop.fixer.${problem.fixer}`, { defaultValue: problem.fixer })}</Badge>
      </Stack>
      <Paragraph className="mb-0 mt-1.5 text-small" data-testid="problem-place">
        {t('loop.problemPlace')} <Place link={problem.place} base={base} open={open} />
        {problem.entity === null ? null : <> · {t('loop.problemEntity')} <Place link={problem.entity} base={base} open={open} /></>}
      </Paragraph>
      {sentence === null ? null : <Paragraph className="mb-0 mt-1.5 text-secondary" data-testid="problem-sentence">«{sentence}»</Paragraph>}
      <Paragraph className="mb-0 mt-1 text-small" data-testid="problem-reason">{problem.reason}</Paragraph>
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
        {problem.by === null || problem.at === null ? null : <Text> · {t('loop.by', { name: problem.by.name, email: problem.by.email })}</Text>}
      </Paragraph>
      <Stack className="mt-2 flex flex-wrap items-center gap-2">
        <Button size="default" variant="ghost" disabled={working !== null} onClick={() => setAsking((held) => !held)} data-testid="problem-not-a-problem">{t('loop.problemNotAProblem')}</Button>
        <Button size="default" variant="ghost" disabled={working !== null} onClick={task} data-testid="problem-create-task">{problem.task === undefined ? t('loop.problemCreateTask') : t('loop.problemOpenTask')}</Button>
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
            <Button size="default" variant="ghost" onClick={() => setAsking(false)}>{t('loop.cancel')}</Button>
          </Stack>
        </Stack>
      ) : null}
    </ListItem>
  );
}

/** The Problems page. */
export function ProblemsSection({ context }: { readonly context: SectionContext }): ReactElement {
  const { t, i18n } = useTranslation();
  const language = context.language !== undefined && context.language !== '' ? context.language : (i18n.resolvedLanguage ?? 'en').startsWith('ru') ? 'ru' : 'en';
  const read = useCommandRead<ProblemListing>('problems', (signal) => readProblems(context.base, signal));
  useChangeStream(context.base, read.reload);
  const [section, setSection] = useState<string | undefined>(undefined);
  const listing = read.data;
  const filters = [
    { key: 'all', label: t('loop.problemFilterAll'), section: undefined },
    { key: 'code', label: t('loop.sectionCode'), section: 'code' },
    { key: 'documents', label: t('loop.sectionDocuments'), section: 'documents' },
    { key: 'wiki', label: t('loop.sectionWiki'), section: 'wiki' },
  ];
  const categories = (listing?.categories ?? []).filter((category) => category.open > 0 && (section === undefined || category.section === section));
  return (
    <Stack className="grid gap-4" data-testid="problems-page">
      <Paragraph className="m-0 text-secondary" data-testid="problems-intro">{t('loop.problemsIntro')}</Paragraph>
      {read.error === null ? null : <Alert variant="problem" data-testid="problems-error"><AlertDescription>{read.error}</AlertDescription></Alert>}
      {listing?.notes.map((note) => <Alert key={note.message} data-testid="problems-note"><AlertDescription>{note.textKey === undefined ? note.message : t(`loop.problemNote.${note.textKey}`, { ...(note.textArgs ?? {}), defaultValue: note.message })}</AlertDescription></Alert>)}
      <Stack className="flex flex-wrap items-center gap-2" data-testid="problems-filters">
        {filters.map((filter) => (
          <Button key={filter.key} size="default" variant={section === filter.section ? 'default' : 'ghost'} data-testid={`problems-filter-${filter.key}`} onClick={() => setSection(filter.section)}>{filter.label}</Button>
        ))}
      </Stack>
      {listing === null ? null : <Paragraph className="m-0 text-secondary" data-testid="problems-total">{t('loop.problemCount', { count: listing.open, total: listing.open + listing.closed })}</Paragraph>}
      {listing === null ? null : categories.length === 0 ? <Paragraph className="text-muted" data-testid="problems-empty">{t('loop.noProblems')}</Paragraph> : (
        <Card>
          <CardHeader><CardTitle>{t('loop.problemsTitle')}</CardTitle></CardHeader>
          <CardContent>
            <PlainList className="m-0 grid list-none gap-0 p-0">
              {categories.map((category) => {
                const rows = listing.problems.filter((problem) => !problem.closed && problem.rule === category.rule && (section === undefined || problem.section === section));
                const meaning = t(`loop.ruleMeaning.${category.rule}`, { defaultValue: '' });
                return (
                  <ListItem key={category.rule} className="border-b border-line py-2 last:border-b-0">
                    <Disclosure data-testid="problem-category" data-rule={category.rule}>
                      <DisclosureSummary className="flex cursor-pointer flex-wrap items-center gap-x-3 gap-y-1">
                        <Text className="font-medium">{t(`loop.rule.${category.rule}`, { defaultValue: category.label?.[language] ?? category.rule })}</Text>
                        <Badge variant={category.severity === 'blocker' || category.severity === 'critical' ? 'solid' : 'outline'} data-testid="problem-category-severity">{t(`loop.severity.${category.severity}`, { defaultValue: category.severity })}</Badge>
                        <Text className="text-small text-secondary">{t(`loop.fixer.${category.fixer}`, { defaultValue: category.fixer })}</Text>
                        <Text className="ml-auto font-medium" data-testid="problem-category-count">{rows.length}</Text>
                      </DisclosureSummary>
                      {meaning === '' ? null : <Paragraph className="mb-2 mt-1 text-small text-secondary" data-testid="problem-category-meaning">{meaning}</Paragraph>}
                      <PlainList className="m-0 list-none p-0">
                        {rows.map((problem) => (
                          <ProblemRow key={problem.id} problem={problem} base={context.base} open={context.open} refresh={read.reload} />
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
