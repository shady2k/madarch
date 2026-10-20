/**
 * The person's decisions, read back into the graph (the self-filling charter's outcome
 * 5; decision 0026, "Writing": "the agent writes to the graph through the same server …
 * a person's edits and answers are git as well").
 *
 * `decisions.ts` keeps a person's answer and their acceptance as Markdown in the
 * product's git, which is where their words belong; this module is the one step between
 * that file and the graph — one transaction that writes the `answer` fact a record
 * names, retires the record it replaces, and records the pages the decision touched.
 *
 * **Why a holding of its own.** A published fact belongs to the unit that published it
 * (`fill_fact_holding`, one row per fact and unit), and a person's record belongs to no
 * unit at all: it is the product's own words. Its holding therefore names the product
 * (`fill_fact_holding.product`) and the holder `person`, and every read that scopes
 * itself to a product finds it beside the units' facts (`productScopeSql`,
 * `graph-reads.ts`), while a unit's publication never touches it — a unit replaces its
 * own facts and no other's (decision 0027, "Storage ownership").
 *
 * **One record per question, one per page.** A person who changes their mind writes the
 * same document again, and the graph must then hold one answer, not two: a write retires
 * the person's earlier `answer` fact about the same node before it stores the new one.
 * An agent's own answer is left alone — that is the agent's reading, and it stays as
 * 0005 keeps it, `inferred` and proposed.
 *
 * **The pages a decision touches, and no others.** An answer changes the question's own
 * page (it is closed) and the page of the node it is about (the question no longer stands
 * open there); an acceptance changes the page it decides about. The rows are the ones
 * the live channel reads (`fill_page_change`), so a page someone is reading is read again
 * for a decision and every other page stands: a decision recomputes what depends on it.
 */
import type { SqlExecutor } from '../query/sql-driver.js';
import { byCodePoint } from '../model/order.js';
import { runningVersion } from '../product/version.js';
import type { AcceptanceRecord, AnswerRecord, DecisionRecord } from './decisions.js';
import { makeNodeFact, type Fact, type FactProvenance } from './facts.js';
import { productScopeSql } from './graph-reads.js';
import { PAGE_CHANGE_TABLE, isPageId, pagesTouchedBy } from './page-changes.js';
import type { FactStoreDatabase } from './fact-store.js';
import { raise, withLocation } from './fsm-core.js';

/** The system every fact a person's record writes names as its reader (0004's `plugin@version`). */
export const DECLARED_SOURCE_SYSTEM = 'madarch-wiki';

/** The holder a person's records stand under: the product's own words, not a unit's. */
export const DECLARED_HOLDER = 'person';

/** The tables a declared write touches, named by every failure. */
export const DECLARED_TABLES = ['fill_fact', 'fill_fact_holding', PAGE_CHANGE_TABLE] as const;

/** One decision written into the graph: the fact it stores and the pages it touched. */
export interface DeclaredWrite {
  /** The decision's own words, as the product's git holds them (`answers/<digest>.md`). */
  readonly file: string;
  readonly fact: Fact;
  /** The pages the decision moved, in code point order: what the live channel announces. */
  readonly pages: readonly string[];
}

/** A record the graph refused, named where it stands: the document, and why it could not land. */
export interface DeclaredRefusal {
  readonly file: string;
  readonly message: string;
}

/** What one read of the product's decisions brought into the graph. */
export interface DeclaredRead {
  readonly written: readonly DeclaredWrite[];
  readonly refusals: readonly DeclaredRefusal[];
  /** Every page the writes touched, in code point order. */
  readonly pages: readonly string[];
}

/** The repository and commit a fact stands at: the node's own, since the decision is about it and not about a file. */
interface Subject {
  readonly repository: string;
  readonly commit: string;
  /** The node the question is about, when the subject is a question: the second page its answer touches. */
  readonly about?: string;
}

/** One node's own repository and commit, read from the store; null when the graph holds no such node. */
async function subjectIn(executor: SqlExecutor, product: string, id: string): Promise<Subject | null> {
  const scope = productScopeSql(product, 2);
  const { rows } = await executor.query<{ value: unknown; provenance: unknown }>(`SELECT f.value, f.provenance FROM fill_fact f WHERE f.id = $1${scope.sql}`, [id, ...scope.values]);
  const row = rows[0];
  if (row === undefined) return null;
  const value = (row.value ?? {}) as unknown as Record<string, unknown>;
  const provenance = (row.provenance ?? {}) as unknown as { repository?: { id?: unknown; commit?: unknown } };
  const repository = typeof value['repository'] === 'string' ? value['repository'] : provenance.repository?.id;
  const commit = provenance.repository?.commit;
  if (typeof repository !== 'string' || typeof commit !== 'string') raise(`src/fill/declared.ts: the node ${id} stands in the store with no repository and commit of its own (provenance ${JSON.stringify(provenance)}), so a decision about it has nowhere to stand: a fact always names the repository and the commit it was read at (src/fill/facts.ts)`);
  const about = value['about'];
  return { repository, commit, ...(typeof about === 'string' && isPageId(about) ? { about } : {}) };
}

/** The provenance a person's record carries: the node's own repository and commit, and the one reader that wrote it. */
function provenanceOf(subject: Subject): FactProvenance {
  return { source: { system: DECLARED_SOURCE_SYSTEM, version: runningVersion() }, repository: { id: subject.repository, commit: subject.commit } };
}

/** The `answer` fact one record names: a declared record of a person's words, accepted as it stands (0005). */
export function factOfRecord(record: DecisionRecord, subject: Subject): Fact {
  const decision = record.kind === 'answer' ? 'answers' : record.verdict === 'accepted' ? 'accepts' : 'rejects';
  const text = record.kind === 'answer' ? record.text : record.note;
  return makeNodeFact({
    kind: 'answer',
    value: { repository: subject.repository, subject: record.subject, decision, text: text === '' ? `${decision === 'accepts' ? 'accepted' : 'rejected'} through the wiki` : text, by: record.by },
    provenance: provenanceOf(subject),
    layer: 'declared',
    status: 'accepted',
  });
}

/**
 * The pages one record moves: the node it decides about, and — for an answer to a
 * question — the node the question is about, whose page no longer shows the question as
 * open. The first is the store's own rule for what a fact touches (`pagesTouchedBy`), so a
 * decision moves exactly the pages a publication of the same fact would.
 */
function pagesOf(fact: Fact, subject: Subject): readonly string[] {
  const touched = new Set<string>(pagesTouchedBy([fact]));
  if (subject.about !== undefined && isPageId(subject.about)) touched.add(subject.about);
  return [...touched].sort(byCodePoint);
}

/**
 * Reads the product's decisions back into the graph, in one transaction: every record
 * whose subject the graph holds becomes an `answer` fact held by the product; the
 * person's earlier answer about the same node is retired; and the pages each decision
 * moved are recorded for the live channel. A record whose subject stands nowhere, and
 * one the schema refuses, is answered as a refusal naming its document and lands
 * nothing.
 */
export async function applyDecisions(options: {
  readonly database: FactStoreDatabase;
  readonly product: string;
  readonly records: readonly DecisionRecord[];
}): Promise<DeclaredRead> {
  const at = 'src/fill/declared.ts';
  if (options.product.trim() === '') raise(`${at}: the decisions of "" were read: a product is named by the name its runs give it`);
  return await withLocation(at, `applyDecisions(${options.product}, ${String(options.records.length)} records)`, DECLARED_TABLES, async () => await options.database.transaction('write', async (executor) => {
    const written: DeclaredWrite[] = [];
    const refusals: DeclaredRefusal[] = [];
    for (const record of [...options.records].sort((left, right) => byCodePoint(left.file, right.file))) {
      const subject = await subjectIn(executor, options.product, record.subject);
      if (subject === null) {
        refusals.push({ file: record.file, message: `the decision is about ${record.subject}, and the graph holds no such node among the facts of "${options.product}": a decision is about a node the fill published` });
        continue;
      }
      let fact: Fact;
      try {
        fact = factOfRecord(record, subject);
      } catch (error) {
        refusals.push({ file: record.file, message: (error as Error).message });
        continue;
      }
      // The person's earlier record about this node is retired before the new one lands: one answer per question, one
      // verdict per page, and an agent's own answer (`inferred`) is left as the agent wrote it. The record's fact goes
      // with its last holding, so no row stands for a decision nobody holds.
      const retired = (await executor.query<{ id: string }>(
        `DELETE FROM fill_fact_holding h USING fill_fact f
          WHERE h.id = f.id AND h.unit_id = $1 AND h.product = $2 AND f.kind = 'answer' AND f.layer = 'declared'
            AND f.value->>'subject' = $3 AND f.id <> $4
          RETURNING h.id`,
        [DECLARED_HOLDER, options.product, record.subject, fact.id],
      )).rows.map((row) => row.id);
      if (retired.length > 0) {
        await executor.query(
          `DELETE FROM fill_fact f WHERE f.id = ANY($1::text[]) AND NOT EXISTS (SELECT 1 FROM fill_fact_holding h WHERE h.id = f.id)`,
          [retired],
        );
      }
      const publication = `person:${fact.id.slice(fact.id.indexOf(':') + 1, fact.id.indexOf(':') + 17)}`;
      // A fact two readers published is one row: a person's record replaces the envelope a unit published of the same
      // words, because a person's word is what a fact of the `declared` layer is (0005).
      await executor.query(
        `INSERT INTO fill_fact (id, kind, schema_version, provenance, layer, status, value) VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7::jsonb)
         ON CONFLICT (id) DO UPDATE SET layer = EXCLUDED.layer, status = EXCLUDED.status`,
        [fact.id, fact.kind, fact.schemaVersion, JSON.stringify(fact.provenance), fact.layer, fact.status, JSON.stringify(fact.value)],
      );
      await executor.query(
        `INSERT INTO fill_fact_holding (id, unit_id, stage_id, generation, publication, product) VALUES ($1, $2, $2, 0, $3, $4)
         ON CONFLICT (id, unit_id) DO UPDATE SET publication = EXCLUDED.publication, product = EXCLUDED.product`,
        [fact.id, DECLARED_HOLDER, publication, options.product],
      );
      const pages = pagesOf(fact, subject);
      for (const page of pages) {
        await executor.query(
          `INSERT INTO ${PAGE_CHANGE_TABLE} (node_id, unit_id, generation, publication, product) VALUES ($1, $2, 0, $3, $4)`,
          [page, DECLARED_HOLDER, publication, options.product],
        );
      }
      written.push({ file: record.file, fact, pages });
    }
    const pages = [...new Set(written.flatMap((entry) => entry.pages))].sort(byCodePoint);
    return { written, refusals, pages };
  }));
}

/** The decision a record names, as the wiki's own words read it: what a reader is told was decided. */
export function decisionOf(record: DecisionRecord): string {
  if (record.kind === 'answer') return 'answers';
  return record.verdict === 'accepted' ? 'accepts' : 'rejects';
}

/** The words one record carries, for a caller that shows them: an answer's answer, or an acceptance's note. */
export function wordsOf(record: DecisionRecord): string {
  return record.kind === 'answer' ? record.text : record.note;
}

/** An answer record's own shape, for a caller that reads one file's answer: the question, and the words. */
export type DecisionAnswer = AnswerRecord;

/** An acceptance record's own shape. */
export type DecisionAcceptance = AcceptanceRecord;
