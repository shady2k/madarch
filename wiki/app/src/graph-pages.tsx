/**
 * The graph's pages as a reader sees them (madarch-tzte.23.3; decision 0026,
 * "Pages"): the index of every page-worthy node, and one node's page — its facts
 * with links into code, the assumptions kept apart from them, its relations as links
 * to the pages of the nodes they join, the coverage of its scopes, its open
 * questions, and the drafts another unit holds, each marked as a draft.
 *
 * Everything shown here is what the server answered (`src/fill/graph-pages.ts` reads
 * it from the fact store): the app adds no statement of its own. A fact's layer and
 * status are shown as words (decision 0005 makes an agent's reading `inferred` and a
 * person's `declared`), and an assumption stands in its own section — never mixed in
 * with the facts.
 *
 * The diagrams of a node stand in the slot this page keeps for them (madarch-tzte.23.4
 * renders the view specifications madarch-tzte.23.2 builds); the slot names what will
 * stand there rather than drawing an empty frame.
 */
import { useContext, useEffect, useMemo, useRef, useState, type FormEvent, type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { CircleCheckIcon, CircleDashedIcon, FileCode2Icon, LightbulbIcon } from 'lucide-react';
import { appPath } from './app-base.js';
import {
  postGraphAnswer,
  postGraphDecision,
  type GraphAnswerRecord,
  type GraphCoverageRow,
  type GraphDecisionAnswer,
  type GraphDraftRow,
  type GraphNarrative,
  type GraphNarrativeSentence,
  type GraphNextStep,
  type GraphPageEntry,
  type GraphPageFact,
  type GraphPageListEntry,
  type GraphPageModel,
  type GraphPageSet,
  type GraphQuestionEntry,
  type GraphQuestionSet,
  type GraphRelation,
  type RepoEntry,
} from './api.js';
import { navigateTo, statusContext } from './hold.js';
import { codeHref, codePlace, graphKindGroups, originOf, type GraphKindGroup } from './graph.js';
import { addressOfGraphPage } from './routes.js';
import { GraphDiagramsSection } from './graph-diagrams.js';

/** A graph page's own link, followed on the client side like every page of the app. */
function GraphLink({ id, address: given, children, className }: { id: string; address?: string; children: React.ReactNode; className?: string }): ReactElement {
  // The address is the server's own when it named one (`GraphNodeRef.page`, the address
  // it hands out) and the app's own otherwise — one address either way. `PageLink`
  // reads a document path, so the link is made here and the history is moved the way
  // the app moves it.
  const address = appPath(given ?? addressOfGraphPage(id));
  return (
    <a
      href={address}
      className={className}
      onClick={(event) => {
        if (event.shiftKey || event.ctrlKey || event.metaKey || event.altKey || event.button !== 0) return;
        event.preventDefault();
        navigateTo(address);
      }}
    >
      {children}
    </a>
  );
}

/** The word a fact's layer reads as: what it was obtained from (decision 0005). */
function layerWord(layer: string, t: (key: string, options?: { defaultValue: string }) => string): string {
  return t('graph.layer.' + layer, { defaultValue: layer });
}

/** The word a fact's status reads as: where a person's acceptance stands (decision 0005). */
function statusWord(status: string, t: (key: string, options?: { defaultValue: string }) => string): string {
  return t('graph.status.' + status, { defaultValue: status });
}

/** Where a fact stands in code: the place, linked to its repository's host when the manifest declares one. */
function CodePlace({ code, repos }: { code: GraphPageFact['code']; repos: readonly RepoEntry[] }): ReactElement | null {
  const { t } = useTranslation();
  if (code === undefined) return null;
  const href = codeHref(code, repos);
  const place = `${code.repository} · ${codePlace(code)}`;
  if (href === undefined) {
    return (
      <span className="graph-place" data-testid="graph-place" title={t('graph.noOrigin', { repository: code.repository })}>
        <FileCode2Icon aria-hidden="true" className="graph-place-icon" />
        <span>{place}</span>
      </span>
    );
  }
  return (
    <a className="graph-place" data-testid="graph-place" href={href} target="_blank" rel="noreferrer noopener" title={`${place} @ ${code.commit}`}>
      <FileCode2Icon aria-hidden="true" className="graph-place-icon" />
      <span>{place}</span>
    </a>
  );
}

/** One fact row: what it says, how it was obtained, where it stands, and what a claim names. */
function FactRow({ fact, repos }: { fact: GraphPageFact; repos: readonly RepoEntry[] }): ReactElement {
  const { t } = useTranslation();
  return (
    <li className="graph-fact" data-fact={fact.id} data-layer={fact.layer} data-status={fact.status}>
      <div className="graph-fact-head">
        <span className="graph-fact-label">{fact.label}</span>
        <span className="graph-fact-kind">{fact.kind}</span>
      </div>
      <div className="graph-fact-meta">
        <span className="graph-chip" data-testid="graph-fact-layer">{layerWord(fact.layer, t)}</span>
        <span className="graph-chip" data-testid="graph-fact-status">{statusWord(fact.status, t)}</span>
        <CodePlace code={fact.code} repos={repos} />
      </div>
      {fact.ends !== undefined && (
        <p className="graph-fact-ends">
          {fact.ends.subject !== undefined && (
            <span data-testid="graph-claim-subject">
              {fact.ends.subject.page !== undefined ? <GraphLink id={fact.ends.subject.id} address={fact.ends.subject.page}>{fact.ends.subject.label}</GraphLink> : fact.ends.subject.label}
            </span>
          )}
          {fact.ends.subject !== undefined && fact.ends.object !== undefined && <span aria-hidden="true"> → </span>}
          {fact.ends.object !== undefined && (
            <span data-testid="graph-claim-object">
              {fact.ends.object.page !== undefined ? <GraphLink id={fact.ends.object.id} address={fact.ends.object.page}>{fact.ends.object.label}</GraphLink> : fact.ends.object.label}
            </span>
          )}
        </p>
      )}
    </li>
  );
}

/** One relation row: the edge, the direction, and the page of the node at its other end. */
function RelationRow({ relation, repos }: { relation: GraphRelation; repos: readonly RepoEntry[] }): ReactElement {
  const { t } = useTranslation();
  return (
    <li className="graph-relation" data-edge={relation.edge.id} data-edge-kind={relation.edge.kind} data-direction={relation.direction}>
      <span className="graph-relation-kind">{relation.edge.kind}</span>
      {/* The direction is a word for a reader who hears the page, and an arrow for one who
        * sees it: a `both` relation points each way at once. */}
      <span className="graph-relation-arrow" title={t('graph.direction.' + relation.direction)} aria-hidden="true">
        {relation.direction === 'in' ? '←' : relation.direction === 'both' ? '↔' : '→'}
      </span>
      <span className="sr-only">{t('graph.direction.' + relation.direction)}</span>
      {relation.node !== undefined ? (
        relation.node.page !== undefined ? (
          <GraphLink id={relation.node.id} address={relation.node.page} className="graph-relation-node">{relation.node.label}</GraphLink>
        ) : (
          <span className="graph-relation-node" data-testid="graph-relation-unpaged">{relation.node.label}</span>
        )
      ) : (
        <span className="graph-relation-end" data-testid="graph-relation-end">{relation.end ?? relation.edge.label}</span>
      )}
      <span className="graph-chip" data-testid="graph-relation-layer">{layerWord(relation.edge.layer, t)}</span>
      <CodePlace code={relation.edge.code} repos={repos} />
    </li>
  );
}

/** One coverage row: what was read of a scope, what could not be, and whether the scope is whole. */
function CoverageRow({ row }: { row: GraphCoverageRow }): ReactElement {
  const { t } = useTranslation();
  return (
    <li className="graph-coverage" data-scope={row.scope} data-complete={row.complete ? 'true' : 'false'}>
      <div className="graph-coverage-head">
        <code className="graph-coverage-scope">{row.scope}</code>
        <span className="graph-chip" data-testid="graph-coverage-state">{row.complete ? t('graph.coverageComplete') : t('graph.coverageGap')}</span>
        <span className="graph-coverage-count">{t('graph.coverageRead', { count: row.readCount })}</span>
      </div>
      {row.read.length > 0 && (
        <ul className="graph-coverage-list">
          {row.read.map((entry) => <li key={entry}><code>{entry}</code></li>)}
        </ul>
      )}
      {row.readCut > 0 && <p className="graph-cut">{t('graph.coverageReadCut', { count: row.readCut })}</p>}
      {row.unread.length > 0 && (
        <div className="graph-coverage-gaps" data-testid="graph-coverage-gaps">
          <h3>{t('graph.coverageUnread')}</h3>
          <ul>
            {row.unread.map((gap) => <li key={gap.what}><code>{gap.what}</code> — {t('graph.coverageGapReason', { reason: gap.reason })}</li>)}
          </ul>
          {row.unreadCut > 0 && <p className="graph-cut">{t('graph.coverageUnreadCut', { count: row.unreadCut })}</p>}
        </div>
      )}
    </li>
  );
}

/** One question of the node: its type, what depends on the answer, and the answer or the form that answers it. */
function QuestionRow({ question, onAnswered }: { question: GraphQuestionEntry; onAnswered?: (answer: GraphDecisionAnswer) => void }): ReactElement {
  const { t } = useTranslation();
  return (
    <li className="graph-question" data-question={question.id} data-open={(question.open ?? true) ? 'true' : 'false'}>
      <GraphLink id={question.id} address={addressOfGraphPage(question.id)} className="graph-question-prompt">{question.prompt}</GraphLink>
      <span className="graph-chip">{t('graph.questionType.' + question.type, { defaultValue: question.type })}</span>
      <span className="graph-chip">{layerWord(question.layer, t)}</span>
      <span className="graph-chip" data-testid="graph-question-rank">{t('graph.questionRank', { count: question.rank ?? 0 })}</span>
      {(question.dependsOn ?? []).length > 0 && (
        <span className="graph-question-depends" data-testid="graph-question-depends">
          {t('graph.questionDependsOn')}{' '}
          {(question.dependsOn ?? []).map((node, at) => (
            <span key={node.id}>
              {at > 0 && ', '}
              {node.page !== undefined ? <GraphLink id={node.id} address={node.page}>{node.label}</GraphLink> : node.label}
            </span>
          ))}
        </span>
      )}
      <QuestionAnswerForm question={question} onAnswered={onAnswered} />
    </li>
  );
}

/** One draft write: marked as a draft, naming the unit that holds it and what it cites. */
function DraftRow({ draft }: { draft: GraphDraftRow }): ReactElement {
  const { t } = useTranslation();
  const value = draft.fact as { kind?: unknown; value?: unknown } | null;
  const kind = value !== null && typeof value === 'object' && typeof value.kind === 'string' ? value.kind : draft.write;
  const label = value !== null && typeof value === 'object' && typeof (value as { label?: unknown }).label === 'string' ? (value as { label: string }).label : undefined;
  return (
    <li className="graph-draft" data-unit={draft.unit} data-generation={draft.generation}>
      <span className="graph-chip graph-chip-draft" data-testid="graph-draft-mark">{t('graph.draftMark')}</span>
      <span className="graph-draft-kind">{kind}</span>
      {label !== undefined && <span className="graph-draft-label">{label}</span>}
      <span className="graph-draft-unit">{t('graph.draftHeldBy', { unit: draft.unit, generation: draft.generation })}</span>
      <code className="graph-draft-evidence">{draft.evidence}</code>
    </li>
  );
}

/** One sentence of the narrative layer: the words, the facts it stands on, and its staleness. */
function NarrativeSentenceRow({ sentence }: { sentence: GraphNarrativeSentence }): ReactElement {
  const { t } = useTranslation();
  return (
    <li className="graph-narrative-sentence" data-testid="graph-narrative-sentence" data-stale={sentence.stale ? 'true' : 'false'}>
      <span className="graph-narrative-text">{sentence.text}</span>
      {sentence.stale && <span className="graph-chip graph-chip-stale" data-testid="graph-narrative-sentence-stale">{t('graph.narrativeSentenceStale')}</span>}
      <ul className="graph-narrative-facts">
        {sentence.facts.map((id) => <li key={id}><code>{id}</code></li>)}
      </ul>
    </li>
  );
}

/**
 * The page's narrative layer (decision 0026, "Pages"; madarch-tzte.25.1): the text an
 * agent wrote about this node, shown as a layer above the graph-rendered facts, marked
 * unverified — it is a proposal in the product's git (`status: proposed`), never a
 * statement the graph asserts. A stale page says so: the unit that wrote it was
 * replanned, and a new text is on its way; a sentence whose facts stand in the graph
 * no more is marked by itself.
 */
export function GraphNarrativeSection({ narrative }: { narrative: GraphNarrative }): ReactElement {
  const { t } = useTranslation();
  return (
    <section className="graph-narrative" data-testid="graph-narrative" aria-labelledby="graph-narrative-title">
      <h2 id="graph-narrative-title">{t('graph.narrativeTitle')}</h2>
      <p className="graph-note" data-testid="graph-narrative-badge">
        <span className="graph-chip graph-chip-unverified">{t('graph.narrativeUnverified')}</span>
        {' '}{t('graph.narrativeNote')}
      </p>
      {narrative.stale && (
        <p className="graph-cut" role="status" data-testid="graph-narrative-stale">{t('graph.narrativeStale')}</p>
      )}
      <ul className="graph-narrative-list">
        {narrative.sentences.map((sentence, at) => <NarrativeSentenceRow key={`${at}-${sentence.text}`} sentence={sentence} />)}
      </ul>
    </section>
  );
}

/**
 * How many of one kind's rows the index draws (madarch-tzte.23.8).
 *
 * The index is the one page that draws every page-worthy node, and the current madarch
 * tree holds 35 370 of them: drawing them holds the browser for seconds — measured, the
 * index stood in 4 137 ms cold and 4 987 ms warm with 142 180 nodes drawn — and the rows
 * are not what a person reads first. So a kind's group draws the first of its rows —
 * `INDEX_ROWS_SHOWN` of them — and says in its own words how many the kind holds and how
 * many of them stand: the count in the header is the whole count from the first paint, so
 * a list shorter than the kind is never silent about it. Every page the graph holds is
 * still in the page set the app reads, in the navigation's per-kind list, and reachable by
 * its address; and a page the graph gains while this tab holds the index draws whatever
 * the window would hide of it, marked as an arrival, so a page appears on the index as
 * facts arrive (madarch-tzte.23) on a graph of any size. Listing tens of thousands of rows
 * at once is a later task's (a search or a windowed list), named in the change record.
 */
export const INDEX_ROWS_SHOWN = 150;

/** One kind's group of the index: its header, its whole count, the rows this page draws and how many it does not. */
function GraphKindSection({ group, arrived, shown: rowsShown }: { group: GraphKindGroup; arrived: readonly GraphPageListEntry[]; shown: number }): ReactElement {
  const { t } = useTranslation();
  // The window draws the bound's rows of the kind's own order; the pages the graph gained
  // while this tab held the index draw before them, marked as arrivals, and the rows this
  // group draws stay at the page's bound (madarch-tzte.23.8's measured bound). An arrival
  // the window already holds draws once, in its own place, not twice.
  const windowRows = Math.max(0, rowsShown - Math.min(arrived.length, rowsShown));
  const entries = group.entries.slice(0, windowRows);
  const windowIds = new Set(entries.map((entry) => entry.id));
  const fresh = arrived.filter((entry) => !windowIds.has(entry.id));
  const shown = Math.min(entries.length, rowsShown);
  return (
    <section data-graph-kind={group.kind} className="home-group mt-7 first:mt-0">
      <header className="home-group-head">
        <h2 className="text-ink">{t('graph.kind.' + group.kind, { defaultValue: group.kind })}</h2>
        <span className="home-count" data-testid="graph-kind-count">{group.entries.length}</span>
      </header>
      <ul className="home-rows">
        {fresh.map((entry) => (
          <li key={entry.id} data-arrived="true">
            <GraphLink id={entry.id} className="home-row">
              <span className="home-row-title">{entry.label}</span>
              <span className="graph-chip" data-testid="graph-row-new">{t('graph.rowNew')}</span>
              <span className="graph-chip">{layerWord(entry.layer, t)}</span>
            </GraphLink>
          </li>
        ))}
        {entries.map((entry) => (
          <li key={entry.id}>
            <GraphLink id={entry.id} className="home-row">
              <span className="home-row-title">{entry.label}</span>
              <span className="graph-chip">{layerWord(entry.layer, t)}</span>
            </GraphLink>
          </li>
        ))}
      </ul>
      {/* A group the page does not draw whole says so, in its own words: this index lists the first of its kind. */}
      {shown < group.entries.length && (
        <p className="graph-note" data-testid="graph-kind-listing" data-shown={shown}>
          {t('graph.listingRest', { shown, count: group.entries.length })}
        </p>
      )}
    </section>
  );
}

/**
 * The graph's index: every page-worthy node of the product, one group per kind with
 * the kind's count, each node a link to its page. An empty graph shows the server's
 * own what-to-do message: the fill writes the pages, and they appear as its units
 * publish.
 */
export function GraphIndexPage({ set, repos, rowsShown = INDEX_ROWS_SHOWN }: {
  set: GraphPageSet;
  repos: readonly RepoEntry[];
  /** How many of a kind's rows the page draws: the page's own bound, overridable for a test. */
  rowsShown?: number;
}): ReactElement {
  const { t } = useTranslation();
  const { publish } = useContext(statusContext);
  const groups = graphKindGroups(set);
  // The pages this tab has already drawn, or null before its first set. A page the graph
  // gains while the reader holds the index is an arrival, and the index draws it even when
  // it sorts beyond the window this page draws by default: a page that appears as facts
  // arrive is the stage's own criterion (madarch-tzte.23), and a count alone does not show
  // one — the kind's header counts the whole kind, not its newest page.
  const seen = useRef<ReadonlySet<string> | null>(null);
  const [drawn, setDrawn] = useState<ReadonlySet<string> | null>(null);
  useEffect(() => {
    setDrawn(seen.current);
  }, [set]);
  const arrivals = useMemo(() => {
    const fresh = new Map<string, GraphPageListEntry[]>();
    if (drawn === null) return fresh;
    for (const entry of set.pages) {
      if (drawn.has(entry.id)) continue;
      const held = fresh.get(entry.kind);
      if (held === undefined) fresh.set(entry.kind, [entry]);
      else held.push(entry);
    }
    // The arrivals a kind draws are bounded by this page's own window, the newest kept, so
    // the index draws no more rows after an arrival than it did before one.
    for (const [kind, entries] of fresh) {
      if (entries.length > rowsShown) fresh.set(kind, entries.slice(-rowsShown));
    }
    return fresh;
  }, [set, rowsShown, drawn]);
  useEffect(() => {
    seen.current = new Set(set.pages.map((entry) => entry.id));
  }, [set]);
  useEffect(() => {
    publish([t('graph.nodesCount', { count: set.total })]);
    return () => publish(null);
  }, [publish, set.total, t]);
  return (
    <main id="graph" data-testid="graph-index">
      <div className="document-meta eyebrow">
        <strong className="eyebrow-kind">{t('graph.title')}</strong>
        <span className="eyebrow-dot" aria-hidden="true">•</span>
        <span className="eyebrow-secondary">{t('graph.live')}</span>
      </div>
      <h1 className="app-title">{t('graph.title')}</h1>
      <p className="home-lead" data-testid="graph-lead">{t('graph.lead', { product: set.product, count: set.total })}</p>
      {/* What the product recommends next, decided from the graph: its most asked open question, else the most
        * important node no coverage reached (the charter's outcome 5). */}
      {set.nextStep !== undefined && <NextStepSection step={set.nextStep} />}

      {/* The product's questions, grouped by the charter's types: the pages they concern are one link away, and the
        * answer a person gives writes Markdown into the product's git. */}
      {set.questions !== undefined && <GraphQuestionsSection questions={set.questions} />}

      {/* The server's message is in its own words and the app does not rewrite it: it is
        * the what-to-do, quoted with the language of the chrome around it. */}
      {set.total === 0 ? (
        <p className="graph-empty" data-testid="graph-empty">{set.message === null ? t('graph.empty', { product: set.product }) : t('graph.serverSays', { message: set.message })}</p>
      ) : (
        <div className="home-groups">
          {groups.map((group) => (
            <GraphKindSection key={group.kind} group={group} arrived={arrivals.get(group.kind) ?? []} shown={rowsShown} />
          ))}
        </div>
      )}
    </main>
  );
}

/** The one step a page recommends, as the server read it from the graph (the self-filling charter's outcome 5). */
export function NextStepSection({ step }: { step: GraphNextStep }): ReactElement {
  const { t } = useTranslation();
  // A step is one sentence the server wrote from the graph, and the app adds no statement of its own about what waits:
  // it says what the rule is in the reader's language, and lifts the server's own words for the reason.
  const action = step.rule === 'answer-question'
    ? t('graph.nextStep.answerQuestion', { prompt: step.question?.prompt ?? '' })
    : step.rule === 'cover-node' ? t('graph.nextStep.coverNode', { label: step.node.label })
      : step.rule === 'review-assumption' ? t('graph.nextStep.reviewAssumption', { label: step.node.label })
        : t('graph.nextStep.nothing');
  return (
    <section className="graph-next-step" data-testid="graph-next-step" data-rule={step.rule} aria-label={t('graph.nextStep.title')}>
      <p className="graph-next-step-label">
        <LightbulbIcon aria-hidden="true" className="graph-next-step-icon" />
        {t('graph.nextStep.title')}
      </p>
      <p className="graph-next-step-action" data-testid="graph-next-step-action">{action}</p>
      <p className="graph-next-step-reason">{step.reason}</p>
      {step.rule === 'answer-question' && step.question !== undefined && (
        <GraphLink id={step.question.id} address={step.question.page} className="graph-next-step-link">
          {t('graph.nextStep.openQuestion')}
        </GraphLink>
      )}
    </section>
  );
}

/**
 * Answering one open question where a reader meets it (the self-filling charter's outcome 5):
 * the person's words are posted to the graph, which writes them into the product's git and
 * reads them back. A question that is already closed shows its answer instead — a person's
 * words, or an agent's finding with the evidence it read.
 */
export function QuestionAnswerForm({ question, onAnswered = () => undefined }: { question: GraphQuestionEntry; onAnswered?: (answer: GraphDecisionAnswer) => void }): ReactElement {
  const { t } = useTranslation();
  const [answer, setAnswer] = useState('');
  const [by, setBy] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [filed, setFiled] = useState<GraphDecisionAnswer | null>(null);
  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const wrote = await postGraphAnswer(question.id, answer, by);
      setAnswer('');
      setFiled(wrote);
      onAnswered(wrote);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  };
  const held = question.answer ?? null;
  if (held !== null) {
    return <QuestionAnswer answer={held} />;
  }
  if (filed !== null) {
    return <p className="graph-question-filed" role="status" data-testid="graph-question-filed">{t('graph.decision.filed', { file: filed.file })}</p>;
  }
  return (
    <form className="graph-answer-form" data-testid="graph-answer-form" onSubmit={(event) => void submit(event)}>
      <label>
        {t('graph.decision.answerLabel')}
        <textarea value={answer} onChange={(event) => setAnswer(event.currentTarget.value)} required maxLength={20_000} rows={3} />
      </label>
      <label>
        {t('graph.decision.byLabel')}
        <input value={by} onChange={(event) => setBy(event.currentTarget.value)} maxLength={200} placeholder={t('graph.decision.byPlaceholder')} />
      </label>
      <button type="submit" disabled={saving || answer.trim() === ''}>{t('graph.decision.answerSubmit')}</button>
      {error !== null && <p role="alert" className="graph-answer-error">{error}</p>}
    </form>
  );
}

/** One answer as a reader sees it: what it says, who wrote it, and — an agent's — where it read it. */
export function QuestionAnswer({ answer }: { answer: GraphAnswerRecord }): ReactElement {
  const { t } = useTranslation();
  return (
    <div className="graph-answer" data-testid="graph-answer" data-decision={answer.decision}>
      <span className="graph-chip" data-testid="graph-answer-layer">{layerWord(answer.layer, t)}</span>
      <span className="graph-chip" data-testid="graph-answer-by">{t('graph.decision.by', { by: answer.by })}</span>
      <p className="graph-answer-text">{answer.text}</p>
      {answer.evidence !== undefined && <code className="graph-answer-evidence" data-testid="graph-answer-evidence">{answer.evidence}</code>}
    </div>
  );
}

/**
 * What a page's proposed content waits for: a person's acceptance or rejection (decision 0005's
 * acceptance record; the charter's «принимает или отклоняет страницы»). The decision stands in
 * the product's git like an answer, and the page shows the one the graph read back.
 */
export function PageDecisionSection({ page }: { page: GraphPageModel }): ReactElement {
  const { t } = useTranslation();
  const [note, setNote] = useState('');
  const [by, setBy] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [decided, setDecided] = useState<GraphAnswerRecord | null>(page.decision ?? null);
  const decide = async (verdict: 'accepted' | 'rejected'): Promise<void> => {
    setSaving(true);
    setError(null);
    try {
      const wrote = await postGraphDecision(page.node.id, verdict, note, by);
      setNote('');
      setDecided({ id: wrote.file, decision: verdict === 'accepted' ? 'accepts' : 'rejects', text: note, layer: 'declared', status: 'accepted', by: by.trim() === '' ? 'a reader of the wiki' : by.trim() });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSaving(false);
    }
  };
  return (
    <section className="graph-decision" data-testid="graph-decision" data-decision={decided?.decision ?? 'none'} aria-labelledby="graph-decision-title">
      <h2 id="graph-decision-title">{t('graph.decision.title', { count: page.assumptions.length })}</h2>
      {decided === null ? (
        <>
          <p className="graph-note">{t('graph.decision.note')}</p>
          <form className="graph-decision-form" data-testid="graph-decision-form" onSubmit={(event) => { event.preventDefault(); void decide('accepted'); }}>
            <label>
              {t('graph.decision.byLabel')}
              <input value={by} onChange={(event) => setBy(event.currentTarget.value)} maxLength={200} placeholder={t('graph.decision.byPlaceholder')} />
            </label>
            <label>
              {t('graph.decision.noteLabel')}
              <textarea value={note} onChange={(event) => setNote(event.currentTarget.value)} maxLength={20_000} rows={2} />
            </label>
            <div className="graph-decision-buttons">
              <button type="submit" disabled={saving} data-testid="graph-accept">{t('graph.decision.accept')}</button>
              <button type="button" disabled={saving} data-testid="graph-reject" onClick={() => void decide('rejected')}>{t('graph.decision.reject')}</button>
            </div>
            {error !== null && <p role="alert" className="graph-decision-error">{error}</p>}
          </form>
        </>
      ) : (
        <div className="graph-decision-record" data-testid="graph-decision-record">
          <span className="graph-chip">
            {decided.decision === 'accepts' ? <CircleCheckIcon aria-hidden="true" /> : <CircleDashedIcon aria-hidden="true" />}
            {/* Who decided it, as the record says: only a person's own word is `declared` (decision 0005), and an agent's
              * proposed verdict is never shown as a person's. */}
            {decided.layer !== 'declared'
              ? t('graph.decision.proposed', { layer: layerWord(decided.layer, t) })
              : decided.decision === 'accepts' ? t('graph.decision.accepted') : t('graph.decision.rejected')}
          </span>
          <span className="graph-chip">{t('graph.decision.by', { by: decided.by })}</span>
          {decided.text !== '' && <p className="graph-decision-text">{decided.text}</p>}
        </div>
      )}
    </section>
  );
}

/** The product's questions, grouped by the charter's types, each naming what depends on it (the charter's outcome 5). */
export function GraphQuestionsSection({ questions }: { questions: GraphQuestionSet }): ReactElement {
  const { t } = useTranslation();
  if (questions.total === 0) {
    return (
      <section className="graph-questions-open" data-testid="graph-questions-open" aria-labelledby="graph-questions-open-title">
        <h2 id="graph-questions-open-title">{t('graph.openQuestionsTitle')}</h2>
        <p className="graph-none">{t('graph.noOpenQuestions')}</p>
      </section>
    );
  }
  return (
    <section className="graph-questions-open" data-testid="graph-questions-open" aria-labelledby="graph-questions-open-title">
      <h2 id="graph-questions-open-title">{t('graph.openQuestionsTitle')}</h2>
      <p className="graph-note">{t('graph.openQuestionsCount', { open: questions.open, answered: questions.answered })}</p>
      {/* A question set the server's cap cut says so in its own words: a shorter list is never a silent one. */}
      {questions.truncated && questions.marker !== null && (
        <p className="graph-cut" role="status" data-testid="graph-questions-cut">{t('graph.questionsCut')} {questions.marker}</p>
      )}
      {questions.groups.map((group) => (
        <div className="graph-question-group" key={group.type} data-testid="graph-question-group" data-question-type={group.type}>
          <h3 className="graph-question-group-title">{t('graph.questionType.' + group.type, { defaultValue: group.type })}</h3>
          <ul className="graph-question-list">
            {group.questions.map((question) => (
              <li className="graph-question" key={question.id} data-question={question.id} data-open={(question.open ?? true) ? 'true' : 'false'}>
                <GraphLink id={question.id} address={addressOfGraphPage(question.id)} className="graph-question-prompt">{question.prompt}</GraphLink>
                <span className="graph-chip" data-testid="graph-question-rank">{t('graph.questionRank', { count: question.rank ?? 0 })}</span>
                {(question.dependsOn ?? []).length > 0 && (
                  <span className="graph-question-depends" data-testid="graph-question-depends">
                    {t('graph.questionDependsOn')}{' '}
                    {(question.dependsOn ?? []).map((node, at) => (
                      <span key={node.id}>
                        {at > 0 && ', '}
                        {node.page !== undefined ? <GraphLink id={node.id} address={node.page}>{node.label}</GraphLink> : node.label}
                      </span>
                    ))}
                  </span>
                )}
                {(question.open ?? true) ? <span className="graph-chip graph-chip-open">{t('graph.questionOpen')}</span> : <QuestionAnswer answer={question.answer!} />}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}

/** One node's page: its facts, its assumptions apart, its relations, its coverage, its questions and its drafts. */
export function GraphNodePage({ page, repos }: { page: GraphPageModel; repos: readonly RepoEntry[] }): ReactElement {
  const { t } = useTranslation();
  const { publish } = useContext(statusContext);
  const node = page.node;
  const facts = page.facts;
  const assumptions = page.assumptions;
  const out = page.relations.out;
  const into = page.relations.in;
  const relations = page.counts.out + page.counts.in;
  useEffect(() => {
    // The counts are three plural phrases in the reader's language, not three numbers in
    // an English sentence: "1 fact" and "1 факт" both read right.
    publish([t('graph.nodeCounts', {
      facts: page.counts.facts,
      factUnit: t('graph.factUnit', { count: page.counts.facts }),
      relations,
      relationUnit: t('graph.relationUnit', { count: relations }),
      questions: page.counts.questions,
      questionUnit: t('graph.questionUnit', { count: page.counts.questions }),
    })]);
    return () => publish(null);
  }, [publish, page.counts.facts, relations, page.counts.questions, t]);
  const repository = node.code?.repository ?? (typeof (page.value as { repository?: unknown } | null)?.repository === 'string' ? String((page.value as { repository: string }).repository) : undefined);
  const declared = repository === undefined ? undefined : repos.find((entry) => entry.name === repository);
  const origin = originOf(declared?.url);
  return (
    <main id="graph-node" data-testid="graph-node" data-node={node.id}>
      <div className="document-meta eyebrow">
        <strong className="eyebrow-kind">{t('graph.kindOne.' + node.kind, { defaultValue: node.kind })}</strong>
        <span className="eyebrow-dot" aria-hidden="true">•</span>
        <span className="eyebrow-secondary">{t('graph.nodePage')}</span>
      </div>
      <h1 className="app-title">{node.label}</h1>
      <dl className="doc-fields" data-testid="graph-node-fields">
        <div className="doc-field doc-field-identity">
          <dt className="doc-field-name">{t('graph.fieldKind')}</dt>
          <dd className="doc-field-value">{t('graph.kindOne.' + node.kind, { defaultValue: node.kind })}</dd>
        </div>
        <div className="doc-field doc-field-identity">
          <dt className="doc-field-name">{t('graph.fieldLayer')}</dt>
          <dd className="doc-field-value">{layerWord(node.layer, t)}</dd>
        </div>
        <div className="doc-field doc-field-identity">
          <dt className="doc-field-name">{t('graph.fieldStatus')}</dt>
          <dd className="doc-field-value">{statusWord(node.status, t)}</dd>
        </div>
        {repository !== undefined && (
          <div className="doc-field">
            <dt className="doc-field-name">{t('graph.fieldRepository')}</dt>
            <dd className="doc-field-value">
              {origin !== undefined && declared?.url !== undefined ? (
                <a href={declared.url} target="_blank" rel="noreferrer noopener">{repository}</a>
              ) : repository}
            </dd>
          </div>
        )}
        {node.code !== undefined && (
          <div className="doc-field">
            <dt className="doc-field-name">{t('graph.fieldCode')}</dt>
            <dd className="doc-field-value"><CodePlace code={node.code} repos={repos} /></dd>
          </div>
        )}
        {node.importance !== undefined && (
          <div className="doc-field">
            <dt className="doc-field-name">{t('graph.fieldImportance')}</dt>
            <dd className="doc-field-value">{node.importance}</dd>
          </div>
        )}
      </dl>
      {/* The marker is the server's own words, and the app says what it is before them. */}
      {page.truncated && page.marker !== null && (
        <p className="graph-cut" role="status" data-testid="graph-truncated">{t('graph.truncatedNote')} {page.marker}</p>
      )}

      {/* What to do next (the self-filling charter's outcome 5): the server decided it from the graph, and every page
        * carries one — «Всегда должна быть рекомендация что делать». */}
      {page.nextStep !== undefined && <NextStepSection step={page.nextStep} />}

      {/* A question's own page is where a person answers it: the answer the graph holds, or the form that writes one. */}
      {node.kind === 'question' && (
        <section className="graph-answer-section" data-testid="graph-answer-section" aria-labelledby="graph-answer-title">
          <h2 id="graph-answer-title">{t('graph.decision.answerTitle')}</h2>
          <QuestionAnswerForm
            question={{
              id: node.id,
              type: typeof (page.value as { type?: unknown } | null)?.type === 'string' ? String((page.value as { type: string }).type) : '',
              ...(typeof (page.value as { about?: unknown } | null)?.about === 'string' ? { about: String((page.value as { about: string }).about) } : {}),
              prompt: node.label,
              layer: node.layer,
              status: node.status,
              dependsOn: [],
              rank: 0,
              answer: page.answer ?? null,
              open: (page.answer ?? null) === null,
            }}
          />
        </section>
      )}

      {/* What the page proposes waits for a person's word: accepted or rejected, as Markdown in the product's git. */}
      {node.kind !== 'question' && (page.assumptions.length > 0 || page.decision !== null) && <PageDecisionSection page={page} />}

      {/* The diagrams (madarch-tzte.23.4): the models madarch-tzte.23.2 builds, each under
       * the tabs of every renderer that supports its type, the first tab the server's own
       * setting. A page the graph draws no diagram of shows the server's words, never an
       * empty frame. */}
      <GraphDiagramsSection node={node} readAt={page.readAt} repos={repos} />

      {/* The narrative layer stands above the facts it narrates (0026: "a second layer"): proposed
       * text, marked unverified, each sentence tied to the facts it names. 25.2 adds open questions
       * and the next step beside it; this section is the narrative layer's alone. */}
      {page.narrative !== null && <GraphNarrativeSection narrative={page.narrative} />}

      <section className="graph-facts" data-testid="graph-facts" aria-labelledby="graph-facts-title">
        <h2 id="graph-facts-title">{t('graph.factsTitle', { count: facts.length })}</h2>
        {facts.length === 0 ? <p className="graph-none">{t('graph.noFacts')}</p> : (
          <ul className="graph-fact-list">{facts.map((fact) => <FactRow key={fact.id} fact={fact} repos={repos} />)}</ul>
        )}
      </section>

      <section className="graph-assumptions" data-testid="graph-assumptions" aria-labelledby="graph-assumptions-title">
        <h2 id="graph-assumptions-title">{t('graph.assumptionsTitle', { count: assumptions.length })}</h2>
        <p className="graph-note">{t('graph.assumptionsNote')}</p>
        {assumptions.length === 0 ? <p className="graph-none">{t('graph.noAssumptions')}</p> : (
          <ul className="graph-fact-list">{assumptions.map((fact) => <FactRow key={fact.id} fact={fact} repos={repos} />)}</ul>
        )}
      </section>

      <section className="graph-relations" data-testid="graph-relations" aria-labelledby="graph-relations-title">
        <h2 id="graph-relations-title">{t('graph.relationsTitle', { count: out.length + into.length })}</h2>
        {out.length + into.length === 0 ? <p className="graph-none">{t('graph.noRelations')}</p> : (
          <>
            {out.length > 0 && (
              <>
                <h3>{t('graph.outgoing', { count: out.length })}</h3>
                <ul className="graph-relation-list" data-testid="graph-relations-out">{out.map((relation) => <RelationRow key={relation.edge.id + relation.direction} relation={relation} repos={repos} />)}</ul>
              </>
            )}
            {into.length > 0 && (
              <>
                <h3>{t('graph.incoming', { count: into.length })}</h3>
                <ul className="graph-relation-list" data-testid="graph-relations-in">{into.map((relation) => <RelationRow key={relation.edge.id + relation.direction} relation={relation} repos={repos} />)}</ul>
              </>
            )}
          </>
        )}
      </section>

      <section className="graph-coverage-section" data-testid="graph-coverage" aria-labelledby="graph-coverage-title">
        <h2 id="graph-coverage-title">{t('graph.coverageTitle', { count: page.coverage.length })}</h2>
        {page.coverage.length === 0 ? (
          <p className="graph-none">{page.coverageScopes.length === 0 ? t('graph.noCoverageScopes') : t('graph.noCoverage', { scopes: page.coverageScopes.join(', ') })}</p>
        ) : (
          <ul className="graph-coverage-rows">{page.coverage.map((row) => <CoverageRow key={row.id} row={row} />)}</ul>
        )}
      </section>

      <section className="graph-questions" data-testid="graph-questions" aria-labelledby="graph-questions-title">
        <h2 id="graph-questions-title">{t('graph.questionsTitle', { count: page.questions.filter((question) => question.open).length })}</h2>
        {page.questions.length === 0 ? <p className="graph-none">{t('graph.noQuestions')}</p> : (
          <ul className="graph-question-list">{page.questions.map((question) => <QuestionRow key={question.id} question={question} />)}</ul>
        )}
      </section>

      <section className="graph-drafts" data-testid="graph-drafts" aria-labelledby="graph-drafts-title">
        <h2 id="graph-drafts-title">{t('graph.draftsTitle', { count: page.drafts.length })}</h2>
        {page.drafts.length === 0 ? <p className="graph-none">{t('graph.noDrafts')}</p> : (
          <>
            <p className="graph-note">{t('graph.draftsNote')}</p>
            <ul className="graph-draft-list">{page.drafts.map((draft, at) => <DraftRow key={`${draft.unit}-${draft.generation}-${at}`} draft={draft} />)}</ul>
          </>
        )}
      </section>
    </main>
  );
}

