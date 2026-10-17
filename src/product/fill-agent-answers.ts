/**
 * The critic's answer: an array of concrete findings. A plain string is used as it is; a finding
 * whose substance arrives as an object (`{type, segment, detail}` is the shape the checkpoint's
 * flash model produced) is flattened to one string, `type: detail` or `type: segment`. Nothing
 * else is invented.
 */
export function parseCriticAnswer(answer: unknown): { ok: true; value: { findings: string[] } } | { ok: false; errors: string[] } {
  if (!isRecord(answer)) return { ok: false, errors: ['Agent answer must be a JSON object'] };
  const raw = typeof answer.finding === 'string' ? [answer.finding] : Array.isArray(answer.findings) ? answer.findings : undefined;
  const errors: string[] = [];
  if (!raw) errors.push('Agent output field findings must be an array');
  const findings: string[] = [];
  for (const [index, entry] of (raw ?? []).entries()) {
    if (typeof entry === 'string' && entry.trim()) { findings.push(entry); continue; }
    if (isRecord(entry)) {
      const type = typeof entry.type === 'string' ? entry.type : undefined;
      const substance = typeof entry.detail === 'string' && entry.detail.trim() ? entry.detail : typeof entry.text === 'string' && entry.text.trim() ? entry.text : typeof entry.segment === 'string' && entry.segment.trim() ? entry.segment : undefined;
      if (substance) { findings.push(type ? `${type}: ${substance}` : substance); continue; }
      if (type) { findings.push(type); continue; }
    }
    errors.push(`findings[${index}]: must be one concrete finding as a string, or an object with at least a type, text, segment or detail`);
  }
  return errors.length === 0 ? { ok: true, value: { findings } } : { ok: false, errors };
}

/** Tolerant parsing, strict validation and bounded retry of free-form agent answers. */
import { QUESTION_TYPES } from '../product-wiki/questions.js';
import type { RegistryKind } from './contract.js';
import type { ClaimSource } from './fill-claims.js';

/** A malformed answer is retried with its validation errors this many times before its unit fails. */
export const AGENT_ANSWER_MAX_RETRIES = 2;
export const CLAIM_LAYERS = ['fact', 'intent-evidence', 'assumed-meaning'] as const;

/** Thrown when an answer is still invalid after the bounded retries: it carries every raw answer and the last errors, so a caller can fail one unit and let the run go on. */
export class AgentAnswerError extends Error {
  readonly errors: string[];
  readonly answers: string[];
  constructor(errors: string[], answers: string[]) {
    super(`Agent answer stayed invalid after the retries: ${errors.join('; ')}`);
    this.name = 'AgentAnswerError';
    this.errors = errors;
    this.answers = answers;
  }
}

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

/** One question the agent reports on top of its claims, matched to claims by exact text. */
export interface AgentQuestionRow { type: string; title: string; prompt: string; kind?: string; missing?: string; claimTexts?: string[]; }

/** Read the optional typed questions the agent reports; absent or empty means none. */
export function agentQuestionsFromAnswer(answer: unknown): AgentQuestionRow[] {
  const rows = (answer as { questions?: unknown } | null)?.questions;
  if (rows === undefined) return [];
  return asArray<AgentQuestionRow>(rows, 'questions');
}

/** Collect every validation error of a claims answer, in row order; an empty list means the answer is usable. */
export function validateClaimsAnswer(answer: unknown, kinds: readonly RegistryKind[], sources: readonly ClaimSource[]): string[] {
  let rows: unknown[];
  try { rows = claimRowsFromAnswer(answer); } catch (error) { return [(error as Error).message]; }

  const kindByName = new Map(kinds.map((kind) => [kind.name, kind]));
  const knownSourceIds = new Set(sources.map((source) => source.id));
  const errors: string[] = [];
  // assembleClaims derives one claim id from kind, text and the sorted source-id set and refuses a
  // duplicate; such an answer must be retried, not passed through to a throw past the unit failure.
  const seenClaims = new Map<string, number>();
  const claimTexts = new Set<string>();
  rows.forEach((row, index) => {
    const at = `claims[${index}]`;
    if (!row || typeof row !== 'object' || Array.isArray(row)) { errors.push(`${at}: claim must be a JSON object`); return; }
    const claim = row as Record<string, unknown>;
    if (typeof claim.kind !== 'string' || !kindByName.has(claim.kind)) errors.push(`${at}.kind: unknown registry kind ${JSON.stringify(claim.kind ?? null)}`);
    if (typeof claim.text !== 'string' || !claim.text.trim()) errors.push(`${at}.text: must be a non-empty string`);
    if (typeof claim.text === 'string' && claim.text.trim()) claimTexts.add(claim.text);
    const confidence = claim.confidence ?? 0.8;
    if (typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) errors.push(`${at}.confidence: must be a number from 0 through 1`);
    if (typeof claim.layer !== 'string' || !CLAIM_LAYERS.includes(claim.layer as typeof CLAIM_LAYERS[number])) errors.push(`${at}.layer: must be one of ${CLAIM_LAYERS.join(', ')}`);
    const ids = asSourceIdListOrUndefined(claim.sourceIds);
    if (!ids) errors.push(`${at}.sourceIds: must be an array of source ids`);
    else {
      if (ids.length === 0) errors.push(`${at}.sourceIds: must cite at least one source id`);
      for (const id of ids) if (typeof id !== 'string' || !knownSourceIds.has(id)) errors.push(`${at}.sourceIds: unknown source id ${JSON.stringify(id)}`);
      if (typeof claim.kind === 'string' && typeof claim.text === 'string') {
        const key = `${claim.kind}\u0000${claim.text}\u0000${[...new Set(ids.filter((id): id is string => typeof id === 'string'))].sort().join('\u0000')}`;
        const first = seenClaims.get(key);
        if (first !== undefined) errors.push(`${at}: duplicate of claims[${first}]: the same kind, text and source ids are one claim, return it once`);
        else seenClaims.set(key, index);
      }
    }
    for (const field of ['conflictsWith'] as const) {
      const value = claim[field];
      if (value !== undefined && (typeof value !== 'string' || !(value as string).trim())) errors.push(`${at}.${field}: must be a non-empty string when present`);
    }
    if (claim.undocumented !== undefined && typeof claim.undocumented !== 'boolean') errors.push(`${at}.undocumented: must be a boolean when present`);
    if (claim.termPair !== undefined) {
      const pair = claim.termPair as Record<string, unknown> | null;
      if (!pair || typeof pair !== 'object' || Array.isArray(pair) || typeof pair.documentTerm !== 'string' || !pair.documentTerm.trim() || typeof pair.codeTerm !== 'string' || !pair.codeTerm.trim()) errors.push(`${at}.termPair: must be an object with non-empty documentTerm and codeTerm strings`);
    }
  });
  validateQuestionsAnswer(answer, questionRowsOf(answer, errors), errors, kindByName, claimTexts);
  return errors;
}

/** Read the questions list for validation; a failed read reports its error in place of the rows. */
function questionRowsOf(answer: unknown, errors: string[]): AgentQuestionRow[] {
  try { return agentQuestionsFromAnswer(answer); } catch (error) { errors.push((error as Error).message); return []; }
}

/** Validate the optional typed questions the agent reports; errors join the claims' errors. */
function validateQuestionsAnswer(answer: unknown, rows: readonly AgentQuestionRow[], errors: string[], kinds: ReadonlyMap<string, RegistryKind>, claimTexts: ReadonlySet<string>): void {
  if (rows.length === 0) return;
  const seenQuestions = new Map<string, number>();
  rows.forEach((row, index) => {
    const at = `questions[${index}]`;
    if (!row || typeof row !== 'object' || Array.isArray(row)) { errors.push(`${at}: question must be a JSON object`); return; }
    const question = row as unknown as Record<string, unknown>;
    if (typeof question.type !== 'string' || !QUESTION_TYPES.includes(question.type as never)) errors.push(`${at}.type: must be one of ${QUESTION_TYPES.join(', ')}`);
    if (typeof question.title !== 'string' || !question.title.trim()) errors.push(`${at}.title: must be a non-empty string`);
    if (typeof question.prompt !== 'string' || !question.prompt.trim()) errors.push(`${at}.prompt: must be a non-empty string`);
    if (question.kind !== undefined && (typeof question.kind !== 'string' || !kinds.has(question.kind))) errors.push(`${at}.kind: unknown registry kind ${JSON.stringify(question.kind ?? null)}`);
    if (question.missing !== undefined && question.missing !== 'access' && question.missing !== 'document') errors.push(`${at}.missing: must be access or document`);
    if (question.type === 'access-or-document-needed' && question.missing === undefined) errors.push(`${at}.missing: access-or-document-needed questions need missing set to access or document`);
    if (question.claimTexts !== undefined) {
      const texts = question.claimTexts;
      if (!Array.isArray(texts) || texts.some((text) => typeof text !== 'string' || !text.trim())) errors.push(`${at}.claimTexts: must be an array of non-empty claim texts`);
      else {
        for (const text of texts as string[]) {
          if (![...claimTexts].some((claim) => claim.trim() === text.trim())) errors.push(`${at}.claimTexts: no claim in this answer has the text ${JSON.stringify(text)}; copy the exact text of a claim you returned`);
        }
      }
    }
    if (typeof question.type !== 'string' || typeof question.title !== 'string') return;
    const key = `${question.type}\u0000${question.title}`;
    const first = seenQuestions.get(key);
    if (first !== undefined) errors.push(`${at}: duplicate of questions[${first}]: the same type and title is one question, return it once`);
    else seenQuestions.set(key, index);
  });
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

/** A synthesis candidate claim record as it was supplied to the generator. */
export interface SynthesisCandidateClaim { id: string; kind?: string; text?: string; layer?: string; confidence?: number; unitId?: string; sourceIds?: readonly string[]; verification?: string }

/** A parsed synthesis prose segment: the paraphrase plus the claims that support it. */
export interface ParsedSynthesisSegment { text: string; layer: typeof CLAIM_LAYERS[number]; sourceIds: string[]; claimIds?: string[] }
export interface ParsedSynthesisAnswer { title: string; body: string; claims: unknown[]; segments: ParsedSynthesisSegment[] }

/** What a segment needs from the supplied claims to carry prose: unambiguous shapes only. */
export interface SynthesisAnswerRules {
  /** The claim records supplied to the generator for this page, authoritative and unaltered. */
  claims: readonly SynthesisCandidateClaim[];
  /** Every source id the page may cite. */
  sourceIds: readonly string[];
  /** A kind page may answer with neither claims nor segments and get the absence question. */
  absenceAllowed: boolean;
}

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const unique = (ids: readonly string[]): string[] => [...new Set(ids)];

/**
 * Segment rows tolerate `prose` for `text` and `proseSegments` for `segments` (the shapes the
 * checkpoint's flash model produced); a claim id cited inside `sourceIds` names a claim, not a
 * source, and moves to `claimIds`. The supplied claim records stay authoritative: an echoed id
 * resolves to the supplied record, so an answer can never alter a claim.
 */
export function parseSynthesisAnswer(answer: unknown, rules: SynthesisAnswerRules): { ok: true; value: ParsedSynthesisAnswer } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (!isRecord(answer)) return { ok: false, errors: ['Agent answer must be a JSON object'] };
  const candidateById = new Map(rules.claims.map((claim) => [claim.id, claim]));
  const knownSources = new Set(rules.sourceIds);
  const rawTitle = answer.title;
  const title = typeof rawTitle === 'string' ? rawTitle : '';
  if (!title.trim()) errors.push('title: must be a non-empty string');
  const rawSegments = Array.isArray(answer.segments) ? answer.segments : Array.isArray(answer.proseSegments) ? answer.proseSegments : undefined;
  if (!rawSegments) errors.push('Agent output field segments must be an array (a "proseSegments" key is also accepted)');
  const selected = new Map<string, SynthesisCandidateClaim>();
  if (answer.claims !== undefined) {
    if (!Array.isArray(answer.claims)) errors.push('Agent output field claims must be an array');
    else for (const [index, row] of answer.claims.entries()) {
      const id = isRecord(row) && typeof row.id === 'string' ? row.id : undefined;
      const candidate = id !== undefined ? candidateById.get(id) : undefined;
      if (!candidate) errors.push(`claims[${index}]: unknown claim id ${JSON.stringify(id ?? null)}; copy the supplied claim records unchanged, by their claim ids`);
      else selected.set(candidate.id, candidate);
    }
  }
  const segments: ParsedSynthesisSegment[] = [];
  for (const [index, row] of (rawSegments ?? []).entries()) {
    const at = `segments[${index}]`;
    if (!isRecord(row)) { errors.push(`${at}: must be a JSON object`); continue; }
    const text = typeof row.text === 'string' && row.text.trim() ? row.text : typeof row.prose === 'string' && row.prose.trim() ? row.prose : undefined;
    if (text === undefined) errors.push(`${at}.text: must be a non-empty string ("text"; "prose" is also accepted)`);
    const layer = typeof row.layer === 'string' && CLAIM_LAYERS.includes(row.layer as typeof CLAIM_LAYERS[number]) ? row.layer as typeof CLAIM_LAYERS[number] : undefined;
    if (layer === undefined) errors.push(`${at}.layer: must be one of ${CLAIM_LAYERS.join(', ')}`);
    const ids = typeof row.sourceIds === 'string' ? [row.sourceIds] : Array.isArray(row.sourceIds) ? row.sourceIds : undefined;
    if (!ids) { errors.push(`${at}.sourceIds: must be an array of source ids`); continue; }
    const strings = ids.filter((id): id is string => typeof id === 'string');
    if (strings.length !== ids.length) errors.push(`${at}.sourceIds: must be an array of source id strings`);
    if (strings.length === 0) errors.push(`${at}.sourceIds: must cite at least one source or claim id`);
    const citedClaims = strings.filter((id) => candidateById.has(id));
    const citedSources = strings.filter((id) => !candidateById.has(id));
    for (const id of citedSources) if (!knownSources.has(id)) errors.push(`${at}.sourceIds: unknown source id ${JSON.stringify(id)}`);
    // A single claim id string is unambiguously a one-element list; non-string list entries are refused.
    const rawClaimIds = typeof row.claimIds === 'string' ? [row.claimIds] : Array.isArray(row.claimIds) ? row.claimIds : undefined;
    const explicit = rawClaimIds === undefined ? [] : rawClaimIds.filter((id): id is string => typeof id === 'string');
    if (rawClaimIds !== undefined && explicit.length !== rawClaimIds.length) errors.push(`${at}.claimIds: must be an array of claim id strings`);
    for (const id of explicit) if (!candidateById.has(id)) errors.push(`${at}.claimIds: unknown claim id ${JSON.stringify(id)}; cite the supplied claim records, unchanged`);
    const claimIds = unique([...explicit, ...citedClaims]);
    for (const id of claimIds) { const candidate = candidateById.get(id); if (candidate) selected.set(id, candidate); }
    if (claimIds.length > 0) {
      const resolved = claimIds.map((claimId) => candidateById.get(claimId)).filter((claim): claim is SynthesisCandidateClaim => Boolean(claim));
      for (const id of citedSources) if (!resolved.some((claim) => claim.sourceIds?.includes(id))) errors.push(`${at}: cited source ${JSON.stringify(id)} is not named by any claim the segment rests on; every cited source must come from a named claim`);
      // The segment's layer must describe at least one claim it rests on, so fact prose cannot rest on assumptions alone.
      if (layer !== undefined && !resolved.some((claim) => claim.layer === layer)) errors.push(`${at}: layer ${layer} matches none of the named claims (${resolved.map((claim) => `${claim.id} of layer ${String(claim.layer)}`).join(', ')}); the segment layer must be the layer of at least one claim it names`);
    } else if (strings.length > 0) {
      errors.push(`${at}: names no supported claim; name the claim ids the prose rests on (put them in claimIds or in sourceIds), and copy those claim records into claims`);
    }
    if (text !== undefined && layer !== undefined) {
      // A segment citing only claim ids takes the sources of the claims it names: unambiguous, and
      // the reader's coverage check then sees the same ids the named claims carry.
      const sourceIds = citedSources.length > 0 ? citedSources : claimIds.flatMap((claimId) => [...(candidateById.get(claimId)!.sourceIds ?? [])]);
      segments.push({ text, layer, sourceIds: unique(sourceIds), ...(claimIds.length ? { claimIds: [...claimIds].sort() } : {}) });
    }
  }
  // The reader refuses an overview (no absence question) with neither claims nor segments.
  if (!rules.absenceAllowed && selected.size === 0 && segments.length === 0) errors.push('segments: must contain at least one segment, and claims: must name the supplied claim records the prose rests on');
  else if (!rules.absenceAllowed && selected.size === 0 && segments.length > 0) errors.push('claims: must name the supplied claim records the prose rests on; cite their claim ids');
  else if (selected.size > 0 && segments.length === 0) errors.push('segments: must contain the prose segments the named claims support, or return no claims for an absent kind');
  if (errors.length > 0) return { ok: false, errors };
  const joined = segments.map((segment) => segment.text.trim()).join('\n\n');
  const rawBody = answer.body;
  const bodyValue = typeof rawBody === 'string' && rawBody.trim() ? rawBody : joined;
  return { ok: true, value: { title, body: bodyValue, claims: [...selected.values()], segments } };
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
