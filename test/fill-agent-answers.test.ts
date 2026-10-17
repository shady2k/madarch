import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { asArray, asSourceIdList, claimRowsFromAnswer, parseAgentAnswer, parseSynthesisAnswer, requestValidatedAgentAnswer, validateClaimsAnswer } from '../src/product/fill-agent-answers.js';
import { hashFillInput, readFillJson, fillStatePaths, type FillRun, type FillUnit } from '../src/product/fill-runtime.js';
import { startFill } from '../src/product/fill.js';
import type { ClaimSource } from '../src/product/fill-claims.js';
import type { RegistryKind } from '../src/product/contract.js';

const kinds: RegistryKind[] = [{ name: 'Overview', prefix: 'OV', folder: 'docs/overview', stage: 'overview', hint: 'Describe the product' } as RegistryKind];
const source = (id: string): ClaimSource => ({ id, address: 'README.md', version: 'abc', anchor: 'lines:1-1', readAt: '2026-10-17T00:00:00Z', sha256: '0'.repeat(64), mediaType: 'text/markdown', byteLength: 10, type: 'document' });
const sources = [source('src-1a2b3c4d'), source('src-5e6f7081')];
const validClaim = { kind: 'Overview', text: 'The service serves a versioned wiki.', layer: 'fact', confidence: 0.9, sourceIds: ['src-1a2b3c4d'] };

describe('tolerant parsing of agent answers', () => {
  test('parses plain, fenced and prose-surrounded JSON, and refuses the rest', () => {
    expect(parseAgentAnswer('{"claims":[]}')).toEqual({ ok: true, value: { claims: [] } });
    expect(parseAgentAnswer('```json\n{"claims":[]}\n```')).toEqual({ ok: true, value: { claims: [] } });
    expect(parseAgentAnswer('Here is the answer:\n{"claims":[]}\nDone.')).toEqual({ ok: true, value: { claims: [] } });
    expect(parseAgentAnswer('')).toEqual({ ok: false, error: 'Agent returned an empty answer' });
    expect(parseAgentAnswer('no json here at all')).toEqual({ ok: false, error: 'Agent returned no JSON object' });
  });

  test('a single id string becomes a one-element list; every other shape stays strict', () => {
    expect(asSourceIdList('src-1a2b3c4d', 'sourceIds')).toEqual(['src-1a2b3c4d']);
    expect(asSourceIdList(['src-1a2b3c4d', 'src-5e6f7081'], 'sourceIds')).toEqual(['src-1a2b3c4d', 'src-5e6f7081']);
    expect(() => asSourceIdList(42, 'sourceIds')).toThrow('Agent output field sourceIds must be an array');
    expect(() => asSourceIdList({ id: 'src-1a2b3c4d' }, 'sourceIds')).toThrow('Agent output field sourceIds must be an array');
    expect(asArray(['a'], 'claims')).toEqual(['a']);
    expect(() => asArray('a', 'claims')).toThrow('Agent output field claims must be an array');
  });

  test('claims rows arrive as a top-level array or under claims', () => {
    expect(claimRowsFromAnswer([validClaim])).toEqual([validClaim]);
    expect(claimRowsFromAnswer({ claims: [validClaim] })).toEqual([validClaim]);
    expect(() => claimRowsFromAnswer({ claim: [] })).toThrow('Agent output field claims must be an array');
  });
});

describe('claims answer validation collects every error', () => {
  test('the recorded checkpoint failure: sourceIds not an array', () => {
    const answer = { claims: [{ kind: 'Overview', text: 'The wiki serves pages.', layer: 'fact', confidence: 0.9, sourceIds: 42 }] };
    expect(validateClaimsAnswer(answer, kinds, sources)).toEqual(['claims[0].sourceIds: must be an array of source ids']);
  });

  test('a single id string is accepted where the meaning is unambiguous', () => {
    const answer = { claims: [{ kind: 'Overview', text: 'The wiki serves pages.', layer: 'fact', confidence: 0.9, sourceIds: 'src-1a2b3c4d' }] };
    expect(validateClaimsAnswer(answer, kinds, sources)).toEqual([]);
  });

  test('every broken field is reported in row order and nothing is silently narrowed', () => {
    const answer = { claims: [
      { kind: 'Nope', text: '', layer: 'guess', confidence: 4, sourceIds: ['src-unknown'] },
      { kind: 'Overview', text: 'ok', layer: 'fact', confidence: 0.5, sourceIds: [] },
      'not an object',
    ] };
    expect(validateClaimsAnswer(answer, kinds, sources)).toEqual([
      'claims[0].kind: unknown registry kind "Nope"',
      'claims[0].text: must be a non-empty string',
      'claims[0].confidence: must be a number from 0 through 1',
      'claims[0].layer: must be one of fact, intent-evidence, assumed-meaning',
      'claims[0].sourceIds: unknown source id "src-unknown"',
      'claims[1].sourceIds: must cite at least one source id',
      'claims[2]: claim must be a JSON object',
    ]);
  });

  test('a duplicated claim is retried instead of reaching assembleClaims and throwing', () => {
    const duplicate = { claims: [validClaim, { ...validClaim }, { ...validClaim, sourceIds: ['src-1a2b3c4d', 'src-5e6f7081'] }, { ...validClaim, sourceIds: ['src-5e6f7081', 'src-1a2b3c4d'] }] };
    expect(validateClaimsAnswer(duplicate, kinds, sources)).toEqual([
      'claims[1]: duplicate of claims[0]: the same kind, text and source ids are one claim, return it once',
      'claims[3]: duplicate of claims[2]: the same kind, text and source ids are one claim, return it once',
    ]);
    expect(validateClaimsAnswer({ claims: [validClaim, { ...validClaim, text: 'A different claim.' }] }, kinds, sources)).toEqual([]);
  });

  test('optional per-claim marks are validated when present and ignored when absent', () => {
    expect(validateClaimsAnswer({ claims: [{ ...validClaim, conflictsWith: 'README.md', undocumented: true, termPair: { documentTerm: 'payment token', codeTerm: 'CardToken' } }] }, kinds, sources)).toEqual([]);
    const markedRow = (mark: Record<string, unknown>, text = validClaim.text) => ({ ...validClaim, text, ...mark });
    expect(validateClaimsAnswer({ claims: [
      markedRow({ conflictsWith: '  ' }),
      markedRow({ undocumented: 'yes' }, 'Second claim.'),
      markedRow({ termPair: { documentTerm: '', codeTerm: 4 } }, 'Third claim.'),
      markedRow({ termPair: 'payment token/CardToken' }, 'Fourth claim.'),
    ] }, kinds, sources)).toEqual([
      'claims[0].conflictsWith: must be a non-empty string when present',
      'claims[1].undocumented: must be a boolean when present',
      'claims[2].termPair: must be an object with non-empty documentTerm and codeTerm strings',
      'claims[3].termPair: must be an object with non-empty documentTerm and codeTerm strings',
    ]);
  });

  test('the optional questions list is validated: types, missing field, claim texts and duplicates', () => {
    const good = { type: 'meaning', title: 'What expiry means', prompt: 'Does expiry cancel without payment?', kind: 'Overview', claimTexts: [validClaim.text] };
    expect(validateClaimsAnswer({ claims: [validClaim], questions: [good, { type: 'access-or-document-needed', title: 'Workspace read', prompt: 'Access is needed.', missing: 'access', claimTexts: [validClaim.text] }] }, kinds, sources)).toEqual([]);
    expect(validateClaimsAnswer({ claims: [validClaim], questions: 'not a list' }, kinds, sources)).toEqual(['Agent output field questions must be an array']);
    expect(validateClaimsAnswer({ claims: [validClaim], questions: [
      { type: 'guess', title: 'q', prompt: 'why?' },
      { title: 'q', prompt: 'why?' },
      { type: 'meaning', title: '', prompt: 'why?' },
      { type: 'meaning', title: 'q', prompt: '' },
      { type: 'meaning', title: 'unknown kind', prompt: 'why?', kind: 'Nope' },
      { type: 'access-or-document-needed', title: 'no missing field', prompt: 'why?' },
      { type: 'access-or-document-needed', title: 'bad missing field', prompt: 'why?', missing: 'wifi' },
      { type: 'meaning', title: 'unmatched claim text', prompt: 'why?', claimTexts: ['no such claim'] },
      { type: 'meaning', title: 'bad claim text shape', prompt: 'why?', claimTexts: 'validClaim.text' },
      { type: 'meaning', title: 'asked once', prompt: 'why?' },
      { type: 'meaning', title: 'asked once', prompt: 'why, again?' },
      'not an object',
    ] }, kinds, sources)).toEqual([
      'questions[0].type: must be one of meaning, contradiction, undocumented-behaviour, assumption-check, term, unverifiable, decision-rationale, access-or-document-needed',
      'questions[1].type: must be one of meaning, contradiction, undocumented-behaviour, assumption-check, term, unverifiable, decision-rationale, access-or-document-needed',
      'questions[2].title: must be a non-empty string',
      'questions[3].prompt: must be a non-empty string',
      'questions[4].kind: unknown registry kind "Nope"',
      'questions[5].missing: access-or-document-needed questions need missing set to access or document',
      'questions[6].missing: must be access or document',
      'questions[7].claimTexts: no claim in this answer has the text "no such claim"; copy the exact text of a claim you returned',
      'questions[8].claimTexts: must be an array of non-empty claim texts',
      'questions[10]: duplicate of questions[9]: the same type and title is one question, return it once',
      'questions[11]: question must be a JSON object',
    ]);
  });

  test('a missing confidence defaults and an absent claims array is one clear error', () => {
    expect(validateClaimsAnswer({ claims: [{ kind: 'Overview', text: 'x', layer: 'fact', sourceIds: ['src-5e6f7081'] }] }, kinds, sources)).toEqual([]);
    expect(validateClaimsAnswer({ nope: true }, kinds, sources)).toEqual(['Agent output field claims must be an array']);
  });
});

describe('bounded retry with validation errors fed back', () => {
  test('retries a malformed answer with the exact errors and the previous raw answer', async () => {
    const prompts: string[] = [];
    const answers = ['{"claims":[{"kind":"Overview","text":"x","layer":"fact","confidence":0.9,"sourceIds":"src-wrong"}]}', JSON.stringify({ claims: [validClaim] })];
    let call = 0;
    const outcome = await requestValidatedAgentAnswer({
      prompt: 'BASE',
      call: async (prompt) => { prompts.push(prompt); return answers[call++]!; },
      validate: (value) => validateClaimsAnswer(value, kinds, sources),
    });
    expect(outcome.ok).toBe(true);
    expect(outcome.attempts).toBe(2);
    expect(outcome.answers).toEqual(answers);
    expect(prompts[0]).toBe('BASE');
    expect(prompts[1]).toContain('Your previous answer was invalid');
    expect(prompts[1]).toContain('- claims[0].sourceIds: unknown source id "src-wrong"');
    expect(prompts[1]).toContain(answers[0]!);
  });

  test('a non-JSON answer is retried with its parse error and fails after two retries', async () => {
    const prompts: string[] = [];
    const outcome = await requestValidatedAgentAnswer({
      prompt: 'BASE',
      call: async (prompt) => { prompts.push(prompt); return 'I cannot answer in JSON.'; },
      validate: () => [],
      retries: 2,
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.attempts).toBe(3);
    expect(outcome.errors).toEqual(['Agent returned no JSON object']);
    expect(prompts).toHaveLength(3);
    expect(prompts[1]).toContain('- Agent returned no JSON object');
  });
});

// ---- end-to-end: one blocked unit, the run goes on ----

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString();

const productFixture = async () => {
  const root = await mkdtemp(join(tmpdir(), 'madarch-fill-answer-'));
  await writeFile(join(root, 'workspace.yaml'), 'schemaVersion: 1\nid: example\nname: Example\nskills:\n  madarch: "1.0.0"\n');
  await mkdir(join(root, 'docs'), { recursive: true });
  const registryText = 'contract: 1\nstages:\n  - id: overview\n    name: Overview\nkinds:\n  - name: Overview\n    prefix: OV\n    folder: docs/overview\n    stage: overview\n    hint: Describe the product\n';
  await writeFile(join(root, 'docs/kinds.yaml'), registryText);
  await writeFile(join(root, 'README.md'), '# example product\n\nSee [the guide](https://example.test/guide).\n');
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'Fixture');
  git(root, 'config', 'user.email', 'fixture@example.invalid');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'fixture');
  return { root, registryText };
};

const malformedAnswer = '{"claims":[{"kind":"Overview","text":"The wiki serves pages.","layer":"fact","confidence":0.9,"sourceIds":42}]}';

describe('a malformed agent answer fails one unit and the run goes on', () => {
  test('invalid after the retries: the unit is blocked with the errors, raw answers saved, report names it', async () => {
    const { root } = await productFixture();
    try {
      const calls: string[] = [];
      const result = await startFill(root, { executorFactory: () => ({ execute: async (prompt: string) => { calls.push(prompt); return malformedAnswer; } }) });
      expect(result.run.status).toBe('blocked');
      expect(calls).toHaveLength(3);
      expect(calls[1]).toContain('- claims[0].sourceIds: must be an array of source ids');
      expect(calls[2]).toContain('Your previous answer was');

      const state = fillStatePaths(root);
      const unit = await readFillJson<FillUnit>(join(state.units, 'claims-repository.json'));
      expect(unit.status).toBe('blocked');
      expect(unit.attempt).toBe(1);
      expect(unit.error).toContain('claims[0].sourceIds: must be an array of source ids');

      const raw = await readFillJson<{ unitId: string; attempts: number; errors: string[]; answers: string[] }>(join(state.outputs, 'claims-repository', 'invalid-answers.json'));
      expect(raw.unitId).toBe('claims-repository');
      expect(raw.attempts).toBe(3);
      expect(raw.errors).toEqual(['claims[0].sourceIds: must be an array of source ids']);
      expect(raw.answers).toEqual([malformedAnswer, malformedAnswer, malformedAnswer]);

      const report = await readFillJson<{ failedUnits: { id: string; errors: string[]; rawAnswers: string }[] }>(join(state.root, 'report.json'));
      expect(report.failedUnits).toHaveLength(1);
      expect(report.failedUnits[0]!.id).toBe('claims-repository');
      expect(report.failedUnits[0]!.errors).toEqual(raw.errors);

      // The synthesis unit, which depends on the failed one, was never dispatched.
      await expect(readFillJson<FillUnit>(join(state.units, 'synthesis-pages.json'))).rejects.toThrow();
      expect(JSON.parse(await readFile(state.run, 'utf8')).status).toBe('blocked');
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 60000);

  test('a unit left running by a crashed process is requeued on the next start', async () => {
    const { root, registryText } = await productFixture();
    try {
      const commit = git(root, 'rev-parse', 'HEAD').trim();
      const state = fillStatePaths(root);
      await mkdir(state.units, { recursive: true });
      const crashedRun: FillRun = { schemaVersion: 1, id: 'crashed-run', productSnapshot: { repository: root, defaultBranch: 'main', commit, registryHash: hashFillInput(registryText) }, agentBranch: 'madarch/fill/crashed', status: 'running', controlOpen: true, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      await writeFile(state.run, JSON.stringify(crashedRun));
      const crashedUnit: FillUnit = { id: 'claims-repository', stage: 'claims', inputHashes: { index: 'old' }, status: 'running', outputPaths: ['.madarch/fill/outputs/claims-repository/claims.json'], attempt: 4, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      await writeFile(join(state.units, 'claims-repository.json'), JSON.stringify(crashedUnit));

      await startFill(root, { executorFactory: () => ({ execute: async () => malformedAnswer }) });
      const unit = await readFillJson<FillUnit>(join(state.units, 'claims-repository.json'));
      expect(unit.attempt).toBe(5);
      expect(unit.status).toBe('blocked');
      expect(unit.error).toContain('must be an array of source ids');
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 60000);

  test('a corrected answer completes the claims unit; a synthesis answer still invalid fails the synthesis unit and the run goes on', async () => {
    const { root } = await productFixture();
    try {
      let call = 0;
      const prompts: string[] = [];
      const result = await startFill(root, { executorFactory: () => ({ execute: async (prompt: string) => {
        prompts.push(prompt);
        call++;
        if (call === 1) return malformedAnswer;
        if (prompt.includes('Allowed source records')) {
          const marker = 'Allowed source records (cite these ids exactly):\n';
          const tail = prompt.slice(prompt.indexOf(marker) + marker.length);
          const catalogue = JSON.parse(tail.slice(tail.indexOf('['), tail.indexOf(']') + 1)) as { id: string }[];
          return JSON.stringify({ claims: [{ ...validClaim, sourceIds: [catalogue[0]!.id] }] });
        }
        return 'not json on purpose';
      } }) });
      // The synthesis stage retries its answer with the exact errors, then fails its one unit.
      expect(prompts).toHaveLength(5);
      expect(prompts[2]!).toContain('Target: {"name":"overview"');
      expect(prompts[3]).toContain('- Agent returned no JSON object');
      expect(prompts[3]).toContain('Your previous answer was');
      expect(result.run.status).toBe('blocked');
      expect(result.agentCalls).toEqual({ used: 5, cap: 60 });
      const claims = await readFillJson<FillUnit>(join(fillStatePaths(root).units, 'claims-repository.json'));
      expect(claims.status).toBe('complete');
      expect(prompts[1]).toContain('- claims[0].sourceIds: must be an array of source ids');
      const extraction = await readFillJson<{ claims: { sourceIds: string[] }[] }>(join(fillStatePaths(root).outputs, 'claims-repository', 'claims.json'));
      expect(extraction.claims).toHaveLength(1);
      expect(extraction.claims[0]!.sourceIds).toHaveLength(1);
      const synthesis = await readFillJson<FillUnit>(join(fillStatePaths(root).units, 'synthesis-pages.json'));
      expect(synthesis.status).toBe('blocked');
      expect(synthesis.attempt).toBe(1);
      expect(synthesis.error).toContain('Agent returned no JSON object');
      const raw = await readFillJson<{ unitId: string; attempts: number; errors: string[]; answers: string[] }>(join(fillStatePaths(root).outputs, 'synthesis-pages', 'invalid-answers.json'));
      expect(raw.unitId).toBe('synthesis-pages');
      expect(raw.attempts).toBe(3);
      expect(raw.answers.every((answer) => answer === 'not json on purpose')).toBe(true);
      const report = await readFillJson<{ failedUnits: { id: string; errors: string[] }[]; agentCalls: { used: number; cap: number } }>(join(fillStatePaths(root).root, 'report.json'));
      expect(report.failedUnits.map((unit) => unit.id)).toEqual(['synthesis-pages']);
      expect(report.agentCalls).toEqual({ used: 5, cap: 60 });
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 60000);
});

// ---- synthesis answers: the checkpoint's real model answers are the fixtures ----

const fixtureDir = join(import.meta.dir, 'fixtures', 'fill-synthesis-answers');
const fixtureAnswer = async (name: string): Promise<unknown> => {
  const raw = JSON.parse(await readFile(join(fixtureDir, `checkpoint-1-${name}.json`), 'utf8')).raw as string;
  const parsed = parseAgentAnswer(raw);
  if (!parsed.ok) throw new Error(`fixture ${name} must be parseable: ${parsed.error}`);
  return parsed.value;
};
const supportedClaims = await readFile(join(fixtureDir, 'supported-claims.json'), 'utf8').then((text) => JSON.parse(text) as { id: string; layer: string; sourceIds: string[] }[]);
const catalogue = await readFile(join(fixtureDir, 'source-catalogue.json'), 'utf8').then((text) => JSON.parse(text) as { id: string }[]);
const synthesisRules = { claims: supportedClaims, sourceIds: catalogue.map((source) => source.id), absenceAllowed: false };

describe('synthesis answer parsing against the recorded checkpoint answers', () => {
  test('the stored best answer (call 007) becomes a full page: prose/proseSegments and claim-id attribution are tolerated', async () => {
    const parsed = parseSynthesisAnswer(await fixtureAnswer('007'), synthesisRules);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.title).toBe('Training-Source Commerce Platform: Product Overview');
    expect(parsed.value.segments).toHaveLength(7);
    // Claims resolve to the supplied records: the answer may not alter a claim.
    expect(parsed.value.claims).toEqual(supportedClaims);
    const segment = parsed.value.segments[0]!;
    expect(segment.claimIds).toEqual(['clm-5886d7ab1752d4ed07ac060c']);
    expect(segment.sourceIds).toEqual(['src-eb6f77d808b91471e95a045b']);
    expect(segment.text).toContain('order lifecycle first');
    // The body is derived from the segments when the answer does not carry one.
    expect(parsed.value.body).toContain(parsed.value.segments.map((s) => s.text.trim()).join('\n\n').slice(0, 40));
  });

  test('the stored call 003 answer (prose keys) is parsed but refused with exact, fixable errors', async () => {
    const parsed = parseSynthesisAnswer(await fixtureAnswer('003'), synthesisRules);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    // prose moves into text; the remaining errors say exactly what is missing.
    expect(parsed.errors).toContain('segments[2].sourceIds: unknown source id "src-35de00d87d0e574454d00490203f35cc"');
    expect(parsed.errors.every((error) => error.includes('names no supported claim') || error.includes('unknown source id') || error.startsWith('claims:'))).toBe(true);
  });

  test('the stored call 005 answer (proseSegments key) parses prose but is refused until claims are named', async () => {
    const parsed = parseSynthesisAnswer(await fixtureAnswer('005'), synthesisRules);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    // The answer copies the supplied claims but never names which segment rests on which claim.
    expect(parsed.errors.filter((error) => error.includes('names no supported claim'))).toHaveLength(11);
    expect(parsed.errors.every((error) => error.includes('names no supported claim'))).toBe(true);
  });

  test('a schema-shaped answer with every documented field passes, and a wrong claim id is refused', () => {
    const claim = supportedClaims.find((row) => row.layer === 'fact')!;
    const good = { title: 'Overview', segments: [{ claimIds: [claim.id], text: 'The system was built up incrementally.', layer: 'fact', sourceIds: claim.sourceIds }], claims: [claim] };
    expect(parseSynthesisAnswer(good, synthesisRules).ok).toBe(true);
    const altered = { ...good, segments: [{ ...good.segments[0]!, claimIds: ['clm-not-supplied'] }] };
    const refused = parseSynthesisAnswer(altered, synthesisRules);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.errors.join('\n')).toContain('unknown claim id "clm-not-supplied"');
  });


  test('an answer that echoes claims but carries no prose segments is refused, so it retries instead of crashing past the reader', () => {
    const claim = supportedClaims.find((row) => row.layer === 'fact')!;
    const parsed = parseSynthesisAnswer({ title: 'T', claims: [claim] }, { ...synthesisRules, absenceAllowed: true });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.errors).toEqual(['Agent output field segments must be an array (a "proseSegments" key is also accepted)', 'segments: must contain the prose segments the named claims support, or return no claims for an absent kind']);
  });

  test('a segment citing a source no named claim covers is refused, and an overview with no content is refused', () => {
    const claim = supportedClaims[0]!;
    const good = { title: 'T', segments: [{ claimIds: [claim.id], text: 'x.', layer: 'fact', sourceIds: claim.sourceIds }], claims: [claim] };
    const uncovered = { ...good, segments: [{ ...good.segments[0]!, sourceIds: ['src-0d3fa8b9c9e96b02f486b77a'] }] };
    const parsed = parseSynthesisAnswer(uncovered, synthesisRules);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.errors.join('\n')).toContain('cited source "src-0d3fa8b9c9e96b02f486b77a" is not named by any claim');
    expect(parseSynthesisAnswer({ title: 'T', segments: [], claims: [] }, synthesisRules).ok).toBe(false);
    const kindPage = { ...synthesisRules, absenceAllowed: true };
    expect(parseSynthesisAnswer({ title: 'T', segments: [], claims: [] }, kindPage)).toEqual({ ok: true, value: { title: 'T', body: '', claims: [], segments: [] } });
  });
});

// ---- madarch-tzte.15: the call cap holds across resumes; attempts survive restarts ----

const readAgentCalls = async (root: string): Promise<{ chainId: string; runId: string; calls: number }> =>
  readFillJson(join(fillStatePaths(root).root, 'agent-calls.json'));

describe('the agent-call cap bounds one fill across its resumes', () => {
  test('a resume carries the spent calls of the chain and refuses to call past the cap', async () => {
    const { root } = await productFixture();
    try {
      const bad = '{"claims":[{"kind":"Overview","text":"x","layer":"fact","confidence":0.9,"sourceIds":42}]}';
      // Run 1: two spent calls, the cap stops the third agent call mid-claims-unit.
      await expect(startFill(root, { maxUnits: 2, executorFactory: () => ({ execute: async () => bad }) })).rejects.toThrow('maxUnits 2 exhausted before agent call 3');
      const spent = await readAgentCalls(root);
      expect(spent.calls).toBe(2);
      const runOneId = (await readFillJson<FillRun>(fillStatePaths(root).run)).id;
      // Same fill resumed: the two calls of the blocked run count toward the same cap.
      const result = await startFill(root, { maxUnits: 5, executorFactory: () => ({ execute: async () => bad }) });
      expect(result.run.status).toBe('blocked');
      expect(result.agentCalls).toEqual({ used: 5, cap: 5 });
      // counts.run names this run's calls; the chain-wide figure lives in agentCalls.used.
      expect(result.counts.run).toBe(3);
      const resumed = await readAgentCalls(root);
      expect(resumed.chainId).toBe(runOneId);
      expect(resumed.calls).toBe(5);
      // A unit left 'running' by the stopped first start keeps its attempt count.
      const claims = await readFillJson<FillUnit>(join(fillStatePaths(root).units, 'claims-repository.json'));
      expect(claims.attempt).toBe(2);
      // Only completed work is reused: the deterministic inventory unit, not the failed claims one.
      expect(result.counts.reused).toBe(1);
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 60000);

  test('a fill blocked before its first agent call does not inherit a completed fill\u2019s spent budget', async () => {
    const { root } = await productFixture();
    try {
      // A previous fill completed and spent its whole budget; agent-calls.json still holds it.
      const runState = fillStatePaths(root);
      await mkdir(runState.root, { recursive: true });
      const commit = git(root, 'rev-parse', 'HEAD').trim();
      const previous: FillRun = { schemaVersion: 1, id: 'prior-complete', fillChainId: 'prior-complete', productSnapshot: { repository: root, defaultBranch: 'main', commit, registryHash: hashFillInput('contract: 1\nstages:\n  - id: overview\n    name: Overview\nkinds:\n  - name: Overview\n    prefix: OV\n    folder: docs/overview\n    stage: overview\n    hint: Describe the product\n') }, agentBranch: 'madarch/fill/prior-complete', status: 'complete', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      await writeFile(runState.run, JSON.stringify(previous));
      await writeFile(join(runState.root, 'agent-calls.json'), JSON.stringify({ chainId: 'prior-complete', runId: 'prior-complete', calls: 60 }));
      // A new fill ran and blocked before dispatching any agent call; its run record owns the chain.
      const blocked: FillRun = { ...previous, id: 'blocked-early', fillChainId: undefined, status: 'blocked', agentBranch: 'madarch/fill/blocked-early' };
      await writeFile(runState.run, JSON.stringify(blocked));
      const result = await startFill(root, { maxUnits: 60, executorFactory: () => ({ execute: async (prompt: string) => prompt.includes('Allowed source records') ? malformedAnswer : 'not json' }) });
      // The spent 60 calls of the unrelated fill are not carried; this fill got its own fresh chain.
      expect(result.agentCalls).toEqual({ used: 3, cap: 60 });
      const saved = await readAgentCalls(root);
      // The resumed run joins the blocked fill's chain, seeded by that run's own id, not the completed one.
      expect(saved.chainId).toBe('blocked-early');
      expect(saved.calls).toBe(3);
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 60000);

  test('a completed fill ends the chain: the next fill starts a fresh budget and the synthesis attempt count survives', async () => {
    const { root } = await productFixture();
    try {
      const validAnswer = (prompt: string): string => {
        if (prompt.includes('Allowed source records')) {
          const marker = 'Allowed source records (cite these ids exactly):\n';
          const tail = prompt.slice(prompt.indexOf(marker) + marker.length);
          const catalogue = JSON.parse(tail.slice(tail.indexOf('['), tail.indexOf(']') + 1)) as { id: string }[];
          return JSON.stringify({ claims: [{ ...validClaim, sourceIds: [catalogue[0]!.id] }] });
        }
        if (prompt.includes('Supported claims:')) {
          const claimsJson = prompt.slice(prompt.indexOf('Supported claims: ') + 'Supported claims: '.length, prompt.indexOf('\nSource catalogue:'));
          const supplied = JSON.parse(claimsJson) as { id: string; sourceIds: string[] }[];
          const claim = supplied[0]!;
          return JSON.stringify({ title: 'Example overview', segments: [{ claimIds: [claim.id], text: `The example serves a wiki, per claim ${claim.id}.`, layer: 'fact', sourceIds: claim.sourceIds }], claims: [claim] });
        }
        return JSON.stringify({ findings: [] });
      };
      const executor = () => ({ execute: async (prompt: string) => validAnswer(prompt) });
      const first = await startFill(root, { maxUnits: 60, executorFactory: executor });
      expect(first.run.status).toBe('complete');
      expect(first.agentCalls).toEqual({ used: 5, cap: 60 });
      const firstChain = await readAgentCalls(root);
      expect(firstChain.chainId).toBe(first.run.id);
      expect(firstChain.calls).toBe(5);
      // A second fill of the same completed product starts a fresh chain: the first fill's spent
      // calls do not count. Its synthesis answer refuses, so the run blocks before any write.
      // The first fill's stage commit changed the product docs, so the claims unit runs again;
      // it answers correctly, and only the synthesis answer refuses, blocking before any write.
      const second = await startFill(root, { maxUnits: 60, executorFactory: () => ({ execute: async (prompt: string) => prompt.includes('Allowed source records') ? validAnswer(prompt) : 'still not json' }) });
      expect(second.run.status).toBe('blocked');
      expect(second.agentCalls).toEqual({ used: 4, cap: 60 });
      expect(second.counts.reused).toBe(3);
      const runTwo = await readAgentCalls(root);
      expect(runTwo.chainId).toBe(second.run.id);
      expect(runTwo.calls).toBe(4);
      // The synthesis unit's attempt count survives the restart instead of resetting to 1.
      const synthesis = await readFillJson<FillUnit>(join(fillStatePaths(root).units, 'synthesis-pages.json'));
      expect(synthesis.attempt).toBe(2);
      expect(synthesis.status).toBe('blocked');
      const claims = await readFillJson<FillUnit>(join(fillStatePaths(root).units, 'claims-repository.json'));
      // The claims unit ran again because the stage commit changed the product docs it reads.
      expect(claims.attempt).toBe(2);
      expect(claims.status).toBe('complete');
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 60000);

  test('a completed claims answer emits typed derived and agent-reported questions into the run output', async () => {
    const { root } = await productFixture();
    try {
      const answer = {
        claims: [
          { ...validClaim, sourceIds: ['README'] },
          { kind: 'Overview', text: 'README promises a guide the code never shows.', layer: 'assumed-meaning', confidence: 0.5, sourceIds: ['README'], conflictsWith: 'README.md', undocumented: true },
        ],
        questions: [
          { type: 'decision-rationale', title: 'Why the wiki is versioned', prompt: 'Why does the service version its wiki pages?', kind: 'Overview', claimTexts: ['The service serves a versioned wiki.', 'README promises a guide the code never shows.'] },
        ],
      };
      // Synthesis is out of scope here: its answer is refused, which blocks the synthesis unit only.
      const result = await startFill(root, { executorFactory: () => ({ execute: async (prompt: string) => {
        if (prompt.includes('Allowed source records')) {
          const marker = 'Allowed source records (cite these ids exactly):\n';
          const tail = prompt.slice(prompt.indexOf(marker) + marker.length);
          const catalogue = JSON.parse(tail.slice(tail.indexOf('['), tail.indexOf(']') + 1)) as { id: string; address: string }[];
          const readme = catalogue.find((source) => source.address === 'README.md')!.id;
          for (const row of answer.claims) row.sourceIds = [readme];
          return JSON.stringify(answer);
        }
        return 'not json on purpose';
      } }) });
      expect(result.run.status).toBe('blocked');
      const synthesis = await readFillJson<FillUnit>(join(fillStatePaths(root).units, 'synthesis-pages.json'));
      expect(synthesis.status).toBe('blocked');
      const extraction = await readFillJson<{ claims: { id: string; text: string; sourceIds?: string[] }[]; questions: { type: string; reason: string; dependsOn: string[]; rank: number; missing?: string }[]; inaccessibleLinks: { url: string; status: string; sourceId: string }[] }>(join(fillStatePaths(root).outputs, 'claims-repository', 'claims.json'));
      const claimBy = (text: string) => extraction.claims.find((claim) => claim.text === text)!.id;
      expect(extraction.questions.map((question) => question.type).sort()).toEqual(['access-or-document-needed', 'assumption-check', 'contradiction', 'decision-rationale', 'undocumented-behaviour']);
      const contradiction = extraction.questions.find((question) => question.type === 'contradiction')!;
      expect(contradiction.reason).toContain('README.md');
      expect(contradiction.dependsOn).toContain(claimBy('README promises a guide the code never shows.'));
      const link = extraction.questions.find((question) => question.type === 'access-or-document-needed')!;
      expect(link.missing).toBe('access');
      expect(link.reason).toContain('https://example.test/guide');
      const rationale = extraction.questions.find((question) => question.type === 'decision-rationale')!;
      expect(rationale.dependsOn).toContain(claimBy('The service serves a versioned wiki.'));
      expect(rationale.rank).toBe(1);
      const readmeClaim = extraction.claims.find((claim) => claim.text === 'README promises a guide the code never shows.')!;
      expect(extraction.inaccessibleLinks).toHaveLength(1);
      const unread = extraction.inaccessibleLinks[0]!;
      expect(unread).toEqual({ url: 'https://example.test/guide', status: 'not-attempted', sourceId: expect.stringMatching(/^src-/) });
      expect(readmeClaim.sourceIds).toContain(unread.sourceId);
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 60000);
});
