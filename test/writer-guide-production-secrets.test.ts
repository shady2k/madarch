/** Actual fill guide factory: no injected sensitive values and no alternate validation callback. */
import { expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPGliteDatabaseOwner } from '../src/adapters/database-owner.js';
import { createGraphStore } from '../src/graph/index.js';
import { fillGraph } from '../src/extract/driver/index.js';
import { extractFiles } from '../src/extract/driver/files.js';
import { extractOperations } from '../src/extract/operations/index.js';
import { createGitSnapshotSource } from '../src/fill/snapshot.js';
import { createFillGuideWriter } from '../src/knowledge/fill-worker.js';
import { seedStarterSet } from '../src/knowledge/seed.js';
import { firstGuideCursor, readGuidePageContext, type GuideContextPage } from '../src/writer/guides/prepared.js';
import { validateGuide } from '../src/writer/guides/validate.js';
import { GUIDE_SCHEMA } from '../src/writer/guides/model.js';
import { guidePacketPolicy, containsGuideSecret, distinctiveGuideValue, type GuidePreparedEvidence } from '../src/writer/guides/writer.js';
import { gitEnv } from './git-env.js';

const SECRET = 'private-runtime-key';
const PUNCTUATED_SECRETS = ['private"credential', 'private/credential'] as const;
const COMMAND = 'node -e "console.log(7)"';
const PARAGRAPH = `Run \`${COMMAND}\` from the repository root in an isolated fixture environment. Expected exit status: 0. Expected output: 7.`;

test('production fill authority withholds named settings but refuses distinctive cwd before any verifier', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'guide-production-secrets-'));
  const owner = createPGliteDatabaseOwner({ btreeGist: true });
  try {
    mkdirSync(join(folder, 'services', 'api'), { recursive: true });
    writeFileSync(join(folder, 'services', 'api', 'config.ts'), `export const configured = process.env.SIGNING_KEY ?? "${SECRET}";\n`);
    writeFileSync(join(folder, 'docker-compose.yml'), `services:\n  api:\n    build:\n      context: .\n    environment:\n      SIGNING_KEY: ${SECRET}\n`);
    writeFileSync(join(folder, 'tsconfig.json'), JSON.stringify({ compilerOptions: { moduleResolution: 'node' }, observation: 'Ready', type: 'object' }));
    writeFileSync(join(folder, 'settings.json'), JSON.stringify({ minimum: 0, moduleResolution: 'node' }));
    writeFileSync(join(folder, 'secret-store.json'), JSON.stringify({ kind: 'Secret', stringData: { quotedSetting: PUNCTUATED_SECRETS[0], pathSetting: PUNCTUATED_SECRETS[1] } }));
    writeFileSync(join(folder, 'README.md'), `# Readiness\n\n${PARAGRAPH}\n\nQuoted configuration example: '${PUNCTUATED_SECRETS[0]}'.\n\nPath configuration example: '${PUNCTUATED_SECRETS[1]}'.\n`);
    const env = gitEnv({ GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.test', GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.test' });
    const git = (...args: string[]) => execFileSync('git', args, { cwd: folder, env, encoding: 'utf8' }).trim();
    git('init', '--quiet', '--initial-branch=main'); git('add', '.'); git('-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'Record configuration and readiness');
    const commit = git('rev-parse', 'HEAD');
    const store = createGraphStore(owner); await store.createSchema();
    const filled = await fillGraph({ owner, store, repository: folder, extractors: [extractFiles, extractOperations] });
    const snapshots = createGitSnapshotSource([{ id: 'sample', form: 'code', root: folder, commit }]);
    seedStarterSet(folder);
    let verifierCalls = 0;
    const writer = await createFillGuideWriter({ owner, store, snapshots, output: folder, scope: filled.repositoryNode, valid: filled.commits[0]!.effectiveTime,
      agent: { run: async (request) => { verifierCalls++; const payload = JSON.parse(request.prompt.slice(request.prompt.lastIndexOf('\n\n') + 2)) as { identity: string }; await request.tools.call('verify_guide_step', { identity: payload.identity, instructionSupported: true, expectedSupported: true }); } },
    }); // Deliberately NO sensitiveValues and NO custom containsSecret.
    const unit = await writer.prepare('user-guide', 'en');
    const header = JSON.parse(unit.prompt) as { context: unknown; inputDigest: string; unitVersion: string };
    let cursor: string | null = firstGuideCursor(unit)!;
    const entries: unknown[] = [];
    while (cursor !== null) { const page: GuideContextPage = readGuidePageContext(unit, cursor)!; entries.push(...page.entries); cursor = page.next; }
    expect(JSON.stringify(entries)).not.toContain(SECRET);
    const noPrivateValues = (value: unknown): void => {
      if (typeof value === 'string') for (const secret of PUNCTUATED_SECRETS) expect(value).not.toContain(secret);
      else if (Array.isArray(value)) value.forEach(noPrivateValues);
      else if (value !== null && typeof value === 'object') for (const [key, child] of Object.entries(value)) { noPrivateValues(key); noPrivateValues(child); }
    };
    noPrivateValues(entries); // Decoded values, including internal quote/slash, never reach prepared agent context.

    expect(JSON.stringify(entries)).toContain('value of');
    expect(JSON.stringify(entries)).toContain('SIGNING_KEY');
    expect(JSON.stringify(entries)).toContain('whole-word matching');
    expect(unit.validation.containsSecret?.('node')).toBe(false);
    expect(unit.validation.containsSecret?.('0')).toBe(false);
    expect(unit.validation.containsSecret?.('.')).toBe(false);
    const source = entries.find((entry) => entry !== null && typeof entry === 'object' && (entry as { type?: string }).type === 'source' && (entry as { text?: string }).text === PARAGRAPH) as { ground: unknown } | undefined;
    expect(source).toBeDefined(); // Ordinary config '.' / 'node' must NOT remove the original readiness paragraph.
    const step = { id: 'status', title: 'Read a number object', cwd: '.', environment: 'isolated', inputs: [], instruction: { kind: 'command', content: COMMAND }, expected: { status: 0, observation: 'Ready' }, grounds: [source!.ground] };
    const raw = { schema: GUIDE_SCHEMA, id: 'user-guide:main', kind: 'user-guide', locale: 'en', title: 'Read a number object', context: header.context, unitVersion: header.unitVersion, inputDigest: header.inputDigest, prerequisites: [], gaps: ['Only readiness is evidenced'], procedures: [{ id: 'read', title: 'Read readiness', role: 'Reader', goal: 'Observe readiness', prerequisites: [], steps: [{ ...step, id: 'first' }, { ...step, id: 'second', cwd: `repos/sample/${SECRET}` }] }] };
    const refused = await validateGuide(raw, unit.validation);
    expect(refused.ok).toBe(false); expect(verifierCalls).toBe(0);
    if (refused.ok) throw new Error('production authority accepted a distinctive configuration token');
    expect(refused.diagnostics.some((diagnostic) => diagnostic.path === '$.procedures[0].steps[1].cwd' && diagnostic.code === 'secret')).toBe(true);
    expect(JSON.stringify(refused)).not.toContain(SECRET);
    for (const secret of PUNCTUATED_SECRETS) {
      const privateTitle = structuredClone(raw);
      privateTitle.procedures[0]!.steps[1]!.cwd = '.';
      privateTitle.title = `Read '${secret}'`;
      const titleRefused = await validateGuide(privateTitle, unit.validation);
      expect(titleRefused.ok).toBe(false); expect(verifierCalls).toBe(0);
      if (titleRefused.ok) throw new Error('production authority accepted a distinctive title value');
      expect(titleRefused.diagnostics.some((diagnostic) => diagnostic.path === '$.title' && diagnostic.code === 'secret')).toBe(true);
      expect(JSON.stringify(titleRefused)).not.toContain(secret);
    }
    const suffix = structuredClone(raw); suffix.procedures[0]!.steps[1]!.cwd = `repos/sample/${SECRET}-suffix`;
    expect((await validateGuide(suffix, unit.validation)).ok).toBe(false); expect(verifierCalls).toBe(0);
    const safe = structuredClone(raw); safe.procedures[0]!.steps[1]!.cwd = '.';
    expect((await validateGuide(safe, unit.validation)).ok).toBe(true); expect(verifierCalls).toBe(2);
  } finally { await owner.close(); rmSync(folder, { recursive: true, force: true }); }
}, 20_000);

test('distinctiveness is lexical, exact-token refusal retains the host checker and counts ordinary limitations', () => {
  for (const ordinary of ['0', 'Ready', 'object', 'number']) expect(distinctiveGuideValue(ordinary)).toBe(false);
  for (const distinctive of [SECRET, 'a1', '.', 'key_value', 'private"credential']) expect(distinctiveGuideValue(distinctive)).toBe(true);
  expect(containsGuideSecret(`repos/sample/${SECRET}`, [SECRET])).toBe(true);
  expect(containsGuideSecret(`repos/sample/${SECRET}-suffix`, [SECRET])).toBe(true);
  expect(containsGuideSecret(`prefix${SECRET}`, [SECRET])).toBe(true);
  const context = { valid: '2026-01-01T00:00:00Z', known: '2026-01-02T00:00:00Z', state: '0', repositories: [{ name: 'sample', commit: 'a'.repeat(40) }] };
  const evidence: GuidePreparedEvidence = { context, facts: [], spans: [], gaps: [], configValues: ['0', 'Ready', 'object', SECRET], policy: { version: 'withhold-config-values@1', withheldValues: 0, classifiedSources: [] } };
  const policy = guidePacketPolicy(evidence, [], (text) => text.includes('host-controlled'));
  const hostKnown = guidePacketPolicy(evidence, ['café']);
  expect(hostKnown.containsSecret('caféé')).toBe(true); // Explicit host-known authority stays strict.
  expect(policy.containsSecret('prefix-host-controlled-suffix')).toBe(true); // Callback authority is never weakened by the lexical policy.
  expect(policy.containsSecret(`repos/${SECRET}`)).toBe(true);
  expect(policy.containsSecret('Ready object 0')).toBe(true);
  expect(policy.containsSecret('Readiness objects 10')).toBe(false);
  expect(policy.evidence.policy.ordinaryRefusalExcluded).toBe(0);
  expect(policy.evidence.policy.wholeWordValues).toBe(3);
  expect(policy.evidence.gaps.some((gap) => gap.includes('3 configuration values use whole-word matching'))).toBe(true);
});
