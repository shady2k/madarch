/** Registry-driven source-backed claim extraction and deterministic training scoring. */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve, sep } from 'node:path';
import { parseContractText, type RegistryKind } from './contract.js';
import { QUESTION_TYPES, type QuestionType } from '../product-wiki/questions.js';
import { writeFillJsonAtomic } from './fill-runtime.js';
import type { IndexedComment, IndexedSymbol, IndexedTaskKey, StructuralIndexResult } from './fill-index.js';

export type ClaimLayer = 'fact' | 'intent-evidence' | 'assumed-meaning';
export type ClaimVerification = 'verified' | 'unverified';
export interface ClaimSource {
  id: string; address: string; version: string; anchor: string; readAt: string;
  sha256: string; mediaType: string; byteLength: number; blob?: string; type: 'code' | 'document' | 'git-history' | 'link';
}
export interface ExtractedClaim {
  id: string; kind: string; text: string; layer: ClaimLayer; confidence: number;
  unitId: string; sourceIds: string[]; verification: ClaimVerification;
}
/** The `access` or `document` need an access-or-document-needed question names explicitly. */
export type QuestionMissing = 'access' | 'document';
export interface ClaimQuestion {
  id: string; type: QuestionType; reason: string; kind?: string;
  /** Set for access-or-document-needed records, the way the question documents carry it. */
  missing?: QuestionMissing;
  /** The claim and unit ids whose work this question's answer resolves. */
  dependsOn: string[];
  /** Distinct dependent page/unit count (claims excluded), the ranking score the wiki recomputes. */
  rank: number;
}
export interface AnchoredCodeFact { kind: string; text: string; path: string; anchor: string; blob: string; startByte: number; endByte: number; }
export type IndexedEvidence = IndexedSymbol | IndexedComment | IndexedTaskKey;
export type IndexedEvidenceClassifier = (evidence: IndexedEvidence) => { kind: string; text: string } | undefined;

/** Convert the structural index's typed anchors into registry-assigned, source-bound facts. */
export function anchoredFactsFromIndex(index: StructuralIndexResult, classify: IndexedEvidenceClassifier): AnchoredCodeFact[] {
  const facts: AnchoredCodeFact[] = [];
  for (const file of index.files) {
    const evidence: IndexedEvidence[] = [...file.symbols, ...file.comments, ...file.taskKeys];
    for (const item of evidence) {
      const classified = classify(item);
      if (!classified) continue;
      facts.push({ kind: classified.kind, text: classified.text, path: item.path, anchor: `lines:${item.startLine}-${item.endLine}`, blob: item.blob, startByte: item.startByte, endByte: item.endByte });
    }
  }
  return facts.sort((a,b) => a.path < b.path ? -1 : a.path > b.path ? 1 : a.startByte - b.startByte || (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0));
}
export interface ClaimsExtraction {
  claims: ExtractedClaim[]; sources: ClaimSource[]; questions: ClaimQuestion[];
  inaccessibleLinks: Array<{ url: string; status: 'not-attempted'; sourceId: string }>;
  usage: { elapsedMs: number; inputTokens: number; outputTokens: number };
}
export interface ExtractionMaterial { path: string; text: string; type: ClaimSource['type']; mediaType?: string; blob?: string; }
/** The deterministic marks a claims answer may carry per claim, turned into typed questions. */
type ClaimMarks = { conflictsWith?: string; undocumented?: boolean; termPair?: { documentTerm: string; codeTerm: string } };

/**
 * Derive typed open questions deterministically from what the extraction carries, in the types the
 * question records use: each assumed-meaning claim stands only as an interpretation to confirm
 * (assumption-check); a claim marked as conflicting with a published document asks its contradiction;
 * code behaviour no document mentions asks undocumented-behaviour; a document/code term pair asks a
 * term question; an unread link asks what access or document would resolve it. Questions the agent
 * reports itself join for the types a claim mark cannot carry, like meaning or decision rationale.
 * Every question names the claims and unit it touches and carries the dependency rank.
 */
function deriveClaimQuestions(input: {
  runId: string; unitId: string; kinds: readonly RegistryKind[];
  agentQuestions?: readonly AgentQuestion[]; inaccessibleLinks?: readonly UnattemptedLink[];
}, claims: readonly ExtractedClaim[], agentMarks: ReadonlyMap<string, ClaimMarks>, present: ReadonlySet<string>): ClaimQuestion[] {
  const questions: ClaimQuestion[] = [];
  const qid = (...pieces: string[]): string => `q-${claimId(input.runId, ...pieces)}`;
  for (const kind of input.kinds) {
    if (present.has(kind.name)) continue;
    const dependsOn = [input.unitId];
    questions.push({ id: qid('unverifiable', kind.name, kind.hint), type: 'unverifiable', kind: kind.name, reason: `No supported entity was found. Registry hint: ${kind.hint}`, dependsOn, rank: rankOf(dependsOn) });
  }
  for (const claim of claims) {
    const marks = agentMarks.get(claim.id);
    const dependsOn = [claim.id, input.unitId].sort();
    if (claim.layer === 'assumed-meaning') questions.push({ id: qid('assumption-check', claim.id), type: 'assumption-check', kind: claim.kind, reason: `Assumed meaning the reader should confirm: ${claim.text}`, dependsOn, rank: rankOf(dependsOn) });
    if (marks?.conflictsWith !== undefined) questions.push({ id: qid('contradiction', claim.id, marks.conflictsWith), type: 'contradiction', kind: claim.kind, reason: `The claim conflicts with the published document ${marks.conflictsWith}: ${claim.text}`, dependsOn, rank: rankOf(dependsOn) });
    if (marks?.undocumented) questions.push({ id: qid('undocumented-behaviour', claim.id), type: 'undocumented-behaviour', kind: claim.kind, reason: `Code behaviour no document mentions: ${claim.text}`, dependsOn, rank: rankOf(dependsOn) });
    if (marks?.termPair) questions.push({ id: qid('term', claim.id, marks.termPair.documentTerm, marks.termPair.codeTerm), type: 'term', kind: claim.kind, reason: `Documents and code name one thing differently: ${marks.termPair.documentTerm} versus ${marks.termPair.codeTerm}`, dependsOn, rank: rankOf(dependsOn) });
  }
  for (const link of input.inaccessibleLinks ?? []) {
    const cited = claims.filter((claim) => claim.sourceIds.includes(link.sourceId));
    const kind = cited[0]?.kind;
    const dependsOn = [...new Set([input.unitId, ...cited.map((claim) => claim.id)])].sort();
    questions.push({ id: qid('access-or-document-needed', link.url, link.sourceId), type: 'access-or-document-needed', ...(kind === undefined ? {} : { kind }), missing: 'access', reason: `Unread link, recorded as not attempted: ${link.url}`, dependsOn, rank: rankOf(dependsOn) });
  }
  for (const question of input.agentQuestions ?? []) {
    if (!QUESTION_TYPES.includes(question.type as QuestionType)) throw new Error(`Unknown question type in agent answer: ${String(question.type)}`);
    if (!question.title.trim() || !question.prompt.trim()) throw new Error('Agent question needs a non-empty title and prompt');
    if (question.kind !== undefined && !input.kinds.some((kind) => kind.name === question.kind)) throw new Error(`Unknown registry kind in agent question: ${question.kind}`);
    if (question.missing !== undefined && question.missing !== 'access' && question.missing !== 'document') throw new Error(`Agent question missing must be access or document: ${question.missing}`);
    const touched = claims.filter((claim) => (question.claimTexts ?? []).some((text) => text.trim() === claim.text.trim())).map((claim) => claim.id).sort();
    const dependsOn = [...new Set([input.unitId, ...touched])].sort();
    questions.push({
      id: qid(question.type, question.title), type: question.type as QuestionType, reason: question.prompt,
      ...(question.kind === undefined ? {} : { kind: question.kind }),
      ...(question.missing === undefined ? {} : { missing: question.missing as QuestionMissing }),
      dependsOn, rank: rankOf(dependsOn),
    });
  }
  const seen = new Set<string>();
  for (const question of questions) {
    if (seen.has(question.id)) throw new Error(`Duplicate question id ${question.id}`);
    seen.add(question.id);
  }
  return questions.sort(byCodePoint);
}


const claimId = (...pieces: string[]): string => createHash('sha256').update(pieces.join('\0')).digest('hex').slice(0, 24);
const byCodePoint = <T extends { id: string }>(a: T, b: T): number => a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
const rankOf = (dependencies: readonly string[]): number => new Set(dependencies.filter((id) => !id.startsWith('claim-') && !id.startsWith('clm-'))).size;
const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

/** Prompts are repository data, selected by stable file name rather than embedded agent strings. */
export async function loadClaimsPrompt(name: 'repository-claims' | 'registry-kinds'): Promise<string> {
  return readFile(new URL(`./claims-prompts/${name}.md`, import.meta.url), 'utf8');
}

/** Registry parser is shared with the product contract; invalid input is never silently narrowed. */
export function parseFillKinds(registryText: string, file = 'docs/kinds.yaml'): RegistryKind[] {
  const parsed = parseContractText(file, registryText);
  if (!parsed.ok) throw new Error(parsed.errors.map((error) => `${error.file}:${error.line}: ${error.path ? `${error.path}: ` : ''}${error.message}`).join('\n'));
  return [...parsed.kinds].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
}

/** Build pinned, hash-backed sources for repository materials. Anchors name line spans and are checked. */
export function createClaimSources(commit: string, materials: readonly ExtractionMaterial[], readAt = new Date().toISOString()): ClaimSource[] {
  if (!Number.isFinite(Date.parse(readAt)) || !readAt.endsWith('Z')) throw new Error('readAt must be a UTC ISO timestamp');
  const sources = materials.map((material) => {
    const normalized = material.path.replaceAll('\\', '/');
    if (isAbsolute(normalized) || normalized.split('/').includes('..')) throw new Error(`Invalid repository source path: ${material.path}`);
    const id = `src-${claimId(commit, normalized, sha256(material.text))}`;
    return { id, address: normalized, version: commit, anchor: `lines:1-${Math.max(1, material.text.endsWith('\n') ? material.text.split('\n').length - 1 : material.text.split('\n').length)}`, readAt, sha256: sha256(material.text), mediaType: material.mediaType ?? (normalized.endsWith('.md') ? 'text/markdown' : 'text/plain'), byteLength: Buffer.byteLength(material.text, 'utf8'), ...(material.blob ? { blob: material.blob } : {}), type: material.type };
  });
  return sources.sort(byCodePoint);
}

/** A typed, unverified link a fill recorded without fetching, tied to its source record. */
export interface UnattemptedLink { url: string; status: 'not-attempted'; sourceId: string }
/** One typed question the agent reports on top of its claims, matched to claims by exact text. */
export interface AgentQuestion { type: string; title: string; prompt: string; kind?: string; missing?: string; claimTexts?: readonly string[] }

/** Assemble validated deterministic claim output from structured agent output plus anchored index facts. */
export function assembleClaims(input: {
  runId: string; unitId: string; kinds: readonly RegistryKind[]; sources: readonly ClaimSource[];
  agentClaims: readonly {
    kind: string; text: string; layer: ClaimLayer; confidence: number; sourceIds: string[];
    /** The published document this claim conflicts with; its presence derives a contradiction question. */
    conflictsWith?: string;
    /** Marks code behaviour no document mentions; its presence derives an undocumented-behaviour question. */
    undocumented?: boolean;
    /** A document/code term pair this claim records; its presence derives a term question. */
    termPair?: { documentTerm: string; codeTerm: string };
  }[];
  /** Questions the agent reports itself, for the types no claim mark can carry (meaning, decision rationale). */
  agentQuestions?: readonly AgentQuestion[];
  anchoredFacts?: readonly AnchoredCodeFact[]; sourceTexts?: Readonly<Record<string, string>>;
  /** Links recorded as not attempted; each derives an access-or-document-needed question. */
  inaccessibleLinks?: readonly UnattemptedLink[];
}): Pick<ClaimsExtraction, 'claims' | 'sources' | 'questions' | 'inaccessibleLinks'> {
  const sourceById = new Map(input.sources.map((source) => [source.id, source]));
  const kindByName = new Map(input.kinds.map((kind) => [kind.name, kind]));
  const claims: ExtractedClaim[] = [];
  const agentMarks = new Map<string, ClaimMarks>();
  for (const item of input.agentClaims) {
    if (!kindByName.has(item.kind)) throw new Error(`Unknown registry kind in claim: ${item.kind}`);
    if (!item.text.trim() || !Number.isFinite(item.confidence) || item.confidence < 0 || item.confidence > 1) throw new Error(`Invalid claim text or confidence for ${item.kind}`);
    const sourceIds = [...new Set(item.sourceIds)].sort();
    if (sourceIds.length === 0 || sourceIds.some((id) => !sourceById.has(id))) throw new Error(`Claim for ${item.kind} has missing or unknown source ids`);
    if (!['fact', 'intent-evidence', 'assumed-meaning'].includes(item.layer)) throw new Error(`Invalid claim layer: ${String(item.layer)}`);
    const layer: ClaimLayer = item.layer;
    const claim = { id: `clm-${claimId(input.runId, input.unitId, item.kind, item.text, ...sourceIds)}`, kind: item.kind, text: item.text, layer, confidence: item.confidence, unitId: input.unitId, sourceIds, verification: layer === 'assumed-meaning' ? 'unverified' : 'verified' } as const;
    claims.push({ ...claim });
    const marks = {
      ...(item.conflictsWith === undefined ? {} : { conflictsWith: item.conflictsWith }),
      ...(item.undocumented === undefined ? {} : { undocumented: item.undocumented }),
      ...(item.termPair === undefined ? {} : { termPair: item.termPair }),
    };
    if (Object.keys(marks).length > 0) agentMarks.set(claim.id, marks);
  }
  for (const fact of input.anchoredFacts ?? []) {
    if (!kindByName.has(fact.kind)) throw new Error(`Unknown registry kind in anchored fact: ${fact.kind}`);
    const source = input.sources.find((item) => item.address === fact.path);
    if (!source) throw new Error(`Anchored fact source missing: ${fact.path}`);
    if (!fact.blob || source.blob === undefined || source.blob !== fact.blob || !Number.isSafeInteger(fact.startByte) || !Number.isSafeInteger(fact.endByte) || fact.startByte < 0 || fact.endByte < fact.startByte || fact.endByte > source.byteLength) throw new Error(`Invalid structural index anchor for ${fact.path}: blob or byte range does not match its source`);
    const lines = fact.anchor.match(/^lines:(\d+)(?:-(\d+))?$/);
    const sourceLines = source.anchor.match(/^lines:(\d+)-(\d+)$/);
    const first = Number(lines?.[1]); const last = Number(lines?.[2] ?? lines?.[1]);
    if (!lines || !sourceLines || first < Number(sourceLines[1]) || last < first || last > Number(sourceLines[2])) throw new Error(`Invalid anchored fact location ${fact.path}#${fact.anchor}: outside source anchor ${source.anchor}`);
    const sourceText = input.sourceTexts?.[source.id];
    if (sourceText === undefined) throw new Error(`Cannot verify structural index byte-to-line anchor for ${fact.path}: source text is missing`);
    if (Buffer.byteLength(sourceText, 'utf8') !== source.byteLength || sha256(sourceText) !== source.sha256) throw new Error(`Source text does not match recorded hash or byte length for ${fact.path}`);
    const byteToLine = (offset: number): number => Buffer.from(sourceText, 'utf8').subarray(0, offset).toString('utf8').split('\n').length;
    if (byteToLine(fact.startByte) !== first || byteToLine(Math.max(fact.startByte, fact.endByte - 1)) !== last) throw new Error(`Structural index byte range does not match line anchor for ${fact.path}#${fact.anchor}`);
    claims.push({ id: `clm-${claimId(input.runId, input.unitId, fact.kind, fact.text, source.id, fact.anchor)}`, kind: fact.kind, text: fact.text, layer: 'fact', confidence: 1, unitId: input.unitId, sourceIds: [source.id], verification: 'verified' });
  }
  const seen = new Set<string>();
  for (const claim of claims) {
    if (seen.has(claim.id)) throw new Error(`Duplicate claim id ${claim.id}`);
    seen.add(claim.id);
  }
  claims.sort(byCodePoint);
  const present = new Set(claims.map((claim) => claim.kind));
  const questions = deriveClaimQuestions(input, claims, agentMarks, present);
  // The links the questions were derived from stay in the extraction as typed records.
  const inaccessibleLinks = [...(input.inaccessibleLinks ?? [])].sort((a, b) => a.url < b.url ? -1 : a.url > b.url ? 1 : a.sourceId < b.sourceId ? -1 : 1);
  return { claims, sources: [...input.sources].sort(byCodePoint), questions, inaccessibleLinks };
}


/** Render a claim with visible provenance and an explicit badge for assumed meaning. */
export function renderClaimMarkdown(claim: ExtractedClaim, sources: readonly ClaimSource[]): string {
  const sourceById = new Map(sources.map((source) => [source.id, source]));
  const refs = claim.sourceIds.map((id) => {
    const source = sourceById.get(id);
    if (!source) throw new Error(`Claim ${claim.id} references missing source ${id}`);
    const label = `${source.address}#${source.anchor}`;
    return `[${escapeMarkdown(label)}](${source.address.split('/').map((part) => encodeURIComponent(part).replace(/[()]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)).join('/')}#${encodeURIComponent(source.anchor)})`;
  });
  const badge = claim.verification === 'unverified' ? ' **Unverified**' : '';
  return `- **${escapeMarkdown(claim.kind)}:** ${escapeMarkdown(claim.text)}${badge} — ${refs.join(', ')}\n`;
}
function escapeMarkdown(text: string): string { return text.replaceAll('\\', '\\\\').replaceAll('\r', ' ').replaceAll('\n', ' ').replaceAll('*', '\\*').replaceAll('_', '\\_').replaceAll('[', '\\[').replaceAll(']', '\\]').replaceAll('`', '\\`').replaceAll('<', '&lt;').replaceAll('>', '&gt;'); }

/** Persist machine-readable claim, source, question and usage files via atomic temp+rename. */
export async function persistClaimsOutput(directory: string, extraction: ClaimsExtraction): Promise<void> {
  if (extraction.claims.some((claim) => claim.sourceIds.length === 0)) throw new Error('Cannot persist a claim without a source');
  const sourceIds = new Set(extraction.sources.map((source) => source.id));
  for (const claim of extraction.claims) for (const id of claim.sourceIds) if (!sourceIds.has(id)) throw new Error(`Cannot persist claim ${claim.id}: source ${id} is missing`);
  await Promise.all([
    writeFillJsonAtomic(resolve(directory, 'claims.json'), extraction.claims),
    writeFillJsonAtomic(resolve(directory, 'sources.json'), extraction.sources),
    writeFillJsonAtomic(resolve(directory, 'questions.json'), extraction.questions),
    writeFillJsonAtomic(resolve(directory, 'usage.json'), extraction.usage),
    writeFillJsonAtomic(resolve(directory, 'inaccessible-links.json'), extraction.inaccessibleLinks),
  ]);
}

/** Extract anonymous-link references only; Monday extraction never fetches network URLs. */
export function recordUnattemptedLinks(materials: readonly ExtractionMaterial[], sources: readonly ClaimSource[]): UnattemptedLink[] {
  const sourceByAddress = new Map(sources.map((source) => [source.address, source.id]));
  const found: UnattemptedLink[] = [];
  for (const material of materials) {
    for (const match of material.text.matchAll(/https?:\/\/[^\s)\]>]+/g)) {
      const sourceId = sourceByAddress.get(material.path);
      if (sourceId) found.push({ url: match[0].replace(/[.,;]+$/, ''), status: 'not-attempted', sourceId });
    }
  }
  const unique = new Map(found.map((item) => [`${item.url}\0${item.sourceId}`, item]));
  return [...unique.values()].sort((a, b) => a.url < b.url ? -1 : a.url > b.url ? 1 : a.sourceId < b.sourceId ? -1 : 1);
}

/** Run the deterministic score against the private adjacent answer key, never a generated repository path. */
export async function scoreTrainingExtraction(input: { extraction: ClaimsExtraction; answerKeyPath: string; generatedRepo: string }): Promise<TrainingScore> {
  const keyPath = resolve(input.answerKeyPath), repo = resolve(input.generatedRepo);
  if (keyPath === repo || keyPath.startsWith(`${repo}${sep}`)) throw new Error('Answer key must remain outside the generated repository');
  const key = JSON.parse(await readFile(keyPath, 'utf8')) as TrainingAnswerKey;
  const expected = trainingTargets(key);
  const claimMaterial = input.extraction.claims.map((claim) => {
    const references = claim.sourceIds.flatMap((id) => {
      const source = input.extraction.sources.find((item) => item.id === id);
      return source ? [source.address, source.anchor] : [];
    });
    return { claim, text: normalizeScoreClaim(claim.text), sourcePaths: references.filter((value) => !value.startsWith('lines:')).map((value) => normalizeScoreClaim(value)) };
  });
  const matchedClaims = new Set<string>();
  const foundExpected: string[] = [];
  const missed: string[] = [];
  for (const target of expected) {
    const hit = claimMaterial.find(({ claim, text, sourcePaths }) => !matchedClaims.has(claim.id) && target.aliases.some((alias) => text.includes(normalizeScoreClaim(alias ?? ''))) && (!target.files?.length || target.files.some((file) => sourcePaths.includes(normalizeScoreClaim(file)))));
    if (hit) { foundExpected.push(target.id); matchedClaims.add(hit.claim.id); }
    else missed.push(target.id);
  }
  foundExpected.sort(); missed.sort();
  const invented = claimMaterial.filter(({ claim }) => !matchedClaims.has(claim.id)).map(({ claim }) => normalizeScoreClaim(claim.text)).sort();
  const questionScore = scoreQuestionTypes(input.extraction.questions, key.expectedOpenQuestions ?? []);
  return {
    found: foundExpected, missed, invented, counts: { expected: expected.length, found: foundExpected.length, missed: missed.length, invented: invented.length },
    questions: questionScore, unitUsage: input.extraction.usage,
  };
}

/** Score the extraction's question types against the answer key's expected open questions. */
export function scoreQuestionTypes(questions: readonly { type: string }[], expected: readonly { type: string }[]): TrainingQuestionScore {
  const expectedTypes = [...new Set(expected.map((question) => normalizeQuestionType(question.type)))].sort();
  const foundTypes = [...new Set(questions.map((question) => normalizeQuestionType(question.type)).filter((type) => expectedTypes.includes(type)))].sort();
  const missingTypes = expectedTypes.filter((type) => !foundTypes.includes(type));
  return { expectedTypes, foundTypes, missingTypes, counts: { expected: expectedTypes.length, found: foundTypes.length } };
}

/** Fold an answer key's question type into the record's hyphenated type name ('access or document needed' included). */
function normalizeQuestionType(value: string): string { return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); }

type ScoreTarget = { id: string; aliases: string[]; files?: string[] };
function trainingTargets(key: TrainingAnswerKey): ScoreTarget[] {
  const target = (id: string, aliases: Array<string | undefined>, files?: string[]): ScoreTarget => ({ id: normalizeScoreClaim(id), aliases: aliases.filter((value): value is string => typeof value === 'string' && Boolean(value)), files: files?.filter((value): value is string => typeof value === 'string' && Boolean(value)) });
  return [
    ...key.entities.map((entity) => target(`entity:${entity.id}`, [entity.id, entity.name, entity.symbol], [entity.file])),
    ...key.businessRules.map((rule) => target(`rule:${rule.id}`, [rule.id, rule.expected, rule.symbol], [rule.file])),
    ...key.stateMachine.states.map((state) => target(`state:${state}`, [state], [key.stateMachine.file])),
    ...key.stateMachine.transitions.map((transition) => target(`transition:${transition.from ?? '*'}:${transition.event}:${transition.to}`, [transition.from, transition.event, transition.to, transition.condition], [transition.file ?? key.stateMachine.file])),
    ...key.interactions.map((item) => target(`interaction:${item.caller}:${item.callee}:${item.kind}`, [item.caller, item.callee, item.kind, item.symbol], [item.file])),
    ...key.contradictions.map((item) => target(`contradiction:${item.claim}`, [item.claim, item.document], [item.document, item.file])),
    ...key.undocumentedBehaviour.map((item) => target(`undocumented:${item.claim}`, [item.claim, item.symbol], [item.file])),
    ...key.intentEvidence.map((item) => target(`intent:${item.claim}`, [item.claim, item.comment, item.symbol], [item.file])),
    ...key.terms.map((item) => target(`term:${item.documentTerm}:${item.codeTerm}`, [item.documentTerm, item.codeTerm, item.symbol], [item.codeFile])),
  ].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}
function normalizeScoreClaim(value: string): string { return value.toLocaleLowerCase('en-US').replace(/[^\p{L}\p{N}]+/gu, ' ').trim(); }
interface TrainingAnswerKey { entities: Array<{ id: string; name: string; file: string; symbol: string }>; businessRules: Array<{ id: string; expected: string; file: string; symbol: string }>; stateMachine: { file: string; states: string[]; transitions: Array<{ from?: string; event: string; to: string; condition?: string; file?: string; symbol?: string; fromStates?: string[] }> }; interactions: Array<{ caller: string; callee: string; kind: string; file: string; symbol: string }>; contradictions: Array<{ claim: string; document: string; file: string; symbol: string }>; undocumentedBehaviour: Array<{ claim: string; file: string; symbol: string }>; intentEvidence: Array<{ claim: string; file: string; symbol: string; comment: string }>; terms: Array<{ documentTerm: string; codeTerm: string; codeFile: string; symbol: string }>; expectedOpenQuestions?: Array<{ type: string; subject: string; file: string }> }
export interface TrainingQuestionScore { expectedTypes: string[]; foundTypes: string[]; missingTypes: string[]; counts: { expected: number; found: number } }
export interface TrainingScore { found: string[]; missed: string[]; invented: string[]; counts: { expected: number; found: number; missed: number; invented: number }; questions: TrainingQuestionScore; unitUsage: ClaimsExtraction['usage']; }

/** Read a path from a pinned git commit and produce the line-indexed source text. */
export function readPinnedGitMaterial(repository: string, commit: string, file: string, type: ExtractionMaterial['type'] = 'code'): ExtractionMaterial {
  const path = file.replaceAll('\\', '/');
  if (isAbsolute(path) || path.split('/').includes('..')) throw new Error(`Invalid repository path: ${file}`);
  const text = execFileSync('git', ['show', `${commit}:${path}`], { cwd: repository, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return { path, text, type, blob: execFileSync('git', ['rev-parse', `${commit}:${path}`], { cwd: repository, encoding: 'utf8' }).trim() };
}


/** Read the pinned commit log as a source material without consulting a working-tree branch. */
export function readPinnedGitHistory(repository: string, commit: string): ExtractionMaterial {
  const text = execFileSync('git', ['log', '--format=%H%x09%aI%x09%an%x09%s', commit], { cwd: repository, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return { path: 'git:history', text, type: 'git-history', mediaType: 'text/tab-separated-values' };
}

/** Persist the training checkpoint with found, missed, invented and per-unit usage. */
export async function persistTrainingScore(file: string, score: TrainingScore): Promise<void> {
  await writeFillJsonAtomic(resolve(file), score);
}

export function createEmptyClaimsExtraction(startedAt = performance.now()): ClaimsExtraction {
  return { claims: [], sources: [], questions: [], inaccessibleLinks: [], usage: { elapsedMs: Math.max(0, Math.round(performance.now() - startedAt)), inputTokens: 0, outputTokens: 0 } };
}
