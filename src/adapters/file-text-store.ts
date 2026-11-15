/**
 * The store's file-text requests (madarch-u3vw.16, decision 0037): a file's text is read one way — by (repository, blob
 * id) from git's object store, through the git plugin in the plugin host. A page answers from another process, so the
 * request is a row here, never an engine read: the api role asks with the product, the plugin's folder, the repository
 * checkout and the blob id the graph holds; the plugin host claims the request, reads the blob through the plugin and
 * writes the answer; the api reads the answer back by id.
 *
 * The table is created on first use by this adapter (a store prepared before it existed still answers), and a claim
 * carries a lease, so a host that died mid-read leaves the request to the next pass.
 */
import type { DatabaseOwner } from './database-owner.js';
import { requireSchema } from './store-readiness.js';

/** The part of the owner these statements borrow. */
export type FileTextDatabase = Pick<DatabaseOwner, 'transaction'>;

/** One request: a blob of one repository, and the lines asked for (1-based, inclusive). */
export interface FileTextAsk {
  readonly id: string;
  readonly product: string;
  readonly plugin: string;
  readonly repository: string;
  readonly root: string;
  readonly blob: string;
  readonly from: number;
  readonly to: number | null;
}

/** One answer: the lines' text, the whole blob's line and byte counts, and whether it is text at all. */
export interface FileTextAnswer {
  readonly text: string;
  readonly lines: number;
  readonly bytes: number;
  readonly binary: boolean;
}

/** The table's name, for the failures this adapter raises. */
const TABLE = 'file_text_request';

/** How long a claim holds a request before another pass may take it: a read of a blob is quick, and a dead host's lease ends. */
const CLAIM_LEASE_MS = 60_000;

const err = (operation: string, error: unknown): Error =>
  new Error(`${import.meta.filename}:1: the store's ${operation} of ${TABLE} failed: ${error instanceof Error ? error.message : String(error)}`);

/** A store prepared before this table existed refuses by name: the owner's preparation is the one schema writer. */
async function requireReady(database: FileTextDatabase): Promise<void> {
  await requireSchema(database, 'file-text');
}

/** Asks for one blob's text: the page's request, made by the api role. */
export async function askFileText(database: FileTextDatabase, ask: FileTextAsk, at = Date.now()): Promise<void> {
  await requireReady(database);
  try {
    await database.transaction('write', async (tx) => {
      await tx.query(`INSERT INTO ${TABLE} (id, product, plugin, repository, root, blob, from_line, to_line, requested_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [ask.id, ask.product, ask.plugin, ask.repository, ask.root, ask.blob, ask.from, ask.to, at]);
    });
  } catch (error) { throw err('ask', error); }
}

/** The oldest unanswered requests, claimed for this pass: two hosts never read the same one. */
export async function claimFileTexts(database: FileTextDatabase, at = Date.now(), limit = 4): Promise<readonly FileTextAsk[]> {
  await requireReady(database);
  try {
    return await database.transaction('write', async (tx) => {
      const rows = await tx.query<{ id: string; product: string; plugin: string; repository: string; root: string; blob: string; from_line: number; to_line: number | null }>(`
        UPDATE ${TABLE} SET claimed_at = $1
        WHERE id IN (
          SELECT id FROM ${TABLE}
          WHERE answered_at IS NULL AND (claimed_at IS NULL OR claimed_at < $2)
          ORDER BY requested_at
          FOR UPDATE SKIP LOCKED
          LIMIT $3
        )
        RETURNING id, product, plugin, repository, root, blob, from_line, to_line`, [at, at - CLAIM_LEASE_MS, limit]);
      return rows.rows.map((row) => ({
        id: row.id, product: row.product, plugin: row.plugin, repository: row.repository, root: row.root, blob: row.blob,
        from: Number(row.from_line), to: row.to_line === null ? null : Number(row.to_line),
      }));
    });
  } catch (error) { throw err('claim', error); }
}

/** Writes one answer: the text the blob holds, or the words of why it could not be read. */
export async function answerFileText(database: FileTextDatabase, id: string, answer: { readonly text?: FileTextAnswer; readonly error?: string }, at = Date.now()): Promise<void> {
  try {
    await database.transaction('write', async (tx) => {
      if (answer.text === undefined) {
        await tx.query(`UPDATE ${TABLE} SET error = $2, answered_at = $3 WHERE id = $1`, [id, answer.error ?? 'the read ended without an answer', at]);
        return;
      }
      await tx.query(`UPDATE ${TABLE} SET text = $2, lines = $3, bytes = $4, is_binary = $5, answered_at = $6 WHERE id = $1`, [id, answer.text.text, answer.text.lines, answer.text.bytes, answer.text.binary, at]);
    });
  } catch (error) { throw err('answer', error); }
}

/** The answer to one request, or null while it has none. */
export async function readFileTextAnswer(database: FileTextDatabase, id: string): Promise<{ readonly answer?: FileTextAnswer; readonly error?: string } | null> {
  await requireReady(database);
  try {
    return await database.transaction('snapshot', async (tx) => {
      const rows = await tx.query<{ text: string | null; lines: number | null; bytes: number | null; is_binary: boolean | null; error: string | null; answered_at: bigint | null }>(`SELECT text, lines, bytes, is_binary, error, answered_at FROM ${TABLE} WHERE id = $1`, [id]);
      const row = rows.rows[0];
      if (row === undefined || row.answered_at === null) return null;
      if (row.error !== null) return { error: row.error };
      return { answer: { text: row.text ?? '', lines: Number(row.lines ?? 0), bytes: Number(row.bytes ?? 0), binary: row.is_binary === true } };
    });
  } catch (error) { throw err('read', error); }
}

/** Drops a request once its answer was read: a page asks again when it wants the text again. */
export async function forgetFileText(database: FileTextDatabase, id: string): Promise<void> {
  try {
    await database.transaction('write', async (tx) => { await tx.query(`DELETE FROM ${TABLE} WHERE id = $1`, [id]); });
  } catch (error) { throw err('forget', error); }
}
