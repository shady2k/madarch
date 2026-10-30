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
  /** The estimate of file reads the answer saved: the files it covered. */
  readonly readsSaved: number;
  readonly durationMs: number;
  readonly revision: { readonly commit: string; readonly branch: string };
}

/** How one tool's calls added up. */
export interface JournalToolSummary {
  readonly tool: string;
  readonly calls: number;
  readonly answerBytes: number;
  readonly reextracted: number;
  readonly readsSaved: number;
}

/** What a whole journal adds up to. */
export interface JournalSummary {
  readonly file: string;
  readonly calls: number;
  readonly answerBytes: number;
  readonly reextractions: number;
  readonly readsSaved: number;
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

/** What a journal adds up to, by tool, in code point order of the tool's name. */
export function summarize(folder: string): JournalSummary {
  const entries = readJournal(folder);
  const byTool = new Map<string, { calls: number; answerBytes: number; reextracted: number; readsSaved: number }>();
  let answerBytes = 0;
  let reextractions = 0;
  let readsSaved = 0;
  for (const entry of entries) {
    const held = byTool.get(entry.tool) ?? { calls: 0, answerBytes: 0, reextracted: 0, readsSaved: 0 };
    held.calls += 1;
    held.answerBytes += entry.answerBytes;
    held.reextracted += entry.reextracted.length;
    held.readsSaved += entry.readsSaved;
    byTool.set(entry.tool, held);
    answerBytes += entry.answerBytes;
    reextractions += entry.reextracted.length;
    readsSaved += entry.readsSaved;
  }
  const tools = [...byTool.entries()]
    .map(([tool, held]) => ({ tool, ...held }))
    .sort((left, right) => byCodePoint(left.tool, right.tool));
  return { file: journalFile(folder), calls: entries.length, answerBytes, reextractions, readsSaved, tools, last: entries.at(-1) ?? null };
}

/** The summary as a person reads it, one line per tool. */
export function summaryLines(summary: JournalSummary): string[] {
  if (summary.calls === 0) return [`madarch mcp: no call is journaled in ${summary.file}`];
  const lines = [`madarch mcp: ${summary.calls} calls journaled in ${summary.file}`];
  for (const tool of summary.tools) {
    lines.push(`  ${tool.tool}: ${tool.calls} calls, ${tool.reextracted} files re-extracted, ${tool.answerBytes} answer bytes, ${tool.readsSaved} file reads saved`);
  }
  lines.push(`total: ${summary.calls} calls, ${summary.reextractions} file re-extractions, ${summary.answerBytes} answer bytes, ${summary.readsSaved} file reads saved`);
  if (summary.last !== null) lines.push(`last call: ${summary.last.at} ${summary.last.tool} at ${summary.last.revision.commit.slice(0, 12)}`);
  return lines;
}
