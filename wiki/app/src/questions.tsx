/**
 * The questions view uses the product's configured form: open entries first,
 * then the answered or not-applicable entries in a muted read. The view
 * computes the configured state and writes nothing.
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
function QuestionRow({ entry, closed, answererLabel, concernsLabel }: { entry: QuestionEntry; closed: boolean; answererLabel?: string; concernsLabel?: string }): ReactElement {
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
            {entry.who !== '' && answererLabel !== undefined && <span className="questions-row-fact">{answererLabel}: {entry.who}</span>}
            {entry.concerns.length > 0 && concernsLabel !== undefined && <span className="questions-row-fact">{concernsLabel}: {entry.concerns.join(', ')}</span>}
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
 * the questions on the navigation's row rhythm, and the closed ones —
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
      <h1 className="app-title">{questions?.kindName ?? t('questions.title')}</h1>
      <p className="home-lead" data-testid="questions-lead">{t('questions.tagline')}</p>
      <p className="questions-count" data-testid="questions-count">{t('questions.countLine', { count: openCount, unit: countUnit })}</p>
      {open.length === 0 ? (
        <p className="questions-none">{t('questions.none')}</p>
      ) : (
        <ul className="questions-rows">
          {open.map((entry) => <QuestionRow key={entry.id} entry={entry} closed={false} answererLabel={questions.answererLabel} concernsLabel={questions.concernsLabel} />)}
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
