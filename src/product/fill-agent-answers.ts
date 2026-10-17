/** Tolerant parsing, strict validation and bounded retry of free-form agent answers. */
import type { RegistryKind } from './contract.js';
import type { ClaimSource } from './fill-claims.js';

/** A malformed answer is retried with its validation errors this many times before its unit fails. */
export const AGENT_ANSWER_MAX_RETRIES = 2;
export const CLAIM_LAYERS = ['fact', 'intent-evidence', 'assumed-meaning'] as const;

/** Pull the JSON value out of a raw answer: plain JSON, a fenced block, or JSON surrounded by prose. */
export function parseAgentAnswer(raw: string): { ok: true; value: unknown } | { ok: false; error: string } {
  const trimmed = raw.trim();
  const fail = (error: unknown): { ok: false; error: string } => ({ ok: false, error: error instanceof Error ? error.message : String(error) });
  if (!trimmed) return { ok: false, error: 'Agent returned an empty answer' };
  try { return { ok: true, value: JSON.parse(trimmed) }; } catch { /* permit fenced JSON from model output */ }
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) { try { return { ok: true, value: JSON.parse(fenced[1]!) }; } catch (error) { return fail(error); } }
  const start = trimmed.indexOf('{'); const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) { try { return { ok: true, value: JSON.parse(trimmed.slice(start, end + 1)) }; } catch (error) { return fail(error); } }
  return { ok: false, error: 'Agent returned no JSON object' };
}

/** Strict array field: no unambiguous single-value form exists for this field. */
export function asArray<T>(value: unknown, name: string): T[] { if (!Array.isArray(value)) throw new Error(`Agent output field ${name} must be an array`); return value as T[]; }

/** A single id string is unambiguously a one-element list; every other shape must be a real array. */
export function asSourceIdList(value: unknown, name: string): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value as string[];
  throw new Error(`Agent output field ${name} must be an array`);
}

/** Claims may arrive as a top-level array or under a "claims" key; anything else is invalid. */
export function claimRowsFromAnswer(answer: unknown): unknown[] {
  if (Array.isArray(answer)) return answer;
  const rows = (answer as { claims?: unknown } | null)?.claims;
  if (Array.isArray(rows)) return rows;
  throw new Error('Agent output field claims must be an array');
}

/** Collect every validation error of a claims answer, in row order; an empty list means the answer is usable. */
export function validateClaimsAnswer(answer: unknown, kinds: readonly RegistryKind[], sources: readonly ClaimSource[]): string[] {
  let rows: unknown[];
  try { rows = claimRowsFromAnswer(answer); } catch (error) { return [(error as Error).message]; }
  const kindByName = new Map(kinds.map((kind) => [kind.name, kind]));
  const knownSourceIds = new Set(sources.map((source) => source.id));
  const errors: string[] = [];
  rows.forEach((row, index) => {
    const at = `claims[${index}]`;
    if (!row || typeof row !== 'object' || Array.isArray(row)) { errors.push(`${at}: claim must be a JSON object`); return; }
    const claim = row as Record<string, unknown>;
    if (typeof claim.kind !== 'string' || !kindByName.has(claim.kind)) errors.push(`${at}.kind: unknown registry kind ${JSON.stringify(claim.kind ?? null)}`);
    if (typeof claim.text !== 'string' || !claim.text.trim()) errors.push(`${at}.text: must be a non-empty string`);
    const confidence = claim.confidence ?? 0.8;
    if (typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) errors.push(`${at}.confidence: must be a number from 0 through 1`);
    if (typeof claim.layer !== 'string' || !CLAIM_LAYERS.includes(claim.layer as typeof CLAIM_LAYERS[number])) errors.push(`${at}.layer: must be one of ${CLAIM_LAYERS.join(', ')}`);
    const ids = asSourceIdListOrUndefined(claim.sourceIds);
    if (!ids) errors.push(`${at}.sourceIds: must be an array of source ids`);
    else {
      if (ids.length === 0) errors.push(`${at}.sourceIds: must cite at least one source id`);
      for (const id of ids) if (typeof id !== 'string' || !knownSourceIds.has(id)) errors.push(`${at}.sourceIds: unknown source id ${JSON.stringify(id)}`);
    }
  });
  return errors;
}

function asSourceIdListOrUndefined(value: unknown): unknown[] | undefined {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value;
  return undefined;
}

export interface AgentAnswerOutcome {
  ok: boolean;
  /** The validated value; present only when ok. */
  value?: unknown;
  /** The exact validation errors of the last answer, in row order; empty when ok. */
  errors: string[];
  /** Every raw answer in attempt order, the failed ones included. */
  answers: string[];
  attempts: number;
}

/**
 * Ask the agent for an answer and retry a bounded number of times, feeding the exact validation
 * errors and the previous raw answer back. After the retries are spent the outcome fails with the
 * last errors and every raw answer, so the caller can fail one unit and let the run go on.
 */
export async function requestValidatedAgentAnswer(options: {
  prompt: string;
  call: (prompt: string) => Promise<string>;
  validate: (value: unknown) => string[];
  retries?: number;
}): Promise<AgentAnswerOutcome> {
  const retries = options.retries ?? AGENT_ANSWER_MAX_RETRIES;
  const answers: string[] = [];
  let prompt = options.prompt;
  for (let attempt = 1; ; attempt++) {
    const raw = await options.call(prompt);
    answers.push(raw);
    const parsed = parseAgentAnswer(raw);
    const errors = parsed.ok ? options.validate(parsed.value) : [parsed.error];
    if (errors.length === 0) return { ok: true, value: parsed.ok ? parsed.value : undefined, errors, answers, attempts: attempt };
    if (attempt > retries) return { ok: false, errors, answers, attempts: attempt };
    prompt = `${options.prompt}\n\nYour previous answer was invalid. Fix every error below and return only corrected JSON.\nValidation errors:\n${errors.map((error) => `- ${error}`).join('\n')}\n\nYour previous answer was:\n${raw}`;
  }
}
