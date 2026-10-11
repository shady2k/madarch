/**
 * The open-questions view (docs/changes/open-questions, capability
 * product-wiki's requirement `open-questions`): the questions the product
 * carries in the set's form, open first with their state, then the closed
 * ones as a muted read. The set computes a question's state; the view invents
 * none: open, answered, and "Not applicable" are the set's words. A answered
 * question leaves the count, and stays readable here.
 *
 * Every visible string rides the i18n catalogues; the count follows the
 * selected language through Intl (the units' plural forms).
 */
import { useContext, useEffect, type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { CircleDashedIcon, CircleCheckIcon } from 'lucide-react';
import { relativeTime } from './i18n.js';
import type { QuestionEntry, QuestionList } from './api.js';
import { statusContext } from './hold.js';
import { PageLink } from './view.js';

/** One question row of the view: the question in one line, its state, its facts. */
function QuestionRow({ entry, closed }: { entry: QuestionEntry; closed: boolean }): ReactElement {
  const { t, i18n } = useTranslation();
  return (
    <li data-question-id={entry.id} data-question-state={entry.state}>
      <PageLink path={entry.path} className={'questions-row' + (closed ? ' questions-row-closed' : '')}>
        {closed
          ? <CircleCheckIcon aria-hidden="true" className="questions-row-icon" />
          : <CircleDashedIcon aria-hidden="true" className="questions-row-icon" />}
        <span className="questions-row-body">
          <span className="questions-row-title">{entry.title}</span>
          <span className="questions-row-meta">
            <span className={'questions-state questions-state-' + entry.state}>{t('questions.state.' + entry.state)}</span>
            {entry.who !== '' && <span className="questions-row-fact">{t('questions.who', { who: entry.who })}</span>}
            {entry.concerns.length > 0 && <span className="questions-row-fact">{t('questions.concerns', { concerns: entry.concerns.join(', ') })}</span>}
            {entry.changedAt !== undefined && (
              <span className="questions-row-fact">{t('document.changed', { when: relativeTime(entry.changedAt, i18n.resolvedLanguage) })}</span>
            )}
          </span>
          {closed && entry.answer !== undefined && <span className="questions-answer">{entry.answer}</span>}
        </span>
      </PageLink>
    </li>
  );
}

/**
 * The questions view the sidebar's count opens: its tagline, its open count,
 * the open questions on the navigation's row rhythm, and the closed ones —
 * answered or not applicable — muted, with their answers readable.
 */
export function QuestionsView({ questions }: { questions: QuestionList | null }): ReactElement {
  const { t } = useTranslation();
  const { publish } = useContext(statusContext);
  const openCount = questions === null ? 0 : questions.openCount;
  const countUnit = t('units.question', { count: openCount });
  useEffect(() => {
    if (questions === null) publish(null);
    else publish([
      t('questions.countLine', { count: openCount, unit: countUnit }),
      t('status.formatMarkdown'),
      t('status.formatUtf8'),
    ]);
    return () => publish(null);
  }, [publish, t, openCount, countUnit, questions]);
  if (questions === null) return <p className="loading">{t('loading.questions')}</p>;
  const open = questions.questions.filter((entry) => entry.state === 'open');
  const closed = questions.questions.filter((entry) => entry.state !== 'open');
  return (
    <main id="questions" data-testid="questions-view">
      <p className="eyebrow">{t('groups.questions')}</p>
      <h1 className="app-title">{t('questions.title')}</h1>
      <p className="home-lead" data-testid="questions-lead">{t('questions.tagline')}</p>
      <p className="questions-count" data-testid="questions-count">{t('questions.countLine', { count: openCount, unit: countUnit })}</p>
      {open.length === 0 ? (
        <p className="questions-none">{t('questions.none')}</p>
      ) : (
        <ul className="questions-rows">
          {open.map((entry) => <QuestionRow key={entry.id} entry={entry} closed={false} />)}
        </ul>
      )}
      {closed.length > 0 && (
        <section className="questions-closed" data-testid="questions-closed">
          <h2 className="questions-closed-heading">{t('questions.closedHeading')}</h2>
          <ul className="questions-rows">
            {closed.map((entry) => <QuestionRow key={entry.id} entry={entry} closed={true} />)}
          </ul>
        </section>
      )}
    </main>
  );
}
