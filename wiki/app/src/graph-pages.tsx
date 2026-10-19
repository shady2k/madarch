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
import { useContext, useEffect, type ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { FileCode2Icon } from 'lucide-react';
import { appPath } from './app-base.js';
import type {
  GraphCoverageRow,
  GraphDraftRow,
  GraphPageEntry,
  GraphPageFact,
  GraphPageModel,
  GraphPageSet,
  GraphQuestionEntry,
  GraphRelation,
  RepoEntry,
} from './api.js';
import { navigateTo, statusContext } from './hold.js';
import { codeHref, codePlace, graphKindGroups, originOf } from './graph.js';
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

/** One open question of the node. */
function QuestionRow({ question }: { question: GraphQuestionEntry }): ReactElement {
  const { t } = useTranslation();
  return (
    <li className="graph-question" data-question={question.id}>
      <span className="graph-question-prompt">{question.prompt}</span>
      <span className="graph-chip">{t('graph.questionType.' + question.type, { defaultValue: question.type })}</span>
      <span className="graph-chip">{layerWord(question.layer, t)}</span>
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

/**
 * The graph's index: every page-worthy node of the product, one group per kind with
 * the kind's count, each node a link to its page. An empty graph shows the server's
 * own what-to-do message: the fill writes the pages, and they appear as its units
 * publish.
 */
export function GraphIndexPage({ set, repos }: { set: GraphPageSet; repos: readonly RepoEntry[] }): ReactElement {
  const { t } = useTranslation();
  const { publish } = useContext(statusContext);
  const groups = graphKindGroups(set);
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
      {/* The server's message is in its own words and the app does not rewrite it: it is
        * the what-to-do, quoted with the language of the chrome around it. */}
      {set.total === 0 ? (
        <p className="graph-empty" data-testid="graph-empty">{set.message === null ? t('graph.empty', { product: set.product }) : t('graph.serverSays', { message: set.message })}</p>
      ) : (
        <div className="home-groups">
          {groups.map((group) => (
            <section key={group.kind} data-graph-kind={group.kind} className="home-group mt-7 first:mt-0">
              <header className="home-group-head">
                <h2 className="text-ink">{t('graph.kind.' + group.kind, { defaultValue: group.kind })}</h2>
                <span className="home-count" data-testid="graph-kind-count">{group.entries.length}</span>
              </header>
              <ul className="home-rows">
                {group.entries.map((entry) => (
                  <li key={entry.id}>
                    <GraphLink id={entry.id} address={entry.page} className="home-row">
                      <span className="home-row-title">{entry.label}</span>
                      <span className="graph-chip">{layerWord(entry.layer, t)}</span>
                    </GraphLink>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </main>
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

      {/* The diagrams (madarch-tzte.23.4): the models madarch-tzte.23.2 builds, each under
       * the tabs of every renderer that supports its type, the first tab the server's own
       * setting. A page the graph draws no diagram of shows the server's words, never an
       * empty frame. */}
      <GraphDiagramsSection node={node} readAt={page.readAt} repos={repos} />

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
        <h2 id="graph-questions-title">{t('graph.questionsTitle', { count: page.questions.length })}</h2>
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

