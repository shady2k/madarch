/**
 * The fill's fact store (decision 0026, "graph first"; decision 0027, "Storage
 * ownership"): the tables a published fact set lands in, through the process's
 * one database owner, and the reads that answer them.
 *
 * Two row sets, both the fill's own and neither the orchestrator's
 * (`orchestrator-store.ts`) nor the state machines' (`state-store.ts`):
 *
 * - `fill_fact`: one row per fact, keyed by its content-addressed id, carrying
 *   the kind, the version of the kind's value, the provenance, the layer, the
 *   status, the kind's own value, and the moment it was first published. A fact
 *   two units publish is one row, because the id *is* the fact's identity (0026:
 *   "The same fact extracted twice, on two machines, in two runs, has one id").
 *   The row keeps the envelope of the publication that put it there first: the
 *   fields an identity does not read — a call's `count`, a source's `version` —
 *   are two readers' observations of one fact, never a second fact.
 * - `fill_fact_holding`: one row per fact and publishing unit, with the stage,
 *   the generation and the publication digest that put it there. A publication
 *   replaces the facts of its own unit and of no other: the unit's holdings are
 *   compared with the facts it publishes now, a holding the publication does not
 *   repeat is dropped, and a fact whose last holding is dropped is gone — "a
 *   unit's publication replaces only that unit's own facts, never a whole
 *   source's" (0027, "Storage ownership").
 *
 * `applyPublishedFacts` is the orchestrator's sink (`FactApplication`,
 * `orchestrator.ts`): it runs inside the publication's own transaction, on the
 * executor that transaction handed it, so the facts, the generation's own state
 * and the publication record are one transaction. A write the schema does not
 * read refuses the whole publication — naming the write, its kind, the path, the
 * file and the line — and nothing of it is stored, so a generation is published
 * with its facts or not at all.
 *
 * A draft set is the orchestrator's own record (`fill_unit_draft`): this module
 * answers it as draft through `readUnitDraft`, reading the machine's rows and
 * never `fill_fact`, so a draft is never mixed with a published fact and a
 * retracted or published generation leaves nothing to read as draft.
 */
import type { DatabaseOwner } from '../adapters/database-owner.js';
import { byCodePoint } from '../model/order.js';
import type { SqlExecutor } from '../query/sql-driver.js';
import { FACT_EDGE_KINDS, checkFact, type Fact } from './facts.js';
import { here, withLocation } from './fsm-core.js';
import type { FactApplication } from './orchestrator.js';
import { readPublicationIn, readUnitDraftIn, type UnitPlanRecord } from './orchestrator-store.js';
import type { UnitRecord } from './state-store.js';
import type { StageDraftWrite } from './stage.js';

/** The fact store's own tables; `createFactStoreSchema` creates them and every error names the ones it touched. */
export const FACT_STORE_TABLES = ['fill_fact', 'fill_fact_holding'] as const;

/**
 * The schema: one row per fact, one row per fact and publishing unit. The
 * indexes answer the two reads a publication and a graph reader make: a unit's
 * own facts, and the facts of one kind.
 */
const SCHEMA: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS fill_fact (
    id text PRIMARY KEY,
    kind text NOT NULL,
    schema_version integer NOT NULL,
    provenance jsonb NOT NULL,
    layer text NOT NULL,
    status text NOT NULL,
    value jsonb NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS fill_fact_holding (
    id text NOT NULL,
    unit_id text NOT NULL,
    stage_id text NOT NULL,
    generation integer NOT NULL,
    publication text NOT NULL,
    PRIMARY KEY (id, unit_id)
  )`,
  'CREATE INDEX IF NOT EXISTS fill_fact_kind ON fill_fact (kind)',
  'CREATE INDEX IF NOT EXISTS fill_fact_holding_unit ON fill_fact_holding (unit_id)',
];

/** The narrow slice of the process's one database owner these tables borrow: the owner's `transaction`. */
export type FactStoreDatabase = Pick<DatabaseOwner, 'transaction'>;

/** Creates the fact store's tables and indexes; safe to run on every start of the process's owner. */
export async function createFactStoreSchema(database: FactStoreDatabase): Promise<void> {
  const at = here();
  await withLocation(at, 'createFactStoreSchema', FACT_STORE_TABLES, async () => {
    await database.transaction('write', async (executor) => {
      for (const statement of SCHEMA) await executor.query(statement);
    });
  });
}

const json = (value: unknown): string => JSON.stringify(value);

/** Epoch milliseconds from a `bigint` column, which PostgreSQL drivers answer as a string. */
const millis = (value: unknown): number => (typeof value === 'number' ? value : Number(value));

/** Runs one operation of this store, naming it and the tables it touched when the database failed. */
async function run<R>(
  site: string,
  database: FactStoreDatabase,
  operation: string,
  tables: readonly string[],
  work: (executor: SqlExecutor) => Promise<R>,
  kind: 'snapshot' | 'write',
): Promise<R> {
  return await withLocation(site, operation, tables, async () => await database.transaction(kind, work));
}

/** A JSON column as a value: PostgreSQL drivers answer `jsonb` objects, and a text-encoded one is parsed. */
function column(value: unknown): unknown {
  return typeof value === 'string' ? JSON.parse(value) : value;
}

// ---------------------------------------------------------------------------------------------
// What a unit's draft set publishes
// ---------------------------------------------------------------------------------------------

/**
 * One reason a draft write is not a fact the store can publish, at the write's
 * own position and at the fact's path, file and line.
 */
export interface FactWriteProblem {
  /** The write's position in the draft set, 1-based, in the order the unit wrote it. */
  readonly index: number;
  /** The write's own kind (`fact`, `entity`, `link`, `question`). */
  readonly kind: string;
  /** The path from the fact's top (`value.from`); empty when the refusal is about the write itself. */
  readonly path: string;
  /** The file the fact cites, when its provenance names one. */
  readonly file?: string;
  /** The line the fact cites, when its provenance names one. */
  readonly line?: number;
  readonly message: string;
}

/** The facts a draft set publishes, and every write of it that is not one. */
export interface FactWrites {
  /** The facts the writes carry, in the order the unit wrote them. */
  readonly facts: readonly Fact[];
  readonly problems: readonly FactWriteProblem[];
}

/**
 * Which fact kinds each write kind writes (0026's four writing tools): a plain
 * assertion writes a fact of any kind, a proposed entity is the
 * `entity-proposal` node, a question is the `question` node, and a link is one
 * of the schema's edges — the write path names which.
 */
const WRITE_KINDS: { readonly [K in StageDraftWrite['kind']]: { readonly describe: string; readonly accepts: (kind: string) => boolean } } = {
  fact: { describe: 'a fact of any kind', accepts: () => true },
  entity: { describe: 'an "entity-proposal" fact', accepts: (kind) => kind === 'entity-proposal' },
  link: { describe: 'an edge fact', accepts: (kind) => (FACT_EDGE_KINDS as readonly string[]).includes(kind) },
  question: { describe: 'a "question" fact', accepts: (kind) => kind === 'question' },
};

/**
 * The fact each write of a draft set writes: the write's own `value`, checked
 * with the schema's `checkFact`. A write whose value is not a fact the schema
 * reads is reported, never dropped: the store publishes the unit's facts or
 * refuses the publication by name.
 */
export function factsOfWrites(writes: readonly StageDraftWrite[]): FactWrites {
  const facts: Fact[] = [];
  const problems: FactWriteProblem[] = [];
  for (const [position, write] of writes.entries()) {
    const index = position + 1;
    const kind = write.kind;
    const value = (write as { readonly value?: unknown }).value;
    if (typeof value !== 'object' || value === null) {
      problems.push({
        index, kind, path: 'value',
        message: `the write carries ${value === undefined ? 'no fact' : `a ${typeof value}`}: a draft write's value is the fact it writes, ${WRITE_KINDS[kind].describe}`,
      });
      continue;
    }
    const found = checkFact(value);
    if (found.length > 0) {
      for (const problem of found) {
        problems.push({
          index, kind, path: problem.path, message: problem.message,
          ...(problem.file === undefined ? {} : { file: problem.file }),
          ...(problem.line === undefined ? {} : { line: problem.line }),
        });
      }
      continue;
    }
    const fact = value as Fact;
    if (!WRITE_KINDS[kind].accepts(fact.kind)) {
      problems.push({
        index, kind, path: 'kind',
        message: `${article(kind)} "${kind}" write writes ${WRITE_KINDS[kind].describe}, and this one is ${article(fact.kind)} "${fact.kind}" fact`,
      });
      continue;
    }
    facts.push(fact);
  }
  return { facts, problems };
}

/** The article a word takes, so a refusal reads as prose: `an "entity" write`, `a "module" fact`. */
function article(word: string): string {
  return /^[aeiou]/.test(word) ? 'an' : 'a';
}

/** A word with its article, for the phrases a write kind is described by. */
function withArticle(word: string): string {
  return `${article(word)} ${word}`;
}

/** One problem as a person reads it: the write, where it stands, the path and what is wrong. */
function described(problem: FactWriteProblem): string {
  const place = problem.file === undefined ? `write ${problem.index} (kind "${problem.kind}")` : `write ${problem.index} (kind "${problem.kind}") at ${problem.file}${problem.line === undefined ? '' : `:${problem.line}`}`;
  return problem.path === '' ? `${place}: ${problem.message}` : `${place} ${problem.path}: ${problem.message}`;
}

// ---------------------------------------------------------------------------------------------
// The publication
// ---------------------------------------------------------------------------------------------

/**
 * The facts of one unit's publication, in the order they are published: the
 * distinct ids of what its draft set wrote, in code point order. A stage that
 * saw one fact twice writes it once (a call folded from two sites is one edge),
 * so the set of what a publication applies is a set of facts.
 */
function publicationOrder(facts: readonly Fact[]): readonly Fact[] {
  const byId = new Map<string, Fact>();
  for (const fact of facts) byId.set(fact.id, fact);
  return [...byId.values()].sort((left, right) => byCodePoint(left.id, right.id));
}

/**
 * What a unit publishes: the facts of its draft set, replacing the facts it held
 * before — in the caller's own transaction, on the executor it hands in, so the
 * facts, the state and the record are one transaction.
 */
export interface FactApplicationInput {
  /** The transaction the publication opened; this store opens none of its own. */
  readonly executor: SqlExecutor;
  readonly unit: UnitRecord;
  readonly plan: UnitPlanRecord;
  /** The publication's own digest, recorded with every holding it writes. */
  readonly digest: string;
  readonly writes: readonly StageDraftWrite[];
}

/**
 * Applies one unit's published draft set within the publication's transaction
 * and answers how many facts it applied. The unit's own holdings are replaced
 * with the facts it publishes now (an empty draft set drops them all), a fact
 * another unit still holds keeps its row and loses only this unit's holding, and
 * a fact no unit holds any more is removed. A write the schema does not read
 * refuses the whole publication, naming the write, the file, the line and the
 * path: the caller's transaction rolls back and nothing is stored.
 */
export async function applyPublishedFacts(input: FactApplicationInput): Promise<number> {
  const at = here();
  const unitId = input.unit.unitId;
  const generation = input.unit.generation;
  const { facts, problems } = factsOfWrites(input.writes);
  if (problems.length > 0) {
    const what = problems.length === 1 ? '1 write that is not a fact of the schema' : `${problems.length} writes that are not facts of the schema`;
    throw new Error(`${at}: the draft set of unit "${unitId}" generation ${generation} holds ${what}: ${problems.map(described).join('; ')}`);
  }
  const publishing = publicationOrder(facts);
  const ids = publishing.map((fact) => fact.id);
  await withLocation(at, `applyPublishedFacts(${unitId}/${generation})`, FACT_STORE_TABLES, async () => {
    for (const fact of publishing) {
      // The fact's own row: the first publication of an id writes it, and a later one adds its holding
      // and leaves the row as it stands (the id is the fact's identity, so the difference is a reader's
      // own observation of the same fact).
      await input.executor.query(
        `INSERT INTO fill_fact (id, kind, schema_version, provenance, layer, status, value)
         VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7::jsonb)
         ON CONFLICT (id) DO NOTHING`,
        [fact.id, fact.kind, fact.schemaVersion, json(fact.provenance), fact.layer, fact.status, json(fact.value)],
      );
      await input.executor.query(
        `INSERT INTO fill_fact_holding (id, unit_id, stage_id, generation, publication)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (id, unit_id) DO UPDATE
           SET stage_id = EXCLUDED.stage_id, generation = EXCLUDED.generation, publication = EXCLUDED.publication`,
        [fact.id, unitId, input.plan.stageId, generation, input.digest],
      );
    }
    // What the unit held and does not publish now: only this unit's own facts are replaced, and a fact
    // another unit still holds stays.
    await input.executor.query('DELETE FROM fill_fact_holding WHERE unit_id = $1 AND id <> ALL($2::text[])', [unitId, ids]);
    await input.executor.query('DELETE FROM fill_fact WHERE NOT EXISTS (SELECT 1 FROM fill_fact_holding h WHERE h.id = fill_fact.id)');
  });
  return publishing.length;
}

/**
 * The orchestrator's sink, as a host wires it (`ProductFillWiring.facts`,
 * orchestrator-host.ts): the fill's own fact store. It holds nothing between
 * calls — `apply` runs on the executor of the publication's own transaction —
 * and the tables it writes are the process's, created with the fill's own by
 * `createFactStoreSchema`.
 */
export const FACT_APPLICATION: FactApplication = { apply: applyPublishedFacts };

// ---------------------------------------------------------------------------------------------
// What the store answers
// ---------------------------------------------------------------------------------------------

/**
 * One unit's publication of one fact: who holds it, from which stage and
 * generation, and under which publication digest. A fact carries no clock
 * (0009: the valid and recorded times are the log's, not the fact's), and when a
 * generation published is `fill_publication`'s own record.
 */
export interface FactPublisher {
  readonly unitId: string;
  readonly stageId: string;
  readonly generation: number;
  readonly publication: string;
}

/** One published fact and every unit that publishes it. */
export interface PublishedFact {
  readonly fact: Fact;
  /** Every publisher, in code point order of the unit id. */
  readonly publishers: readonly FactPublisher[];
}

interface FactRow extends Record<string, unknown> { id: string; kind: string; schema_version: unknown; provenance: unknown; layer: string; status: string; value: unknown }
interface HoldingRow extends Record<string, unknown> { id: string; unit_id: string; stage_id: string; generation: unknown; publication: string }

function storedFact(row: FactRow): Fact {
  return {
    kind: row.kind,
    schemaVersion: millis(row.schema_version),
    id: row.id,
    provenance: column(row.provenance),
    layer: row.layer,
    status: row.status,
    value: column(row.value),
  } as Fact;
}

function publisher(row: HoldingRow): FactPublisher {
  return { unitId: row.unit_id, stageId: row.stage_id, generation: millis(row.generation), publication: row.publication };
}

/** One fact by id, with every unit that publishes it, or null when no unit holds it. */
export async function readFact(database: FactStoreDatabase, id: string): Promise<PublishedFact | null> {
  const at = here();
  return await run(at, database, `readFact(${id})`, FACT_STORE_TABLES, async (executor) => {
    const { rows } = await executor.query<FactRow>('SELECT id, kind, schema_version, provenance, layer, status, value FROM fill_fact WHERE id = $1', [id]);
    const row = rows[0];
    if (row === undefined) return null;
    return { fact: storedFact(row), publishers: await publishersOf(executor, id) };
  }, 'snapshot');
}

/** Every unit that holds one fact, in code point order of the unit id. */
async function publishersOf(executor: SqlExecutor, id: string): Promise<readonly FactPublisher[]> {
  const { rows } = await executor.query<HoldingRow>('SELECT id, unit_id, stage_id, generation, publication FROM fill_fact_holding WHERE id = $1 ORDER BY unit_id ASC', [id]);
  return rows.map(publisher).sort((left, right) => byCodePoint(left.unitId, right.unitId));
}

/**
 * One unit's published facts, in code point order of their ids, each with every
 * unit that holds it: the facts it holds now, which is what its last publication
 * left. A draft set is not one of them — `readUnitDraft` answers a unit's draft,
 * and this answers what was published.
 */
export async function readUnitFacts(database: FactStoreDatabase, unitId: string): Promise<readonly PublishedFact[]> {
  const at = here();
  return await run(at, database, `readUnitFacts(${unitId})`, FACT_STORE_TABLES, async (executor) => {
    const { rows } = await executor.query<FactRow & HoldingRow>(
      `SELECT f.id, f.kind, f.schema_version, f.provenance, f.layer, f.status, f.value,
              h.unit_id, h.stage_id, h.generation, h.publication
         FROM fill_fact f JOIN fill_fact_holding h ON h.id = f.id
        WHERE f.id IN (SELECT id FROM fill_fact_holding WHERE unit_id = $1)
        ORDER BY f.id ASC, h.unit_id ASC`,
      [unitId],
    );
    const found = new Map<string, { fact: Fact; publishers: FactPublisher[] }>();
    for (const row of rows) {
      const held = found.get(row.id) ?? { fact: storedFact(row), publishers: [] };
      held.publishers.push(publisher(row));
      found.set(row.id, held);
    }
    // The query orders both keys; the sort keeps the answer this store's own order whatever the database does.
    return [...found.values()].sort((left, right) => byCodePoint(left.fact.id, right.fact.id));
  }, 'snapshot');
}

/** One unit's draft set, answered as draft: the writes, the facts they would publish, and never a published fact. */
export interface UnitDraftFacts {
  /** Always true: what this answers is a draft set, and a published fact set is `readUnitFacts`. */
  readonly draft: true;
  readonly unitId: string;
  readonly generation: number;
  readonly recordedAt: number;
  readonly writes: readonly StageDraftWrite[];
  /** The facts the draft set publishes, in the order they would be applied (distinct ids, code point order). */
  readonly facts: readonly Fact[];
  /** The writes of the draft set that are not facts of the schema, as the publication would refuse them. */
  readonly problems: readonly FactWriteProblem[];
}

/**
 * One unit generation's draft set, readable by any unit as draft, or null when
 * there is nothing to read: no draft was recorded, the draft was retracted (a
 * retracted draft leaves nothing), or the generation was published (its facts
 * are published facts then, and a draft is never mixed with them).
 */
export async function readUnitDraft(database: FactStoreDatabase, unitId: string, generation: number): Promise<UnitDraftFacts | null> {
  const at = here();
  return await run(at, database, `readUnitDraft(${unitId}/${generation})`, ['fill_unit_draft', 'fill_publication'], async (executor) => {
    // The machine's own rows, read inside this store's transaction: the owner refuses a second
    // transaction on its connection, so a read of the draft or the publication is made here.
    const recorded = await readUnitDraftIn(executor, unitId, generation);
    if (recorded === null || recorded.retractedAt !== null) return null;
    if (await readPublicationIn(executor, unitId, generation) !== null) return null;
    const { facts, problems } = factsOfWrites(recorded.writes);
    return {
      draft: true as const,
      unitId,
      generation,
      recordedAt: recorded.recordedAt,
      writes: recorded.writes,
      facts: publicationOrder(facts),
      problems,
    };
  }, 'snapshot');
}
