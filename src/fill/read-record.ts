/**
 * How one read is recorded as a unit's dependency (decision 0027): the text a
 * recheck replays, and the membership its answer stands under. The fill's two
 * record passes read git and publish directly, so a unit of this step makes no
 * graph read through the orchestrator; the recorder still answers every read a
 * later stage makes, with the text as it was asked and a digest of the rows.
 */
import { sha256Hex } from '../graph/digest.js';

/** A read the orchestrator's reader refused: the stage's own words, handed back unchanged. */
export class GraphReadRefusal extends Error {}

/** The text one read is recorded under: a span without the commit it was read at, every other read as asked. */
export function readText(request: { readonly read: string; readonly [field: string]: unknown }): string {
  if (request.read === 'span') {
    return JSON.stringify({ read: 'span', repository: request.repository, file: request.file, startLine: request.startLine, endLine: request.endLine });
  }
  return JSON.stringify(request);
}

/** The text one read is recorded under: a span without the commit it was read at, every other read as asked. */
export function recordedReadText(text: string): string {
  try {
    return readText(JSON.parse(text) as { readonly read: string; readonly [field: string]: unknown });
  } catch {
    return text;
  }
}

/** The membership one read's answer stands under: a digest of its rows in their order. */
export function answerMembership(_text: string, rows: readonly unknown[]): string {
  return sha256Hex(new TextEncoder().encode(JSON.stringify(rows)));
}
