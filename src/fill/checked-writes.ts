/**
 * The checked write path (decision 0026, "Writing"): what an agent unit writes
 * the product graph through — assert a fact, propose an entity, link two nodes,
 * raise a question — and the checks every write passes before it lands in the
 * unit's draft set.
 *
 * Decision 0026: "The agent writes to the graph through the same server (assert
 * a fact, propose an entity, link, raise a question). Every write is checked at
 * once (schema, the cited bytes exist and are read by madarch at the pinned
 * commit, referenced nodes exist, the write is inside the unit's scope) and
 * lands in the unit's draft set, visible to other units as draft."
 *
 * The four checks, in the order one write passes them:
 *
 * 1. **The schema.** The request is read, the fact's envelope is built (the id
 *    its identity digests to, the provenance of the pinned commit, the layer the
 *    unit writes in, always `proposed`), and `checkFact` judges it: every problem
 *    at its path and, where the fact cites a place, at that file and line.
 * 2. **The scope.** The repository and the path the write cites lie inside the
 *    unit's own scope: a unit writes about what it was planned for, and a write
 *    about another repository's file is refused by naming both.
 * 3. **The cited bytes.** Madarch opens the pinned commit's reader for that
 *    repository, requires the file in that commit's tree, reads its bytes and
 *    holds the span to them: a span past the file's last line, or a column past
 *    the end of its line, is refused by naming the span and what the file holds.
 *    The bytes are the commit's own, so nothing rechecks them later.
 * 4. **The referenced nodes.** Every fact id the write carries — an edge's ends,
 *    an occurrence's symbol, a claim's node end, a question's subject — is a node
 *    the graph holds: a published fact, or a write this unit's own draft set
 *    already took. A write joins no node that stands nowhere.
 *
 * An accepted write is appended to the unit's draft set through the session's
 * own port (`draftSetOf` for a stage's writer, `recordedDraftSet` for the
 * machine's own rows, which is what makes a write visible as draft to another
 * unit while it runs) and the answer names the fact, its id and its position in
 * the draft set. A refused write is never stored, not even in part, and the
 * answer names the field it stands at and the reason.
 *
 * Each tool is a plain function with a typed request and a typed answer — never
 * a class, a session object with behaviour of its own, or a call that reaches a
 * database by itself — because the per-unit MCP server (madarch-tzte.22.2)
 * exposes them as tools, bound to the snapshot, the scope and the draft set of
 * one unit.
 *
 * `proposeEntity` is the one tool that answers more than the write: the entities
 * the graph already holds that are like the one proposed, so an agent proposes a
 * concept that exists rather than a second one beside it. The answer is capped
 * (`SIMILAR_ENTITY_CAP`) and says how many the graph holds, so a cut answer is
 * never read as the whole list.
 */
import type { DatabaseOwner } from '../adapters/database-owner.js';
import { byCodePoint } from '../model/order.js';
import { ID_PATTERN } from '../model/schema.js';
import type { SqlExecutor } from '../query/sql-driver.js';
import type { FactStoreDatabase } from './fact-store.js';
import {
  EDGE_END_KINDS, FACT_EDGE_KINDS, FACT_ID_PATTERN, FACT_KINDS, FACT_KINDS_IN_ORDER, FactSchemaError, checkFact, factId, isFactKind, repositoryPath,
  type EntityProposalForm, type Fact, type FactEdgeKind, type FactKind, type FactLayer, type FactPlace, type FactRange, type FactSource,
} from './facts.js';
import { here, withLocation } from './fsm-core.js';
import { readUnitDraftIn, recordUnitDraftIn, type OrchestratorDatabase } from './orchestrator-store.js';
import { SnapshotError, type SnapshotReader, type SnapshotSource } from './snapshot.js';
import type { StageDraftWrite, StageDraftWriter } from './stage.js';

// ---- the scope one unit writes inside --------------------------------------

/**
 * The scope one unit may write inside: the repository its run pinned for it,
 * and the path inside that repository it covers. A unit of the fill covers a
 * repository, a folder in it or one file, and a write about anything else is
 * another unit's (0026: work is divided, and a unit never fills another unit's
 * scope).
 *
 * A unit of 0026's hierarchy may also cover **the product** — the overview
 * hypothesis and the system recovery are one unit per product, and what they
 * state is about every repository the product pins — and that scope is spelled
 * `PRODUCT_SCOPE` (`"*"`), the one text that is no repository name
 * (`ID_PATTERN` admits no `*`). A write of such a unit cites the bytes it read
 * in whichever repository they stand in, and the pinned-commit check below is
 * what keeps it to the product's own repositories.
 */
export interface WriteScope {
  /** The product's own name for the repository, never a machine path or a URL; `PRODUCT_SCOPE` for the whole product. */
  readonly repository: string;
  /** The folder or the file the unit covers, as a repository path; absent when the unit covers the whole repository. */
  readonly path?: string;
}

/** The scope text of a unit that covers the whole product: every repository the run pinned (0026's hierarchy, `product`). */
export const PRODUCT_SCOPE = '*';

/** Whether a unit's scope is the product's: every repository the run pinned, with no path inside one. */
export function isProductScope(scope: WriteScope): boolean {
  return scope.repository === PRODUCT_SCOPE && scope.path === undefined;
}

/**
 * The one form a unit's scope takes, as the orchestrator's plan carries it and
 * as this path reads it: `"<repository>"` for a whole repository, or
 * `"<repository>:<path>"` for a folder or a file inside it — the form the
 * inventory's own units are named and scoped in
 * (`src/fill/stages/inventory.ts`), so a plan's scope text is read here as it
 * stands and no second vocabulary is invented.
 *
 * A scope that is no scope at all — an empty text, a repository name that is no
 * name, a path that is no repository path — is refused rather than read as a
 * wider scope than the plan meant.
 */
export function writeScope(text: string): WriteScope {
  const scope = typeof text === 'string' ? text : '';
  // The product's own scope, `"*"`: one unit per product (0026's hierarchy) writes about every repository the run
  // pinned, and its writes cite the bytes they read in whichever of them they stand.
  if (scope === PRODUCT_SCOPE) return { repository: PRODUCT_SCOPE };
  const cut = scope.indexOf(':');
  const repository = cut < 0 ? scope : scope.slice(0, cut);
  const shape = `a unit\'s scope is "<repository>", "<repository>:<path>" or "${PRODUCT_SCOPE}" for the whole product, the product\'s own name for the repository, never a machine path or a URL`;
  if (!ID_PATTERN.test(repository)) {
    throw new Error(`checked-writes: ${JSON.stringify(text)} is no unit scope: ${shape}`);
  }
  if (cut < 0) return { repository };
  try {
    return { repository, path: String(repositoryPath(scope.slice(cut + 1))) };
  } catch (error) {
    throw new Error(`checked-writes: ${JSON.stringify(text)} is no unit scope: ${(error as Error).message}; ${shape}`);
  }
}

/** The scope one unit covers, as its own text: what a plan wrote and what a refusal names. */
export function scopeText(scope: WriteScope): string {
  return scope.path === undefined ? scope.repository : `${scope.repository}:${scope.path}`;
}

/**
 * Whether a place lies inside the unit's scope: the repository and the folder
 * the scope names, and nothing else. A scope that names a path covers that file
 * or folder itself and everything below it. Exported because the read tools ask
 * the same question of a draft another unit holds — a draft's cited place is
 * inside a scope by this rule and no second one (`src/fill/graph-reads.ts`).
 */
export function scopeHolds(scope: WriteScope, place: { readonly repository: string; readonly file: string }): boolean {
  // A unit of the whole product covers every repository; the pinned-commit check of each write (`readPlace`) is
  // what keeps it to the product's own repositories, since a scope text knows no pins.
  if (isProductScope(scope)) return true;
  if (place.repository !== scope.repository) return false;
  if (scope.path === undefined) return true;
  return place.file === scope.path || place.file.startsWith(`${scope.path}/`);
}

// ---- what the write path reads ---------------------------------------------

/**
 * The repositories one unit's run pinned, read at one commit each. The bytes a
 * write cites are read here and nowhere else: a stage never reaches a checkout's
 * working tree (0026, stage 0).
 */
export type WriteSnapshots = SnapshotSource;

/** One entity the graph already holds that is like the one an agent proposed. */
export interface SimilarEntity {
  /** The fact id of the existing proposal, the digest of its identity. */
  readonly id: string;
  readonly repository: string;
  readonly proposed: EntityProposalForm;
  readonly name: string;
  /** How the two names are alike: `same-name`, `contains-name` or `shares-word`. */
  readonly similarity: Similarity;
}

/** How one proposed name and one existing name are alike, from the closest form to the loosest. */
export type Similarity = 'same-name' | 'contains-name' | 'shares-word';

/** The entities like a proposal, and whether the answer names every one of them. */
export interface SimilarEntities {
  /** The entities, closest first, then in code point order of their ids; at most `cap` of them. */
  readonly found: readonly SimilarEntity[];
  /** How many the graph holds; more than `found.length` means this answer was cut at the cap. */
  readonly total: number;
  /** True when the answer was cut: the list stands for more than it names. */
  readonly truncated: boolean;
  /** The cap this answer was cut at. */
  readonly cap: number;
}

/** How many entities one `propose_entity` answer carries (0026: a tool answer is bounded). */
export const SIMILAR_ENTITY_CAP = 5;

/**
 * What the write path asks the graph it writes into: whether a node stands, and
 * which entities are like a proposal. A port rather than a database, so a test
 * answers it in memory and the MCP server (madarch-tzte.22.2) wires it to the one
 * background server that owns the database.
 */
/**
 * One node the graph holds: the id it stands under, the kind of fact it is, and
 * the repository the fact stands in (its own provenance), which is what keeps a
 * write inside the scope it was planned for (0026: a unit never fills another
 * unit's scope). The repository is the line the schema itself draws — "one fact
 * is one repository" — and the finest a node's fact carries: a module names no
 * path of its own, and the folder a node's file stands at is the cited place's
 * business, which the write's own place check holds to the scope.
 */
export interface WrittenNode {
  readonly id: string;
  readonly kind: FactKind;
  /** The repository the node's fact stands in, as its provenance names it. */
  readonly repository: string;
}

/**
 * What the write path asks the graph it writes into: which node stands at an id,
 * and which entities are like a proposal. A port rather than a database, so a
 * test answers it in memory and the MCP server (madarch-tzte.22.2) wires it to
 * the one background server that owns the database.
 */
export interface CheckedWriteGraph {
  /**
   * The node the graph holds at this id — a published fact, or a write another
   * unit's draft set holds — or `null` where nothing stands there. The kind is
   * what the ends of an edge are held to (`EDGE_END_KINDS`), and the repository
   * is what keeps a write inside its unit's scope.
   */
  node(id: string): Promise<WrittenNode | null>;
  /** The entities of one repository whose name is like the one proposed, closest first. */
  similarEntities(request: { readonly repository: string; readonly name: string }): Promise<readonly SimilarEntity[]>;
}

/** What a write's request says about the bytes it cites. */
export interface CitedPlaceRequest {
  /** The product's own name for the repository the bytes stand in. */
  readonly repository: string;
  /** The file, as a repository path from the repository's root. */
  readonly file: string;
  /** The first line the write cites, 1-based as a reader counts lines. */
  readonly startLine: number;
  /** The last line the write cites, 1-based; left out, the write cites `startLine` alone. */
  readonly endLine?: number;
  /** The first character's offset in `startLine`, 0-based; left out, the write cites the whole line from its start. */
  readonly startColumn?: number;
  /** The offset just past the last character in `endLine`, 0-based; left out, the write cites the whole line. */
  readonly endColumn?: number;
}

/** One reason a write did not land, at the field it stands at and, where the write cites one, at its file and line. */
export interface WriteRefusal {
  /** The field the refusal is about, as a path from the write's top (`place.file`, `value.from`, `kind`). */
  readonly field: string;
  readonly reason: string;
  /** The file the write cites, when the refusal is about one. */
  readonly file?: string;
  /** The line the write cites, when the refusal is about one. */
  readonly line?: number;
}

/** One write that landed in the unit's draft set. */
export interface DraftedWrite {
  readonly ok: true;
  /** The fact the write wrote, with the id its identity digests to. */
  readonly fact: Fact;
  /** The write as the draft set holds it, beside the writes made before it. */
  readonly write: StageDraftWrite;
  /** The write's position in the draft set, 1-based, in the order the unit made its writes. */
  readonly position: number;
  /** How many writes the unit's draft set holds after this one. */
  readonly writes: number;
  /** What the write cites, as the draft's own evidence line: `repository@commit:file`. */
  readonly evidence: string;
}

/** What a write answers: the fact that landed, or every reason it did not. */
export type WriteAnswer = DraftedWrite | { readonly ok: false; readonly refusals: readonly WriteRefusal[] };

/** What `proposeEntity` answers: the write's own answer, beside the entities the graph already holds that are like it. */
export type EntityAnswer = (DraftedWrite | { readonly ok: false; readonly refusals: readonly WriteRefusal[] }) & { readonly similar: SimilarEntities };

/** What `assertFact` asks: one fact of any kind the schema reads, and the bytes it stands on. */
export interface AssertFactRequest {
  /** The kind of fact the unit asserts, one of the schema's own kinds. */
  readonly kind: string;
  /** The kind's own value, as the agent wrote it; the schema judges it field by field. */
  readonly value: unknown;
  /** The file and span the write stands on: bytes madarch reads itself at the pinned commit. */
  readonly place: CitedPlaceRequest;
}

/** What `link` asks: one edge of the schema, drawn between two nodes the graph holds. */
export interface LinkRequest {
  /** The kind of edge the unit links with, one of the schema's edge kinds. */
  readonly kind: string;
  /** The edge's own value: its ends are fact ids the graph must hold. */
  readonly value: unknown;
  readonly place: CitedPlaceRequest;
}

/** What `proposeEntity` asks: an entity or a concept the unit met, and where it met it. */
export interface ProposeEntityRequest {
  /** A concept of the domain, or an entity a document of the product could be about. */
  readonly proposed: EntityProposalForm;
  /** The name proposed, as the unit writes it; the schema trims and folds inner whitespace. */
  readonly name: string;
  readonly summary?: string;
  /** Other names the unit found for it, in code point order, each once. */
  readonly aliases?: readonly string[];
  readonly place: CitedPlaceRequest;
}

/** What `raiseQuestion` asks: a question for a person, and the bytes that raised it. */
export interface RaiseQuestionRequest {
  /** The kind of question, one lower-case kebab token (`assumption-check`, `contradiction`, `unverifiable`). */
  readonly type: string;
  /** The question as a person reads it, one sentence. */
  readonly prompt: string;
  /** What it is about — a node the graph holds, or a scope — when the question names one. */
  readonly about?: string;
  readonly place: CitedPlaceRequest;
}

/** One unit's checked writes: what it writes about, where its bytes are read, where a write lands and what the graph answers. */
export interface CheckedWriteSession {
  /** The unit that writes: the identity its draft set belongs to (0027's unit generation). */
  readonly unit: { readonly unitId: string; readonly generation: number };
  /** What a fact the unit writes names as the system that read it (0004: `plugin@version`, an agent stage's own name). */
  readonly source: FactSource;
  /** The layer the unit's writes stand in (0005): `inferred` for an agent stage, and their status is always `proposed`. */
  readonly layer: FactLayer;
  /** The one scope the unit may write inside. */
  readonly scope: WriteScope;
  /**
   * The stage the unit belongs to, and the fact kinds that stage declares — the only
   * kinds its units may write (0026, "Writing": "every write is checked at once").
   * A session that names none is bound by the schema alone (a stage's own draft is
   * judged against its declared kinds before it is published, `src/fill/stages/draft.ts`).
   */
  readonly stage?: string;
  readonly kinds?: readonly string[];
  /** The repositories the unit's run pinned: where the bytes a write cites are read. */
  readonly snapshot: WriteSnapshots;
  /** Where an accepted write lands: the unit's own draft set. */
  readonly draft: CheckedWriteDraft;
  /** What the graph answers about the nodes a write references and the entities like a proposal. */
  readonly graph: CheckedWriteGraph;
}

// ---- the unit's draft set ---------------------------------------------------

/**
 * Where an accepted write lands: the unit's own draft set, private until its
 * generation is published (0026: "lands in the unit's draft set, visible to other
 * units as draft"). The port is asynchronous because one of its two wirings
 * records every write in the machine's own rows.
 */
export interface CheckedWriteDraft {
  /** Appends one accepted write, in the order the unit made it. */
  append(write: StageDraftWrite): Promise<void>;
  /**
   * The writes the draft set holds for the attempt that is running, in the order
   * they were made. A retracted set holds none: 0027 retracts a generation's draft
   * so the next attempt starts clean, so the writes of the attempt before this one
   * are not this attempt's, and a port built after a retraction answers the same
   * set as a port that made the writes. Reading is asynchronous because one of the
   * two wirings reads the machine's own row.
   */
  writes(): Promise<readonly StageDraftWrite[]>;
}

/**
 * The stage's own draft writer (`StageContext.draft`), read as this path's port:
 * every accepted write goes into the set the attempt records at its end, and
 * nothing is recorded until the stage hands that set over. This is the wiring for
 * a unit whose stage runs inside the orchestrator: the attempt's own
 * `recordUnitDraft` replaces the generation's row with exactly this set.
 */
export function draftSetOf(writer: StageDraftWriter): CheckedWriteDraft {
  return {
    append: async (write: StageDraftWrite) => { writer.write(write); },
    // A copy, not the writer's own list: a stage's writer hands the live array out, and a caller that
    // reads the set before a write and again after it must see two sets, not one array that moved.
    writes: async () => [...writer.writes().writes],
  };
}

/**
 * The unit's draft set as the machine records it (`fill_unit_draft`,
 * `orchestrator-store.ts`): every accepted write is appended to the recorded
 * set in a transaction of the process's one owner, so another unit reads it as
 * draft at once — that is what `readUnitDraft` (`fact-store.ts`) answers, and
 * what makes a write visible while its unit still runs.
 *
 * A retracted set is the attempt before this one. 0027 retracts a generation's
 * draft set so the next attempt starts clean, and `retryAttempt` runs *that same
 * generation* again (`orchestrator.ts`), so an append that meets a retraction is
 * the next attempt's first write: the set it starts from is empty (the retracted
 * writes are not this attempt's) and recording clears the retraction, exactly as
 * the landed `recordUnitDraftIn` does. A late write of the superseded attempt
 * arrives the same way — this port carries no lease and no fence, and what keeps
 * such a write out of a publication is the publication's own fence check
 * (`publishUnitIn`), never this port.
 *
 * One writer per generation is the contract. The generation's row is locked
 * before every append, so two appends of a generation whose row stands serialize
 * in the database rather than in a caller's promise; the first append of a
 * generation whose row does not stand yet is the exception, and two callers that
 * both take it can lose one write.
 */
export function recordedDraftSet(
  database: OrchestratorDatabase,
  unit: { readonly unitId: string; readonly generation: number; readonly at: () => number },
): CheckedWriteDraft {
  /** The writes the machine holds for the attempt that is running: a retracted set is the attempt before it. */
  const heldNow = async (executor: SqlExecutor): Promise<readonly StageDraftWrite[]> => {
    const recorded = await readUnitDraftIn(executor, unit.unitId, unit.generation);
    return recorded === null || recorded.retractedAt !== null ? [] : recorded.writes;
  };
  return {
    async append(write: StageDraftWrite): Promise<void> {
      const at = here();
      await withLocation(at, `checkedWrite(${unit.unitId}/${unit.generation})`, ['fill_unit_draft', 'fill_unit_draft_part'], async () => {
        await database.transaction('write', async (executor) => {
          // The row is held for the rest of this transaction, so a second append of the same generation
          // waits here instead of reading the same set and overwriting this one.
          await executor.query('SELECT unit_id FROM fill_unit_draft WHERE unit_id = $1 AND generation = $2 FOR UPDATE', [unit.unitId, unit.generation]);
          // A set the machine holds is the attempt's own; a retracted one belonged to the attempt before
          // it (0027: `retry-wait` retracts the generation's draft so the next attempt starts clean), and
          // recording clears the retraction, which is the landed store's own answer for a rerun.
          const writes = [...(await heldNow(executor)), write];
          await recordUnitDraftIn(executor, { unitId: unit.unitId, generation: unit.generation, writes, at: unit.at() });
        });
      });
    },
    async writes(): Promise<readonly StageDraftWrite[]> {
      return await withLocation(here(), `checkedWrites(${unit.unitId}/${unit.generation})`, ['fill_unit_draft', 'fill_unit_draft_part'], async () => await database.transaction('snapshot', async (executor) => await heldNow(executor)));
    },
  };
}

// ---- the answer one write builds -------------------------------------------

/** A field with its article, for the phrases a refusal is written in. */
function article(word: string): string {
  return /^[aeiou]/.test(word) ? 'an' : 'a';
}

/** A value as a refusal names it, in JSON's own words. */
function shown(value: unknown): string {
  if (value === undefined) return 'nothing';
  if (typeof value === 'string') return JSON.stringify(value);
  try {
    const text = JSON.stringify(value);
    return text === undefined ? String(value) : text;
  } catch {
    return Object.prototype.toString.call(value);
  }
}

/** A whole number, or why the field is not one. */
function wholeNumber(field: string, value: unknown, what: string): WriteRefusal | undefined {
  return typeof value === 'number' && Number.isInteger(value)
    ? undefined
    : { field, reason: `${shown(value)} is no ${what}: ${what === 'line' ? 'a line a reader counts' : 'an offset in a line'} is a whole number` };
}

/** The refusals of a place request's own shape, before anything of the snapshot is read. */
function placeShape(request: unknown): readonly WriteRefusal[] {
  const refusals: WriteRefusal[] = [];
  if (typeof request !== 'object' || request === null || Array.isArray(request)) {
    return [{ field: 'place', reason: `a write cites where its bytes stand — the repository, the file and the span — as an object, not ${shown(request)}` }];
  }
  const place = request as Record<string, unknown>;
  for (const field of Object.keys(place).sort(byCodePoint)) {
    if (!['repository', 'file', 'startLine', 'endLine', 'startColumn', 'endColumn'].includes(field)) {
      refusals.push({ field: `place.${field}`, reason: `${shown(field)} is no part of a cited place: a place is the repository, the file, the first line and the last line, and the columns when the write cites them` });
    }
  }
  if (typeof place['repository'] !== 'string' || !ID_PATTERN.test(place['repository'] as string)) {
    refusals.push({ field: 'place.repository', reason: `${shown(place['repository'])} is no repository name: the product's own name for the repository, like "orders-api", never a path or a URL` });
  }
  if (typeof place['file'] !== 'string') {
    refusals.push({ field: 'place.file', reason: `a write cites the file its bytes stand in, and ${shown(place['file'])} is no path` });
  } else {
    try {
      repositoryPath(place['file']);
    } catch (error) {
      refusals.push({ field: 'place.file', reason: (error as Error).message, file: place['file'] });
    }
  }
  const start = wholeNumber('place.startLine', place['startLine'], 'line');
  if (start !== undefined) refusals.push(start);
  else if ((place['startLine'] as number) < 1) refusals.push({ field: 'place.startLine', reason: `the write cites line ${String(place['startLine'])}, and lines are counted from 1: the first line of a file is line 1` });
  const end = place['endLine'] === undefined ? undefined : wholeNumber('place.endLine', place['endLine'], 'line');
  if (end !== undefined) refusals.push(end);
  else if (typeof place['endLine'] === 'number' && typeof place['startLine'] === 'number' && place['endLine'] < place['startLine']) {
    refusals.push({ field: 'place.endLine', reason: `the write cites lines ${String(place['startLine'])}-${String(place['endLine'])}: a span ends at or after the line it starts at` });
  }
  for (const column of ['startColumn', 'endColumn'] as const) {
    if (place[column] === undefined) continue;
    const problem = wholeNumber(`place.${column}`, place[column], 'column');
    if (problem !== undefined) refusals.push(problem);
    else if ((place[column] as number) < 0) refusals.push({ field: `place.${column}`, reason: `the write cites column ${String(place[column])}, and columns are counted from 0` });
  }
  return refusals;
}

/** The lines of one file as a reader counts them: an empty text holds none, and a newline ends a line rather than starting one. */
function linesOf(text: string): readonly string[] {
  if (text === '') return [];
  return (text.endsWith('\n') ? text.slice(0, -1) : text).split('\n');
}

/**
 * Whether the span a write cites stands inside the bytes of the file, and why
 * it does not. The span is named in every refusal, so a refusal about line 900
 * of a ten-line file says both.
 */
function spanRefusal(file: string, range: FactRange, lines: readonly string[]): WriteRefusal | undefined {
  const span = range.startLine === range.endLine ? `line ${range.startLine}` : `lines ${range.startLine}-${range.endLine}`;
  const holds = lines.length === 1 ? '1 line' : `${lines.length} lines`;
  if (lines.length === 0) {
    return { field: 'place.range', reason: `the write cites ${span} of ${JSON.stringify(file)}, and the file holds no line at this commit: its bytes are empty`, file };
  }
  if (range.endLine > lines.length) {
    return { field: 'place.range', reason: `the write cites ${span} of ${JSON.stringify(file)}, and the file holds ${holds} at this commit: the span stands past the end of the bytes madarch read`, file, line: range.startLine };
  }
  if (range.endLine === range.startLine && range.endColumn < range.startColumn) {
    return { field: 'place.range', reason: `the write cites columns ${range.startColumn}-${range.endColumn} of line ${range.startLine} of ${JSON.stringify(file)}: a span ends at or after the column it starts at`, file, line: range.startLine };
  }
  if (range.startColumn > (lines[range.startLine - 1] ?? '').length) {
    return { field: 'place.range', reason: `the write cites column ${range.startColumn} of line ${range.startLine} of ${JSON.stringify(file)}, and that line holds ${(lines[range.startLine - 1] ?? '').length} characters`, file, line: range.startLine };
  }
  if (range.endColumn > (lines[range.endLine - 1] ?? '').length) {
    return { field: 'place.range', reason: `the write cites column ${range.endColumn} of line ${range.endLine} of ${JSON.stringify(file)}, and that line holds ${(lines[range.endLine - 1] ?? '').length} characters`, file, line: range.endLine };
  }
  return undefined;
}

/** What one write cites, once the place request has been read against the pinned snapshot. */
interface CitedPlace {
  readonly reader: SnapshotReader;
  readonly place: FactPlace;
}

/** What reading a place answered: the place, or every reason it does not stand. */
interface PlaceReading {
  readonly cited?: CitedPlace;
  readonly refusals: readonly WriteRefusal[];
}

/**
 * Reads the place a write cites: the repository must be one the run pinned and
 * inside the unit's scope, the file must stand in that commit's tree, and the
 * span must stand inside the bytes madarch reads there. The bytes are read
 * whatever the answer, so a write stands on bytes madarch saw itself — the
 * commit is pinned, so there are no bytes to recheck later.
 */
async function readPlace(session: CheckedWriteSession, request: CitedPlaceRequest): Promise<PlaceReading> {
  const refusals: WriteRefusal[] = [];
  const repository = request.repository;
  const file = String(repositoryPath(request.file));
  if (!scopeHolds(session.scope, { repository, file })) {
    return {
      refusals: [repository === session.scope.repository
        ? { field: 'place.file', reason: `the unit's scope is ${JSON.stringify(scopeText(session.scope))} and the write cites ${JSON.stringify(file)}: a unit writes inside its own scope, and a path outside it is another unit's`, file }
        : { field: 'place.repository', reason: `the unit's scope is ${JSON.stringify(scopeText(session.scope))} and the write cites ${JSON.stringify(repository)}: a unit writes about the repository it was planned for`, file }],
    };
  }
  const pins = await session.snapshot.pins();
  if (!pins.some((pin) => pin.id === repository)) {
    const known = pins.map((pin) => pin.id).sort(byCodePoint);
    return { refusals: [{ field: 'place.repository', reason: `${JSON.stringify(repository)} is not a repository this run pins: it pins ${known.length === 0 ? 'no repository' : known.map((id) => JSON.stringify(id)).join(', ')}`, file }] };
  }
  let reader: SnapshotReader;
  try {
    reader = await session.snapshot.open(repository);
  } catch (error) {
    return { refusals: [{ field: 'place.repository', reason: `the repository ${JSON.stringify(repository)} could not be opened at the commit this run pinned: ${(error as Error).message}`, file }] };
  }
  let bytes: Uint8Array;
  try {
    reader.requireEntry(file);
    bytes = await reader.read(file);
  } catch (error) {
    if (!(error instanceof SnapshotError)) throw error;
    // `message`, not `detail`: only the reader's message names the repository, the commit and the path.
    return { refusals: [{ field: 'place.file', reason: error.message, file }] };
  }
  const lines = linesOf(Buffer.from(bytes).toString('utf8'));
  const startLine = request.startLine;
  const endLine = request.endLine ?? startLine;
  const range: FactRange = {
    startLine,
    startColumn: request.startColumn ?? 0,
    endLine,
    endColumn: request.endColumn ?? (lines[endLine - 1] ?? '').length,
  };
  const outOfBounds = spanRefusal(file, range, lines);
  if (outOfBounds !== undefined) refusals.push(outOfBounds);
  if (refusals.length > 0) return { refusals };
  return { cited: { reader, place: { file: repositoryPath(file), range } }, refusals };
}

/** What the write path tells the reader of a refusal: the repository, the commit and the file a write cites. */
function evidenceOf(cited: CitedPlace): string {
  // The repository the cited bytes stand in, never the scope's own: a unit of the whole product cites a place in any
  // of the repositories it covers, and its evidence has to name the one it read (`SnapshotReader.repository`).
  return `${cited.reader.repository}@${cited.reader.commit}:${cited.place.file}`;
}

/** Every fact id a value carries, at the field it stands at, in the order the walk meets them. */
function referencedIds(value: unknown, field = 'value'): readonly { readonly field: string; readonly id: string }[] {
  const found: { field: string; id: string }[] = [];
  const walk = (held: unknown, at: string): void => {
    if (typeof held === 'string') {
      if (FACT_ID_PATTERN.test(held)) found.push({ field: at, id: held });
      return;
    }
    if (Array.isArray(held)) {
      held.forEach((entry, index) => { walk(entry, `${at}[${index}]`); });
      return;
    }
    if (typeof held === 'object' && held !== null) {
      for (const key of Object.keys(held as Record<string, unknown>).sort(byCodePoint)) {
        walk((held as Record<string, unknown>)[key], `${at}.${key}`);
      }
    }
  };
  walk(value, field);
  return found;
}

/**
 * The nodes the unit's own draft set already holds, by id: a write may join what
 * this unit wrote before it, and the kind of such a node is the fact it wrote.
 */
function draftedNodes(writes: readonly StageDraftWrite[]): ReadonlyMap<string, FactKind> {
  const nodes = new Map<string, FactKind>();
  for (const write of writes) {
    const value = (write as { readonly value?: unknown }).value;
    if (typeof value !== 'object' || value === null) continue;
    const { id, kind } = value as { readonly id?: unknown; readonly kind?: unknown };
    if (typeof id === 'string' && isFactKind(kind)) nodes.set(id, kind);
  }
  return nodes;
}

/**
 * Which end of an edge a value's own fact-id field names: `from` first, `to`
 * second, and the two kinds that name the same ends differently — a `consumes`
 * edge binds a variable at its `variable`, while a `binds` edge's variable is
 * the end it starts from (0026's `link` writes an edge, and its ends must be the
 * kinds the edge joins).
 */
const END_OF_FIELD: Readonly<Record<string, Readonly<Record<string, 'from' | 'to'>>>> = {
  consumes: { from: 'from', variable: 'to' },
  binds: { variable: 'from' },
  interaction: { caller: 'from', callee: 'to' },
};

/** The end of an edge the fact-id field at this value path names, or `undefined` where the path names no end. */
function endOfReference(kind: FactKind, path: string): 'from' | 'to' | undefined {
  if (!(FACT_EDGE_KINDS as readonly string[]).includes(kind)) return undefined;
  const match = /^value\.([A-Za-z]+)$/.exec(path);
  if (match === null) return undefined;
  const field = match[1]!;
  return END_OF_FIELD[kind]?.[field] ?? (field === 'from' ? 'from' : field === 'to' ? 'to' : undefined);
}

/** What one write of the four tools hands the path. */
interface ToolWrite {
  readonly tool: StageDraftWrite['kind'];
  readonly kind: unknown;
  readonly value: unknown;
  readonly place: unknown;
}

/**
 * One checked write, end to end: the request is read, the cited bytes are read
 * at the pinned commit, the fact is built and judged by the schema, every node
 * it references is looked up, and an accepted fact is appended to the unit's
 * draft set. Every refusal is gathered before the answer, so an agent that got
 * two fields wrong learns both at once.
 */
async function write(session: CheckedWriteSession, request: ToolWrite): Promise<Written> {
  const refusals: WriteRefusal[] = [];
  const kindShape: WriteRefusal[] = [];
  if (!isFactKind(request.kind)) {
    kindShape.push({ field: 'kind', reason: `${shown(request.kind)} is not a fact kind: the schema's kinds are ${FACT_KINDS_IN_ORDER.join(', ')}` });
  } else if (request.tool === 'link' && !(FACT_EDGE_KINDS as readonly string[]).includes(request.kind)) {
    kindShape.push({ field: 'kind', reason: `a link draws an edge of the schema, and ${shown(request.kind)} is ${article(request.kind as string)} "${String(request.kind)}" node: the edge kinds are ${FACT_EDGE_KINDS.join(', ')}` });
  }
  if (typeof request.value !== 'object' || request.value === null || Array.isArray(request.value)) {
    kindShape.push({ field: 'value', reason: `a write carries the value of its fact as an object, not ${shown(request.value)}` });
  }
  if (isFactKind(request.kind) && session.kinds !== undefined && !session.kinds.includes(request.kind)) {
    // 0026, "Writing": a write is checked at once. A kind the unit's stage does not declare is refused here, with the
    // kinds it does declare, rather than at publication, where the refusal would spend the unit's whole draft set and
    // the agent run with it.
    kindShape.push({
      field: 'kind',
      reason: `the stage ${JSON.stringify(session.stage ?? 'this unit belongs to')} writes ${session.kinds.join(', ')}, and ${shown(request.kind)} is no kind it declares: a fact of a kind its stage does not produce would be refused when its draft set is published, and the whole set with it`,
    });
  }
  refusals.push(...kindShape);
  const placeProblems = placeShape(request.place);
  refusals.push(...placeProblems);
  if (refusals.length > 0 || !isFactKind(request.kind)) return { refusals };

  const reading = await readPlace(session, request.place as unknown as CitedPlaceRequest);
  refusals.push(...reading.refusals);
  if (reading.cited === undefined) return { refusals };
  const cited = reading.cited;

  const provenance = {
    source: session.source,
    repository: { id: cited.reader.repository, commit: cited.reader.commit },
    place: cited.place,
  };
  let id: string | undefined;
  try {
    id = factId({ kind: request.kind, value: request.value as never, provenance });
  } catch (error) {
    if (!(error instanceof FactSchemaError)) throw error;
    refusals.push({ field: error.path, reason: error.detail, file: String(cited.place.file), line: cited.place.range.startLine });
  }
  if (id === undefined) return { refusals };
  const fact = {
    kind: request.kind,
    schemaVersion: FACT_KINDS[request.kind].version,
    id,
    provenance,
    layer: session.layer,
    status: 'proposed',
    value: request.value,
  };
  for (const problem of checkFact(fact)) {
    refusals.push({
      field: problem.path,
      reason: problem.message,
      ...(problem.file === undefined ? { file: String(cited.place.file) } : { file: problem.file }),
      ...(problem.line === undefined ? { line: cited.place.range.startLine } : { line: problem.line }),
    });
  }
  if (refusals.length > 0) return { refusals };

  // A module's identity is the repository, the parent and the name — no place, no
  // commit — so a proposed module named after a module the clustering holds
  // digests to that module's own id, and the publication would overwrite the
  // extracted fact the proposal asked to refine (the measured fields — the seed
  // and the member count — would be the proposal's, and the proposal itself would
  // never land). A proposal stands beside the modules it would replace, never over
  // them (0026, madarch-tzte.24.2): the graph is asked whether the id stands, and
  // a standing one refuses the write by naming it.
  if (request.kind === 'module') {
    const standing = await session.graph.node(id);
    if (standing !== null) {
      refusals.push({
        field: 'value.name',
        reason: `${JSON.stringify(id)} is the id of the module the graph already holds${standing.kind === 'module' ? '' : ` (${article(standing.kind)} "${standing.kind}" fact)`}: a proposal stands beside the modules it would replace, never over them — name the proposed module so its identity digests to an id of its own`,
        file: String(cited.place.file),
        line: cited.place.range.startLine,
      });
      return { refusals };
    }
  }

  const held = await session.draft.writes();
  const own = draftedNodes(held);
  for (const reference of referencedIds(request.value)) {
    const drafted = own.get(reference.id);
    // A node the unit's own draft set took passed the scope check when it was written,
    // so it stands where this unit writes; the graph is asked only about the others.
    const node = drafted === undefined ? await session.graph.node(reference.id) : { id: reference.id, kind: drafted, repository: session.scope.repository };
    if (node === null) {
      refusals.push({ field: reference.field, reason: `${JSON.stringify(reference.id)} stands nowhere in the graph: a write joins the nodes the graph holds — a published fact, or a write this unit's own draft set already took`, file: String(cited.place.file), line: cited.place.range.startLine });
      continue;
    }
    // The scope the unit was planned for holds the nodes it names: a proposal that
    // would replace a module of another repository is another unit's to write, and
    // naming it here would fill past the scope the run divided (0026,
    // madarch-tzte.24.2). The repository is the line a node's own fact carries — a
    // module names no path — so the folder the cited bytes stand in stays the
    // write's own place check, and the claims of a unit scoped to one document keep
    // naming the code nodes of their repository. A node the unit's own draft set
    // took passed this check when it was written; a unit of the whole product
    // covers every repository the run pins, which the pinned-commit check of the
    // cited bytes holds.
    if (drafted === undefined && !isProductScope(session.scope) && node.repository !== session.scope.repository) {
      refusals.push({
        field: reference.field,
        reason: `${JSON.stringify(reference.id)} stands in ${JSON.stringify(node.repository)}, and this unit's scope is ${scopeText(session.scope)}: a write names the nodes of its own repository`,
        file: String(cited.place.file),
        line: cited.place.range.startLine,
      });
      continue;
    }
    // An edge's ends are the kinds the edge joins, which the schema declares
    // (`EDGE_END_KINDS`): a node that stands of another kind is no end of it.
    const end = endOfReference(request.kind, reference.field);
    if (end === undefined) continue;
    const joins = EDGE_END_KINDS[request.kind as FactEdgeKind][end];
    if (joins === 'term' || joins.includes(node.kind)) continue;
    refusals.push({ field: reference.field, reason: `${JSON.stringify(reference.id)} is ${article(node.kind)} "${node.kind}" fact, and ${article(String(request.kind))} "${String(request.kind)}" edge's ${end} end is ${joins.length === 1 ? article(joins[0]!) : ''}${joins.map((kind) => `"${kind}"`).join(' or ')}: an edge joins the kinds the schema names for its ends`, file: String(cited.place.file), line: cited.place.range.startLine });
  }
  if (refusals.length > 0) return { refusals };

  const entry: StageDraftWrite = { kind: request.tool, evidence: evidenceOf(cited), value: fact as unknown };
  await session.draft.append(entry);
  // The position is the one the write took in the set it read; the count is the set's own size after it,
  // read again, so a set another writer added to is never answered as a smaller one.
  return { drafted: { ok: true, fact: fact as unknown as Fact, write: entry, position: held.length + 1, writes: (await session.draft.writes()).length, evidence: entry.evidence }, refusals };
}

/**
 * The repository a write that names one in its own value stands in: the one its cited place names, and the unit's own
 * when the place names none (a place of no repository is refused before the value is read, so this only keeps such a
 * value whole for the refusal that names the place).
 */
function repositoryCited(session: CheckedWriteSession, place: unknown): string {
  const repository = typeof place === 'object' && place !== null ? (place as Record<string, unknown>)['repository'] : undefined;
  return typeof repository === 'string' ? repository : session.scope.repository;
}

/** What one write ended in, inside the path: the fact that landed, or the refusals. */
interface Written {
  readonly drafted?: DraftedWrite;
  readonly refusals: readonly WriteRefusal[];
}

/** The answer of the three tools that answer the write alone. */
function answer(written: Written): WriteAnswer {
  return written.drafted ?? { ok: false, refusals: written.refusals };
}

/**
 * `assert_fact`: one fact of any kind the schema reads, cited to bytes madarch
 * reads at the pinned commit. The fact's own value is the agent's; its id, its
 * provenance and its layer are this path's, so an agent never writes an id and
 * never names a commit.
 */
export async function assertFact(session: CheckedWriteSession, request: AssertFactRequest): Promise<WriteAnswer> {
  return answer(await write(session, { tool: 'fact', kind: request?.kind, value: request?.value, place: request?.place }));
}

/** `link`: one edge of the schema, joining nodes the graph holds. */
export async function link(session: CheckedWriteSession, request: LinkRequest): Promise<WriteAnswer> {
  return answer(await write(session, { tool: 'link', kind: request?.kind, value: request?.value, place: request?.place }));
}

/**
 * `raise_question`: a question for a person, about a node of the graph or about
 * a scope, cited to the bytes that raised it.
 */
export async function raiseQuestion(session: CheckedWriteSession, request: RaiseQuestionRequest): Promise<WriteAnswer> {
  const value = {
    // The repository the question is raised in is the one its cited bytes stand in: a unit of one repository cites
    // that repository, and a unit of the whole product cites whichever it read at.
    repository: repositoryCited(session, request?.place),
    type: (request as { readonly type?: unknown })?.type,
    ...((request as { readonly about?: unknown })?.about === undefined ? {} : { about: request.about }),
    prompt: (request as { readonly prompt?: unknown })?.prompt,
  };
  return answer(await write(session, { tool: 'question', kind: 'question', value, place: request?.place }));
}

/**
 * `propose_entity`: a concept of the domain or an entity a document could be
 * about, and the entities the graph already holds that are like it. The write is
 * checked like every other one, and the similar entities are answered whether the
 * write landed or was refused: what the agent does next turns on both.
 */
export async function proposeEntity(session: CheckedWriteSession, request: ProposeEntityRequest): Promise<EntityAnswer> {
  const asked = request ?? ({} as ProposeEntityRequest);
  const repository = repositoryCited(session, asked.place);
  const value = {
    repository,
    proposed: (asked as { readonly proposed?: unknown }).proposed,
    name: (asked as { readonly name?: unknown }).name,
    ...(asked.summary === undefined ? {} : { summary: asked.summary }),
    ...(asked.aliases === undefined ? {} : { aliases: asked.aliases }),
  };
  const written = await write(session, { tool: 'entity', kind: 'entity-proposal', value, place: asked.place });
  const found = typeof asked.name === 'string'
    ? await session.graph.similarEntities({ repository, name: asked.name })
    : [];
  const ordered = [...found].sort((left, right) => rank(left.similarity) - rank(right.similarity) || byCodePoint(left.id, right.id));
  return {
    ...(written.drafted ?? { ok: false as const, refusals: written.refusals }),
    similar: {
      found: ordered.slice(0, SIMILAR_ENTITY_CAP),
      total: ordered.length,
      truncated: ordered.length > SIMILAR_ENTITY_CAP,
      cap: SIMILAR_ENTITY_CAP,
    },
  };
}

/** How close a similarity is, so the closest entities come first. */
function rank(similarity: Similarity): number {
  return similarity === 'same-name' ? 0 : similarity === 'contains-name' ? 1 : 2;
}

// ---- what the graph answers, over the fill's own fact store ----------------

/** One row of the fact store this port reads: the entity proposals of one repository. */
interface ProposalRow extends Record<string, unknown> { id: string; value: unknown }

/** A JSON column as a value: PostgreSQL drivers answer `jsonb` objects, and a text-encoded one is parsed. */
function column(value: unknown): unknown {
  return typeof value === 'string' ? JSON.parse(value) : value;
}

/** A name as this search folds it: lower case, every run of characters that are no letter or digit read as one space. */
function folded(name: string): string {
  return name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

/**
 * How two names are alike, as this search judges it: the same folded name, one
 * folded name holding the other as whole words, or the two sharing a word of
 * three characters or more. A name that folds to nothing is like nothing.
 */
function similarityOf(proposed: string, existing: string): Similarity | undefined {
  const left = folded(proposed);
  const right = folded(existing);
  if (left === '' || right === '') return undefined;
  if (left === right) return 'same-name';
  const words = (name: string): readonly string[] => name.split(' ').filter((word) => word !== '');
  const held = (whole: string, part: string): boolean => whole === part || whole.startsWith(`${part} `) || whole.endsWith(` ${part}`) || whole.includes(` ${part} `);
  if (held(left, right) || held(right, left)) return 'contains-name';
  const existingWords = new Set(words(right).filter((word) => word.length >= 3));
  return words(left).some((word) => word.length >= 3 && existingWords.has(word)) ? 'shares-word' : undefined;
}

/**
 * The write path's graph, read over the fill's own fact store
 * (`fact-store.ts`): the nodes are the published facts, and the entities a
 * proposal is compared with are the `entity-proposal` facts the graph holds for
 * that repository.
 *
 * A draft set another unit holds is read as draft by the read tools
 * (madarch-tzte.20.3) and is not a node here: it is a proposal its holder may
 * still retract, and 0027 makes a node stand when its unit publishes.
 */
export function factGraph(database: FactStoreDatabase): CheckedWriteGraph {
  return {
    async node(id: string): Promise<WrittenNode | null> {
      const at = here();
      return await withLocation(at, `writeGraph.node(${id})`, ['fill_fact'], async () => await database.transaction('snapshot', async (executor: SqlExecutor) => {
        const { rows } = await executor.query<{ id: string; kind: string; provenance: unknown }>('SELECT id, kind, provenance FROM fill_fact WHERE id = $1', [id]);
        const row = rows[0];
        if (row === undefined || !isFactKind(row.kind)) return null;
        // The node's own provenance names where it stands, which is what keeps a
        // write that names it inside its unit's scope (0026: a unit never fills
        // another unit's scope).
        const cited = (row.provenance ?? {}) as { repository?: { id?: unknown } };
        const repository = cited.repository?.id;
        if (typeof repository !== 'string' || repository === '') {
          throw new Error(`the fact ${id} stands in no repository its provenance names: a stored fact names the repository and commit it was read at`);
        }
        return { id: row.id, kind: row.kind, repository };
      }));
    },
    async similarEntities(request: { readonly repository: string; readonly name: string }): Promise<readonly SimilarEntity[]> {
      const at = here();
      return await withLocation(at, `writeGraph.similarEntities(${request.repository})`, ['fill_fact'], async () => await database.transaction('snapshot', async (executor: SqlExecutor) => {
        const { rows } = await executor.query<ProposalRow>(
          `SELECT id, value FROM fill_fact WHERE kind = 'entity-proposal' AND value->>'repository' = $1 ORDER BY id ASC`,
          [request.repository],
        );
        const found: SimilarEntity[] = [];
        for (const row of rows) {
          const value = column(row.value) as { readonly repository?: unknown; readonly proposed?: unknown; readonly name?: unknown };
          if (typeof value.name !== 'string' || (value.proposed !== 'concept' && value.proposed !== 'entity')) continue;
          const similarity = similarityOf(request.name, value.name);
          if (similarity === undefined) continue;
          found.push({ id: row.id, repository: request.repository, proposed: value.proposed, name: value.name, similarity });
        }
        // The order is this store's own, never the database's collation: code point order of the ids.
        return found.sort((left, right) => byCodePoint(left.id, right.id));
      }));
    },
  };
}
