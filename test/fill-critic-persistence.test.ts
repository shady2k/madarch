import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFill } from '../src/product/fill.js';
import { fileURLToPath } from 'node:url';
import { fillStatePaths, readFillJson, type FillUnit } from '../src/product/fill-runtime.js';

// The recorded streams are the real agent answers behind docs/changes/fill-pipeline-monday/checkpoint-2.md.
// The training source behind them is deterministic, so the fixture's source ids reproduce exactly; claim ids
// are derived from the run id, so the transcriber rewrites the recorded id strings into this run's id space
// (text-stable mapping) and changes nothing else in the recorded answers.
const recorded = async (name: string): Promise<string> =>
  (JSON.parse(await readFile(join(import.meta.dir, 'fixtures', 'fill-oci2-streams', `${name}.json`), 'utf8'))).raw as string;

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] } as const).toString();
const jsonOf = (raw: string): any => JSON.parse(raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, ''));
const targetFrom = (prompt: string): any => JSON.parse(prompt.slice(prompt.indexOf('Target: ') + 'Target: '.length, prompt.indexOf('\nPass: ')));
const pageFromCritic = (prompt: string): any => { const marker = 'Page: '; return JSON.parse(prompt.slice(prompt.indexOf(marker) + marker.length, prompt.indexOf('\nRegistry kind'))); };
const candidatesOf = (prompt: string): { id: string; kind: string; text: string }[] => { const marker = 'Supported claims: '; return JSON.parse(prompt.slice(prompt.indexOf(marker) + marker.length, prompt.indexOf('\nSource catalogue:'))); };
const transcribeIds = (raw: string, prompt: string): string => {
  const candidates = candidatesOf(prompt);
  const answer = jsonOf(raw);
  const recordedRows = (answer.claims ?? []) as { id: string; kind: string; text: string; [field: string]: unknown }[];
  // Recorded id -> text; then text -> this run's id (kind first, any kind as fallback: the recorded
  // echo may carry a wrong kind, which the reader tolerated by id).
  const recordedText = new Map(recordedRows.map((row) => [row.id, row.text] as const));
  const byKindText = new Map(candidates.map((claim) => [`${claim.kind}\u0000${claim.text}`, claim.id] as const));
  const byText = new Map(candidates.map((claim) => [claim.text, claim.id] as const));
  const mapId = (id: string): string => {
    if (id.startsWith('src-')) return id;
    const text = recordedText.get(id);
    if (text === undefined) return id;
    return byText.get(text) ?? id;
  };
  for (const row of recordedRows) { const mapped = byText.get(row.text); if (mapped) row.id = mapped; }
  for (const segment of (answer.segments ?? answer.proseSegments ?? [])) {
    for (const field of ['claimIds', 'sourceIds']) {
      if (!Array.isArray(segment[field])) continue;
      segment[field] = (segment[field] as string[]).map((id: string) => mapId(id));
    }
  }
  return JSON.stringify(answer);
};

const correctYaml = 'contract: 1\nstages:\n  - id: architecture\n    name: Architecture\nkinds:\n  - name: Data Entity\n    prefix: DE\n    folder: docs/data entitys\n    stage: architecture\n    hint: Describe sourced data entity evidence from the repository.\n  - name: Module\n    prefix: M\n    folder: docs/modules\n    stage: architecture\n    hint: Describe sourced module evidence from the repository.\n  - name: Service\n    prefix: SR\n    folder: docs/services\n    stage: architecture\n    hint: Describe sourced service evidence from the repository.\n  - name: Store\n    prefix: ST\n    folder: docs/stores\n    stage: architecture\n    hint: Describe sourced store evidence from the repository.\n';

const productFixture = async () => {
  const root = await mkdtemp(join(tmpdir(), 'madarch-oci2-'));
  const generator = fileURLToPath(new URL('../examples/training-repository/agent-stage/generate.mjs', import.meta.url));
  execFileSync('node', [generator, join(root, 'training-source-raw')], { stdio: ['ignore', 'pipe', 'pipe'] });
  await mkdir(join(root, 'repos'), { recursive: true });
  await mkdir(join(root, 'docs'), { recursive: true });
  await rename(join(root, 'training-source-raw'), join(root, 'repos', 'training-source'));
  await writeFile(join(root, 'workspace.yaml'), 'schemaVersion: 1\nid: oci2-fixture\nname: oci2-fixture\nskills:\n  madarch: "1.0.0"\nrepos:\n  - name: training-source\n    url: file:///training-source\n    moved: true\n');
  await writeFile(join(root, 'docs/kinds.yaml'), correctYaml);
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'Fixture');
  git(root, 'config', 'user.email', 'fixture@example.invalid');
  git(root, 'add', 'workspace.yaml', 'docs/kinds.yaml');
  git(root, 'commit', '-qm', 'fixture product with the training registry');
  return root;
};

describe('a critic-refused stage is a named unit outcome and accepted pages persist (recorded streams)', () => {
  test('accepted pages survive the blocked resume; the resume reuses them and runs only what is left', async () => {
    const root = await productFixture();
    try {
      const generateCounts: Record<string, number> = {};
      const criticCounts: Record<string, number> = {};
      const makeExecutor = (overrides: { critic?: Record<string, string | undefined>; generate?: Record<string, string | undefined> }) =>
        ({ execute: async (prompt: string) => {
          if (prompt.includes('Allowed source records')) return recorded('claims-accepted');
          if (prompt.includes('Critique the proposed page')) {
            const key = pageFromCritic(prompt).kind as string;
            criticCounts[key] = (criticCounts[key] ?? 0) + 1;
            return overrides.critic?.[key] ?? '```json\n{"findings":[]}\n```';
          }
          const target = targetFrom(prompt);
          generateCounts[target.name as string] = (generateCounts[target.name as string] ?? 0) + 1;
          const override = overrides.generate?.[target.name as string];
          if (override !== undefined) return override;
          const recordedName = target.name === 'overview' ? 'overview-accepted' : target.name === 'Data Entity' ? 'data-entity-accepted' : target.name === 'Module' ? 'module-accepted' : target.name === 'Service' ? 'service-accepted' : 'not-json';
          if (recordedName === 'not-json') return 'not json on purpose';
          return transcribeIds(await recorded(recordedName), prompt);
        } });

      // Phase 1: the overview is accepted and journaled the moment the critic accepts it; the Data
      // Entity page is refused through every bounded pass - a named blocked unit outcome with report.json.
      const first = await startFill(root, { executorFactory: () => makeExecutor({ critic: { 'Data Entity': '["deliberately rejected forever"]' } }) });
      expect(first.run.status).toBe('blocked');
      const state = fillStatePaths(root);
      const unit = await readFillJson<FillUnit>(join(state.units, 'synthesis-pages.json'));
      expect(unit.status).toBe('blocked');
      expect(unit.attempt).toBe(1);
      expect(unit.error).toContain('Critic did not accept Data Entity page after 4 bounded passes');
      const report = await readFillJson<{ failedUnits: { id: string; errors: string[] }[]; agentCalls: { used: number; cap: number } }>(join(state.root, 'report.json'));
      expect(report.failedUnits.map((failed) => failed.id)).toEqual(['synthesis-pages']);
      expect(report.failedUnits[0]!.errors[0]).toContain('deliberately rejected forever');
      const record = await readFillJson<{ unitId: string; target: string; passes: number; findings: string[] }>(join(state.outputs, 'synthesis-pages', 'critic-rejection.json'));
      expect(record).toMatchObject({ unitId: 'synthesis-pages', target: 'Data Entity', passes: 4, findings: ['deliberately rejected forever'] });
      const journalPath = join(state.outputs, 'synthesis-pages', 'accepted-pages.json');
      const journal = JSON.parse(await readFile(journalPath, 'utf8')) as { key: string; page: { title: string } }[];
      expect(journal).toHaveLength(1);
      expect(journal[0]!.page.title).toBe('Overview');
      expect(generateCounts).toEqual({ overview: 1, 'Data Entity': 4 });
      expect(criticCounts).toEqual({ overview: 1, 'Data Entity': 4 });
      expect(report.agentCalls).toEqual({ used: 11, cap: 60 });

      // Phase 2: the same fill resumes. Claims and the accepted overview cost no calls; the Data
      // Entity page passes with its recorded answer; Module and Service follow; the Stores page has
      // no recorded answer (the checkpoint never produced one), so the fixture answers in its shape.
      const second = await startFill(root, { executorFactory: () => makeExecutor({ generate: { Store: '{"title":"Stores","segments":[],"claims":[]}' } }) });
      expect(second.run.status).toBe('complete');
      expect(second.agentCalls).toEqual({ used: 19, cap: 60 });
      expect(generateCounts).toEqual({ overview: 1, 'Data Entity': 5, Module: 1, Service: 1, Store: 1 });
      expect(criticCounts).toEqual({ overview: 1, 'Data Entity': 5, Module: 1, Service: 1, Store: 1 });
      const journalAfter = JSON.parse(await readFile(journalPath, 'utf8')) as { page: { title: string } }[];
      expect(journalAfter.map((row) => row.page.title)).toEqual(['Overview', 'Data Entities: Order, Payment, and Settlement Shapes', 'Module Overview', 'Payments Platform Services', 'Stores']);
      const unitAfter = await readFillJson<FillUnit>(join(state.units, 'synthesis-pages.json'));
      expect(unitAfter.status).toBe('complete');
      expect(unitAfter.attempt).toBe(2);
      // The refusal record of phase 1 is retired by the completing pass.
      await expect(readFillJson(join(state.outputs, 'synthesis-pages', 'critic-rejection.json'))).rejects.toThrow();
      const head = git(root, 'rev-parse', 'HEAD').trim();
      const proposed = git(root, 'ls-tree', '-r', '--name-only', head).trim().split('\n').filter((path) => path.endsWith('.proposed.md'));
      expect(proposed).toHaveLength(5);
      // The fill merges with a fast-forward of the product's default branch: the pages are in git.
      const proposedTexts = await Promise.all(proposed.map((path) => git(root, 'show', `${head}:${path}`)));
      const overviewText = proposedTexts.find((text) => text.includes('# Overview'))!;
      expect(overviewText).toBeTruthy();
      expect(overviewText).toContain("The repository's Git history records three commits");
      expect(overviewText).toContain('## Evidence');
    } finally { await rm(root, { recursive: true, force: true }); }
  }, 120000);
});
