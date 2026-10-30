/**
 * The journal of one served repository (madarch-ztyq.10): one line per tool
 * call, what it was asked, how large its answer was, which files the layer
 * re-extracted for it, and how many files its answer covered — the files a
 * reader would otherwise have opened. `madarch mcp --journal` prints the
 * summary, so a person can see what the serving cost and what it saved.
 *
 * The file is the state folder's own (`journal.jsonl`), beside the graph, and
 * one line is appended per call: a journal that is lost costs an accounting
 * line, never an answer.
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { byCodePoint } from '../model/order.js';

/** One call as the journal keeps it. */
export interface JournalEntry {
  readonly at: string;
  readonly tool: string;
  readonly arguments: unknown;
  /** The answer's JSON size in bytes, as the agent reads it. */
  readonly answerBytes: number;
  /** The files this call made the layer read again. */
  readonly reextracted: readonly string[];
  /** The files the answer shows or stands on: what a reader would have opened instead. */
  readonly covered: readonly string[];
  /** The reads the tool measured it avoided: the reads it did not have to make, counted per call. */
  readonly readsAvoided: number;
  /** Whether the call answered its question: an error or an ambiguity answered nothing. 1 or 0. */
  readonly questionsAnswered: number;
  /**
   * The estimate of the files the answer stands on: the files a reader would have opened to write it. An estimate,
   * not a measurement — a covered file may not have been read in full, or at all.
   */
  readonly evidenceFiles: number;
  readonly durationMs: number;
  readonly revision: { readonly commit: string; readonly branch: string };
}

/** How one tool's calls added up. */
export interface JournalToolSummary {
  readonly tool: string;
  readonly calls: number;
  readonly answerBytes: number;
  readonly reextracted: number;
  /** Distinct `(tool, arguments)` calls: the second of two identical calls saved nothing new. */
  readonly uniqueCalls: number;
  readonly readsAvoided: number;
  readonly questionsAnswered: number;
  readonly evidenceFiles: number;
}

/** What a whole journal adds up to. */
export interface JournalSummary {
  readonly file: string;
  readonly calls: number;
  readonly answerBytes: number;
  readonly reextractions: number;
  readonly uniqueCalls: number;
  readonly readsAvoided: number;
  readonly questionsAnswered: number;
  readonly evidenceFiles: number;
  readonly tools: readonly JournalToolSummary[];
  readonly last: JournalEntry | null;
}

/** The journal file of one graph folder. */
export const journalFile = (folder: string): string => join(folder, 'journal.jsonl');

/** Appends one call. */
export function recordCall(folder: string, entry: JournalEntry): void {
  appendFileSync(journalFile(folder), `${JSON.stringify(entry)}\n`, 'utf8');
}

/** Every entry the journal holds, in the order they were written; a line that does not parse is skipped by its own size. */
export function readJournal(folder: string): JournalEntry[] {
  const file = journalFile(folder);
  if (!existsSync(file)) return [];
  const entries: JournalEntry[] = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    try {
      entries.push(JSON.parse(line) as JournalEntry);
    } catch {
      // A half-written last line is a line a crash left; the calls before it are still true.
    }
  }
  return entries;
}

/**
 * What a journal adds up to, by tool, in code point order of the tool's name.
 *
 * A call is counted when it is made; a *saving* is counted once it is new. Two
 * identical calls (`get_symbol g` twice) are two calls and one avoided read:
 * the second answered the same file the first did, and counting it again would
 * report a saving nobody received (madarch-ztyq.10 review). The three numbers a
 * person reads are kept apart, because only the first is measured:
 *
 * - `readsAvoided` — the reads the tools measured they did not have to make;
 * - `questionsAnswered` — the calls that answered their question (an error or
 *   an ambiguous name answered none);
 * - `evidenceFiles` — an estimate of the files the answers stand on.
 */
export function summarize(folder: string): JournalSummary {
  const entries = readJournal(folder);
  const seen = new Set<string>();
  const byTool = new Map<string, { calls: number; answerBytes: number; reextracted: number; uniqueCalls: number; readsAvoided: number; questionsAnswered: number; evidenceFiles: number }>();
  let answerBytes = 0;
  let reextractions = 0;
  let readsAvoided = 0;
  let questionsAnswered = 0;
  let evidenceFiles = 0;
  let uniqueCalls = 0;
  for (const entry of entries) {
    const identity = `${entry.tool}\u0000${JSON.stringify(entry.arguments)}`;
    const first = !seen.has(identity);
    if (first) seen.add(identity);
    const held = byTool.get(entry.tool) ?? { calls: 0, answerBytes: 0, reextracted: 0, uniqueCalls: 0, readsAvoided: 0, questionsAnswered: 0, evidenceFiles: 0 };
    held.calls += 1;
    held.answerBytes += entry.answerBytes;
    held.reextracted += entry.reextracted.length;
    held.questionsAnswered += entry.questionsAnswered;
    if (first) {
      held.uniqueCalls += 1;
      held.readsAvoided += entry.readsAvoided;
      held.evidenceFiles += entry.evidenceFiles;
      uniqueCalls += 1;
      readsAvoided += entry.readsAvoided;
      evidenceFiles += entry.evidenceFiles;
    }
    byTool.set(entry.tool, held);
    answerBytes += entry.answerBytes;
    reextractions += entry.reextracted.length;
    questionsAnswered += entry.questionsAnswered;
  }
  const tools = [...byTool.entries()]
    .map(([tool, held]) => ({ tool, ...held }))
    .sort((left, right) => byCodePoint(left.tool, right.tool));
  return { file: journalFile(folder), calls: entries.length, uniqueCalls, answerBytes, reextractions, readsAvoided, questionsAnswered, evidenceFiles, tools, last: entries.at(-1) ?? null };
}

/** The summary as a person reads it, one line per tool. */
export function summaryLines(summary: JournalSummary): string[] {
  if (summary.calls === 0) return [`madarch mcp: no call is journaled in ${summary.file}`];
  const lines = [`madarch mcp: ${summary.calls} calls journaled in ${summary.file}`];
  for (const tool of summary.tools) {
    lines.push(`  ${tool.tool}: ${tool.calls} calls (${tool.uniqueCalls} distinct), ${tool.reextracted} files re-extracted, ${tool.answerBytes} answer bytes, ${tool.readsAvoided} file reads avoided, ${tool.questionsAnswered} questions answered, ${tool.evidenceFiles} evidence files (estimate)`);
  }
  lines.push(`total: ${summary.calls} calls (${summary.uniqueCalls} distinct), ${summary.reextractions} file re-extractions, ${summary.answerBytes} answer bytes, ${summary.readsAvoided} file reads avoided, ${summary.questionsAnswered} questions answered, ${summary.evidenceFiles} evidence files (estimate)`);
  if (summary.last !== null) lines.push(`last call: ${summary.last.at} ${summary.last.tool} at ${summary.last.revision.commit.slice(0, 12)}`);
  return lines;
}
