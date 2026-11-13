import { Textarea } from '@/components/ui/textarea.js';
import { Disclosure, DisclosureSummary } from '@/components/ui/disclosure.js';
import { InlineCode } from '@/components/ui/inline-content.js';
import { FieldLabel, ListItem, PageHeader, PageSection, PageTitle, Paragraph, PlainList, SectionTitle, Stack, Text } from '@/components/ui/typography.js';
/** Problems and refresh plans; questions and tasks use the ordinary kind pages. */
import { useEffect, useState, type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert.js';
import { Badge } from '@/components/ui/badge.js';
import { Button } from '@/components/ui/button.js';
import { dismissProblem, getProblemCategories, getProblemItems, getProblemSources } from './api.js';
import { KLink } from './blocks.js';
import { addressOfEntity } from './routes.js';
import { useRead } from './live.js';
import { useTabTitle } from './tabs.js';
import { PageSkeleton } from './skeleton.js';
import type { Author, Problem, ProblemCategory, ProblemSection, ProblemSource } from './types.js';

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

function ProblemLinkView({ link }: { link: NonNullable<Problem['place']> }): ReactElement {
  return link.href === null ? <InlineCode>{link.label}</InlineCode> : <KLink href={link.href}>{link.label}</KLink>;
}

function ProblemItem({ problem, refresh }: { problem: Problem; refresh: () => void }): ReactElement {
  const { t } = useTranslation();
  const [asking, setAsking] = useState(false);
  const [reason, setReason] = useState('');
  const [working, setWorking] = useState<boolean>(false);
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
  const act = (): void => {
    if (problem.id === undefined) return;
    setWorking(true);
    setError(null);
    const call = dismissProblem(problem.id, reason);
    call.then(() => {
      setWorking(false);
      setAsking(false);
      setDone(t('loop.problemDismissed'));
      refresh();
    }, (failure: unknown) => { setWorking(false); setError(message(failure)); });
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
          <Button size="default" variant="ghost" data-testid="problem-not-a-problem" disabled={working} onClick={() => setAsking((open) => !open)}>{t('loop.problemNotAProblem')}</Button>
          {done !== null && <Text className="text-small text-muted" data-testid="problem-done">{done}</Text>}
          {error !== null && <Text className="text-small" data-testid="problem-action-error">{error}</Text>}
        </Stack>
      )}
      {asking && problem.id !== undefined && (
        <Stack className="mt-2" data-testid="problem-dismiss">
          <FieldLabel className="block text-small" htmlFor={`dismiss-${problem.id}`}>{t('loop.problemDismissPrompt')}</FieldLabel>
          <Textarea id={`dismiss-${problem.id}`} data-testid="problem-dismiss-reason" className="mt-1 w-full" rows={2} value={reason} onChange={(event) => setReason(event.target.value)} />
          <Stack className="mt-1 flex gap-2">
            <Button size="default" data-testid="problem-dismiss-confirm" disabled={working || reason.trim() === ''} onClick={() => act()}>{t('loop.problemDismissConfirm')}</Button>
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
