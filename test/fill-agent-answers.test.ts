import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { asArray, asSourceIdList, claimRowsFromAnswer, parseAgentAnswer, requestValidatedAgentAnswer, validateClaimsAnswer } from '../src/product/fill-agent-answers.js';
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
  await writeFile(join(root, 'README.md'), '# example product\n');
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

  test('a corrected answer on the retry completes the claims unit', async () => {
    const { root } = await productFixture();
    try {
      let call = 0;
      const prompts: string[] = [];
      // Synthesis is out of scope here: its first answer is refused, which stops the run after claims.
      await expect(startFill(root, { executorFactory: () => ({ execute: async (prompt: string) => {
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
      } }) })).rejects.toThrow('Agent returned no JSON object');
      const unit = await readFillJson<FillUnit>(join(fillStatePaths(root).units, 'claims-repository.json'));
      expect(unit.status).toBe('complete');
      expect(prompts[1]).toContain('- claims[0].sourceIds: must be an array of source ids');
      const extraction = await readFillJson<{ claims: { sourceIds: string[] }[] }>(join(fillStatePaths(root).outputs, 'claims-repository', 'claims.json'));
      expect(extraction.claims).toHaveLength(1);
      expect(extraction.claims[0]!.sourceIds).toHaveLength(1);
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 60000);
});
