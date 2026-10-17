/** Deterministic code maps and registry-driven, critic-checked page synthesis. */
import { createHash } from 'node:crypto';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, realpath, open, unlink } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep, posix } from 'node:path';
import type { RegistryKind } from './contract.js';
import type { ExtractedClaim, ClaimSource, ClaimQuestion } from './fill-claims.js';
import type { StructuralIndexResult } from './fill-index.js';
import { writeFillJsonAtomic, hashFillInput, type FillUnitPlan } from './fill-runtime.js';

export interface CodeMapFact {
  id: string; kind: string; text: string; sourceId: string; path: string; anchor: string;
  relations: Array<{ type: 'imports' | 'calls' | 'entry-point' | 'state-transition' | 'business-rule'; target: string; text?: string; sourceId: string; anchor: string }>;
}
export interface CodeMap {
  schemaVersion: 1; repository: string; commit: string; inputHash: string;
  components: CodeMapFact[]; interactions: CodeMapFact[]; stateTransitions: CodeMapFact[]; businessRules: CodeMapFact[];
}
export interface SynthesisClaim extends ExtractedClaim { sourceIds: string[] }
export interface SynthesisSegment { text: string; sourceIds: string[]; layer: ExtractedClaim['layer'] }
export interface SynthesizedPage {
  path: string; title: string; kind: string; body: string; segments: SynthesisSegment[]; questions: ClaimQuestion[]; claims: SynthesisClaim[]; sourceIds: string[];
  unverified: boolean; critic: { passes: number; findings: string[] };
}
export interface Critique { findings: string[] }
export type Critic = (page: Omit<SynthesizedPage, 'critic'>, pass: number) => Promise<Critique> | Critique;
export interface SynthesisTarget { name: string; folder: string; hint: string; registryKind?: RegistryKind; allClaims?: boolean }
export type PageGenerator = (input: { target: SynthesisTarget; codeMap: CodeMap; claims: readonly SynthesisClaim[]; priorDraft?: string; criticFindings?: readonly string[]; pass: number }) => Promise<{ title: string; body: string; claims: SynthesisClaim[]; segments: SynthesisSegment[] }>;
const sha = (text: string): string => createHash('sha256').update(text).digest('hex');
const execFile = promisify(execFileCallback);
async function gitBranch(path: string): Promise<string> {
  try { return (await execFile('git', ['-C', path, 'branch', '--show-current'], { encoding: 'utf8' })).stdout.trim(); }
  catch (error) { throw new Error(`Cannot read synthesis worktree branch at ${path}: ${String(error)}`); }
}
async function gitRoot(path: string): Promise<string> {
  try { return (await execFile('git', ['-C', path, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' })).stdout.trim(); }
  catch (error) { throw new Error(`Synthesis requires a Git worktree at ${path}: ${String(error)}`); }
}

/** Synthesis instructions are maintained as prompt data, not embedded in engine code. */
export async function loadSynthesisPrompt(name: 'code-map' | 'page-synthesis' | 'page-critic'): Promise<string> {
  return readFile(new URL(`./synthesis-prompts/${name}.md`, import.meta.url), 'utf8');
}
const sort = <T extends { id: string }>(items: T[]): T[] => items.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const stableJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`).join(',')}}`;
  return JSON.stringify(value);
};

/** Build a reproducible bottom-up map from pinned structural anchors and sourced claims. */
export function buildCodeMap(index: StructuralIndexResult, sources: readonly ClaimSource[]): CodeMap {
  validateClaimSources([], sources);
  const components: CodeMapFact[] = [];
  const interactions: CodeMapFact[] = [];
  const stateTransitions: CodeMapFact[] = [];
  const businessRules: CodeMapFact[] = [];
  const id = (type: string, path: string, anchor: string, text: string): string => `map-${sha([type, path, anchor, text].join('\0')).slice(0, 24)}`;
  for (const file of index.files) {
    const fileSource = sources.find((source) => source.address === file.path && source.blob === file.blob);
    if (!fileSource) throw new Error(`Code map index/source mismatch for ${file.path} blob ${file.blob}`);
    for (const symbol of file.symbols) {
      const anchor = `lines:${symbol.startLine}-${symbol.endLine}`;
      if (!withinSourceAnchor(fileSource.anchor, anchor)) throw new Error(`Code map symbol anchor ${file.path}#${anchor} is outside source anchor ${fileSource.anchor}`);
      const relations: CodeMapFact['relations'] = [];
      if (file.entryPoints.includes(symbol.name)) relations.push({ type: 'entry-point', target: symbol.name, sourceId: fileSource.id, anchor });
      components.push({ id: id('component', file.path, anchor, symbol.name), kind: symbol.kind, text: `${symbol.exported ? 'Exported ' : ''}${symbol.kind.replaceAll('_', ' ')} ${symbol.name}`, sourceId: fileSource.id, path: file.path, anchor, relations });
    }
    for (const comment of file.comments) {
      const lower = comment.text.toLowerCase();
      if (!/rule|must|only|never|transition|state|order|payment|retry|cannot|should/.test(lower)) continue;
      const anchor = `lines:${comment.startLine}-${comment.endLine}`;
      if (!withinSourceAnchor(fileSource.anchor, anchor)) throw new Error(`Code map comment anchor ${file.path}#${anchor} is outside source anchor ${fileSource.anchor}`);
      const fact: CodeMapFact = { id: id('rule', file.path, anchor, comment.text), kind: 'comment', text: comment.text, sourceId: fileSource.id, path: file.path, anchor, relations: [] };
      businessRules.push(fact);
      if (/\b(?:state|status)\s+transition\s+from\s+[\w-]+\s+to\s+[\w-]+\b/i.test(comment.text)) stateTransitions.push({ ...fact, id: id('transition', file.path, anchor, comment.text) });
    }
    for (const relation of [...file.imports.map((item) => ({ ...item, kind: 'import' as const })), ...file.callEdges]) {
      const anchor = `lines:${relation.startLine}-${relation.endLine}`;
      if (!withinSourceAnchor(fileSource.anchor, anchor)) throw new Error(`Code map relation anchor ${file.path}#${anchor} is outside source anchor ${fileSource.anchor}`);
      const type = relation.kind === 'import' ? 'import' : 'call';
      interactions.push({ id: id('interaction', file.path, anchor, relation.target), kind: type, text: relation.kind === 'import' ? `${relation.source} imports ${relation.target}` : `${relation.source} calls ${relation.target}`, sourceId: fileSource.id, path: file.path, anchor, relations: [] });
    }
  }
  for (const fact of [...components, ...interactions, ...stateTransitions, ...businessRules]) {
    if (!sources.some((source) => source.id === fact.sourceId)) throw new Error(`Code map fact ${fact.id} has no source`);
    for (const relation of fact.relations) if (!sources.some((source) => source.id === relation.sourceId)) throw new Error(`Code map relation for ${fact.id} has no source`);
  }
  const canonical = JSON.stringify({ repository: index.repository, commit: index.commit, components: sort(components), interactions: sort(interactions), stateTransitions: sort(stateTransitions), businessRules: sort(businessRules) });
  return { schemaVersion: 1, repository: index.repository, commit: index.commit, inputHash: sha(canonical), components: sort(components), interactions: sort(interactions), stateTransitions: sort(stateTransitions), businessRules: sort(businessRules) };
}

/** Stable one-unit plan for the deterministic code map. */
export function codeMapUnitPlan(indexHash: string): FillUnitPlan {
  return { id: 'code-map-repository', stage: 'code-map', inputHashes: { index: indexHash }, outputPaths: ['.madarch/fill/outputs/code-map-repository/code-map.json'], dependencies: [] };
}
/** Stable per-registry-entry synthesis plans consume code map, claims and registry bytes. */
export function synthesisUnitPlans(kinds: readonly RegistryKind[], codeMapHash: string, claimsHash: string, registryHash: string): FillUnitPlan[] {
  return [...kinds].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0).map((kind) => {
    const key = hashFillInput(kind.name).slice(0, 16);
    const id = `synthesis-${key}`;
    return { id, stage: 'synthesis', inputHashes: { codeMap: codeMapHash, claims: claimsHash, registry: registryHash, kind: hashFillInput(stableJson(kind)) }, outputPaths: [`.madarch/fill/outputs/${id}/page.json`], dependencies: ['code-map-repository'] };
  });
}
/** The code-map unit is content-addressed and writes only beneath its output directory. */
export async function persistCodeMap(outputDirectory: string, codeMap: CodeMap): Promise<string> {
  const directory = resolve(outputDirectory);
  await mkdir(directory, { recursive: true });
  const realDirectory = await realpath(directory);
  const file = resolve(realDirectory, 'code-map.json');
  if (!isWithin(directory, file)) throw new Error('Code map output escapes its output directory');
  await writeFillJsonAtomic(file, codeMap);
  return file;
}

function withinSourceAnchor(sourceAnchor: string, anchor: string): boolean {
  const source = sourceAnchor.match(/^lines:(\d+)-(\d+)$/);
  const current = anchor.match(/^lines:(\d+)-(\d+)$/);
  return Boolean(source && current && Number(current[1]) >= Number(source[1]) && Number(current[2]) <= Number(source[2]) && Number(current[1]) <= Number(current[2]));
}
function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}
function validateClaimSources(claims: readonly SynthesisClaim[], sources: readonly ClaimSource[]): void {
  const sourceIds = new Set(sources.map((source) => source.id));
  for (const source of sources) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(source.id)) throw new Error(`Unsafe claim source id: ${source.id}`);
    const address = source.address.replaceAll('\\', '/');
    if (isAbsolute(address) || address.split('/').includes('..') || address === '') throw new Error(`Unsafe claim source address: ${source.address}`);
  }
  for (const claim of claims) {
    if (!claim.text.trim() || claim.sourceIds.length === 0) throw new Error(`Synthesis claim ${claim.id} has no text or source`);
    for (const sourceId of claim.sourceIds) if (!sourceIds.has(sourceId)) throw new Error(`Synthesis claim ${claim.id} refers to unknown source ${sourceId}`);
    if (claim.layer === 'assumed-meaning' && claim.verification !== 'unverified') throw new Error(`Assumed claim ${claim.id} must be unverified`);
  }
}
function claimsForTarget(target: SynthesisTarget, claims: readonly SynthesisClaim[]): SynthesisClaim[] {
  return sort(claims.filter((claim) => target.allClaims || claim.kind === target.name).map((claim) => ({ ...claim, sourceIds: [...claim.sourceIds].sort() })));
}

/** Synthesize a registry kind with a bounded generator/critic loop and checked provenance. */
export async function synthesizeRegistryPage(input: {
  target: SynthesisTarget; codeMap: CodeMap; claims: readonly SynthesisClaim[]; sources: readonly ClaimSource[];
  generate: PageGenerator; critique: Critic; maxRevisions?: number; questions?: readonly ClaimQuestion[]; missingQuestion?: (target: SynthesisTarget) => ClaimQuestion;
}): Promise<SynthesizedPage> {
  const maxRevisions = input.maxRevisions ?? 2;
  if (!Number.isInteger(maxRevisions) || maxRevisions < 0 || maxRevisions > 5) throw new Error('maxRevisions must be a whole number from 0 through 5');
  const candidates = claimsForTarget(input.target, input.claims);
  validateClaimSources(candidates, input.sources);
  const questionForEmpty = (input.questions ?? []).find((question) => question.kind === input.target.name) ?? (input.target.registryKind ? input.missingQuestion?.(input.target) : undefined);
  let draft: string | undefined;
  let findings: string[] = [];
  let passes = 0;
  for (let revision = 0; revision <= maxRevisions; revision++) {
    passes++;
    const generated = await input.generate({ target: input.target, codeMap: input.codeMap, claims: candidates, priorDraft: draft, criticFindings: findings, pass: passes });
    if (!generated.title.trim() || !generated.body.trim()) throw new Error(`Generator returned an empty ${input.target.name} page`);
    if (!Array.isArray(generated.segments) || (generated.segments.length === 0 && (generated.claims.length > 0 || !questionForEmpty))) throw new Error(`Generator returned no source-backed prose segments for ${input.target.name}`);
    const selected = generated.claims;
    validateClaimSources(selected, input.sources);
    const allowed = new Map(candidates.map((claim) => [claim.id, stableJson(claim)]));
    for (const claim of selected) {
      if (!input.target.allClaims && claim.kind !== input.target.name) throw new Error(`Generator returned claim ${claim.id} for ${claim.kind} while synthesizing ${input.target.name}`);
      if (allowed.get(claim.id) !== stableJson(claim)) throw new Error(`Generator returned an unsupported or altered claim ${claim.id} for ${input.target.name}`);
    }
    const slug = `${input.target.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'kind'}-${sha(input.target.name).slice(0, 8)}`;
    for (const segment of generated.segments) {
      if (!segment.text.trim() || !segment.sourceIds.length) throw new Error(`Generated prose for ${input.target.name} is missing a source`);
      const supporting = selected.filter((claim) => claim.layer === segment.layer && segment.sourceIds.every((id) => claim.sourceIds.includes(id)));
      if (!supporting.length || segment.sourceIds.some((id) => !input.sources.some((source) => source.id === id))) throw new Error(`Generated prose for ${input.target.name} has unsupported source attribution`);
      const canonicalSentence = segment.text.trim().replace(/\s+/g, ' ');
      if (!supporting.some((claim) => claim.text.trim().replace(/\s+/g, ' ') === canonicalSentence)) throw new Error(`Generated prose for ${input.target.name} must preserve a supported claim verbatim`);
    }
    const supportedBody = generated.segments.map((segment) => segment.text.trim()).join('\n\n');
    const relevantQuestions = (input.questions ?? []).filter((question) => question.kind === input.target.name);
    if (selected.length === 0 && relevantQuestions.length === 0 && questionForEmpty) relevantQuestions.push(questionForEmpty);
    if (selected.length === 0 && relevantQuestions.length === 0) throw new Error(`Registry kind ${input.target.name} has no entities and no open question explaining the absence`);
    const page = { path: `${input.target.folder}/${slug}.md`, title: generated.title.trim(), kind: input.target.name, body: supportedBody || (relevantQuestions.length ? relevantQuestions.map((question) => question.reason).join('\n') : ''), segments: generated.segments, questions: relevantQuestions, claims: sort([...selected]), sourceIds: [...new Set(selected.flatMap((claim) => claim.sourceIds))].sort(), unverified: selected.some((claim) => claim.verification === 'unverified'), critic: undefined } as unknown as Omit<SynthesizedPage, 'critic'>;
    const review = await input.critique(page, passes);
    if (!Array.isArray(review.findings) || review.findings.some((finding) => typeof finding !== 'string' || !finding.trim())) throw new Error(`Critic returned invalid findings for ${input.target.name}`);
    findings = [...new Set(review.findings.map((finding) => finding.trim()))].sort();
    draft = `${page.title}\n\n${page.body}`;
    if (findings.length === 0) return { ...page, critic: { passes, findings } };
  }
  throw new Error(`Critic did not accept ${input.target.name} page after ${passes} bounded passes: ${findings.join('; ')}`);
}

/** A generated overview uses registry-backed claims only, with no engine kind assumptions. */
export async function synthesizePages(input: {
  overview: SynthesisTarget; kinds: readonly RegistryKind[]; codeMap: CodeMap; claims: readonly SynthesisClaim[]; sources: readonly ClaimSource[];
  generate: PageGenerator; critique: Critic; maxRevisions?: number; questions?: readonly ClaimQuestion[]; missingQuestion?: (target: SynthesisTarget) => ClaimQuestion;
}): Promise<SynthesizedPage[]> {
  const pages: SynthesizedPage[] = [];
  pages.push(await synthesizeRegistryPage({ ...input, target: { ...input.overview, allClaims: true }, missingQuestion: undefined }));
  for (const kind of input.kinds) {
    if (kind.name === input.overview.name) continue;
    pages.push(await synthesizeRegistryPage({ ...input, target: { name: kind.name, folder: kind.folder, hint: kind.hint, registryKind: kind }, missingQuestion: input.missingQuestion ?? ((target) => ({ id: `q-${sha(target.name + target.hint).slice(0, 24)}`, type: 'unverifiable', kind: target.name, reason: `No supported entity was found. Registry hint: ${target.hint}`, dependsOn: [], rank: 0 })) }));
  }
  return pages;
}

/** Apply a proposal and its source cards only to the named agent worktree on its fill branch. */
export async function applySynthesisPages(input: { agentWorktree: string; sourceCheckout: string; expectedAgentBranch: string; pages: readonly SynthesizedPage[]; sources: readonly ClaimSource[] }): Promise<string[]> {
  const agentRoot = await realpath(resolve(input.agentWorktree));
  const sourceRoot = await realpath(resolve(input.sourceCheckout));
  const [agentGitRoot, sourceGitRoot, branch] = await Promise.all([gitRoot(agentRoot), gitRoot(sourceRoot), gitBranch(agentRoot)]);
  if (resolve(agentGitRoot) !== agentRoot || resolve(sourceGitRoot) !== sourceRoot) throw new Error('Synthesis paths must name the Git worktree roots, not subdirectories');
  if (agentRoot === sourceRoot || isWithin(sourceRoot, agentRoot) || isWithin(agentRoot, sourceRoot)) throw new Error('Agent worktree and read-only source checkout must be distinct, non-nested repositories');
  if (!/^madarch\/fill\/[A-Za-z0-9._-]+$/.test(input.expectedAgentBranch) || branch !== input.expectedAgentBranch) throw new Error(`Synthesis destination branch mismatch: expected ${input.expectedAgentBranch}, found ${branch || '(detached HEAD)'}`);
  const sourceById = new Map(input.sources.map((source) => [source.id, source]));
  const writes = new Map<string, { path: string; text: string }>();
  for (const page of input.pages) {
    if (!page.path.startsWith('docs/') || isAbsolute(page.path) || page.path.split(/[\\/]/).some((segment) => segment === '..' || segment === '.' || segment === '') || !page.path.endsWith('.md')) throw new Error(`Refusing synthesis path outside docs/: ${page.path}`);
    validateClaimSources(page.claims, input.sources);
    if (!Number.isInteger(page.critic.passes) || page.critic.passes < 1 || page.critic.findings.length !== 0) throw new Error(`Page ${page.path} has not passed its critic`);
    if (!Array.isArray(page.segments) || (page.claims.length > 0 && page.segments.length === 0)) throw new Error(`Page ${page.path} has no source-backed prose segments`);
    for (const segment of page.segments) {
      const supporting = page.claims.filter((claim) => claim.layer === segment.layer && segment.sourceIds.every((id) => claim.sourceIds.includes(id)));
      if (!segment.text.trim() || !segment.sourceIds.length || !supporting.some((claim) => claim.text.trim().replace(/\s+/g, ' ') === segment.text.trim().replace(/\s+/g, ' '))) throw new Error(`Page ${page.path} contains prose without an exact supporting claim`);
    }
    if (page.claims.length === 0 && page.questions.length === 0) throw new Error(`Page ${page.path} has neither a supported entity nor an absence question`);
    if (!page.title.trim() || !page.body.trim()) throw new Error(`Refusing empty proposed page: ${page.path}`);
    if (page.unverified !== page.claims.some((claim) => claim.verification === 'unverified')) throw new Error(`Page ${page.path} has an incorrect unverified indicator`);
    const target = resolve(agentRoot, page.path.replace(/\.md$/i, '.proposed.md'));
    if (!isWithin(agentRoot, target) || writes.has(target)) throw new Error(`Refusing unsafe or duplicate synthesis target: ${page.path}`);
    if (JSON.stringify([...new Set(page.claims.flatMap((claim) => claim.sourceIds))].sort()) !== JSON.stringify([...page.sourceIds].sort())) throw new Error(`Page ${page.path} source index does not match its claims`);
    const lines = page.claims.map((claim) => {
      const links = claim.sourceIds.map((id) => {
        const source = sourceById.get(id);
        if (!source) throw new Error(`Page ${page.path} refers to unknown source ${id}`);
        const sourcePath = `docs/fill-sources/${source.id}.md`;
        const sourceTarget = resolve(agentRoot, sourcePath);
        const href = posix.relative(posix.dirname(page.path.replace(/\.md$/i, '.proposed.md')), sourcePath).split('/').map((part) => part === '..' ? part : encodeURIComponent(part)).join('/');
        writes.set(sourceTarget, { path: sourcePath, text: `# Source ${source.id}\n\n- Address: \`${source.address}\`\n- Version: \`${source.version}\`\n- Anchor: \`${source.anchor}\`\n- SHA-256: \`${source.sha256}\`\n- Read at: \`${source.readAt}\`\n- Media type: \`${source.mediaType}\`\n` });
        return `[${source.address.replaceAll('\\', '\\\\').replaceAll('[', '\\[').replaceAll(']', '\\]')}#${source.anchor}](${href})`;
      }).join(', ');
      const badge = claim.verification === 'unverified' ? ' **Unverified**' : '';
      return `- **${claim.kind}:** ${claim.text.replace(/[\r\n]+/g, ' ')}${badge} — ${links}`;
    }).join('\n');
    const openQuestions = page.questions.map((question) => `- **${question.type}:** ${question.reason}`).join('\n');
    const text = `# ${page.title}\n\n${page.body}\n\n${openQuestions ? `## Open questions\n\n${openQuestions}\n\n` : ''}## Evidence\n\n${lines || '_No supported claims were found for this registry kind._'}\n`;
    writes.set(target, { path: page.path.replace(/\.md$/i, '.proposed.md'), text });
  }
  // Validate the complete write set before any file is created.
  for (const [target, item] of writes) {
    if (!isWithin(agentRoot, target)) throw new Error(`Refusing unsafe synthesis target: ${item.path}`);
    const parent = resolve(target, '..');
    await mkdir(parent, { recursive: true });
    if (!isWithin(agentRoot, await realpath(parent))) throw new Error(`Refusing synthesis target through a symlink outside the agent worktree: ${item.path}`);
    try { await readFile(target); throw new Error(`Refusing to overwrite existing proposal in agent worktree: ${item.path}`); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  const created: string[] = [];
  try {
    for (const [target, item] of writes) {
      let handle;
      try { handle = await open(target, 'wx', 0o600); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`Refusing to overwrite existing proposal in agent worktree: ${item.path}`); throw error; }
      created.push(target);
      try { await handle.writeFile(item.text, 'utf8'); await handle.sync(); }
      finally { await handle.close(); }
    }
  } catch (error) {
    await Promise.all(created.map((file) => unlink(file).catch(() => undefined)));
    throw error;
  }
  return [...input.pages.map((page) => resolve(agentRoot, page.path.replace(/\.md$/i, '.proposed.md'))), ...[...writes.keys()].filter((target) => target.includes(`${sep}fill-sources${sep}`)).sort()];
}
