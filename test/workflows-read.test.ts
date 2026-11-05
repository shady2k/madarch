/**
 * The product's workflows (decision 0033, items 1 and 2): `src/knowledge/workflows.ts` reads
 * `madarch/workflows.yaml` — a named set of the engine's stage ids, the capabilities giving the order —
 * and refuses a stage the registry does not hold and a stage whose required input no stage of the
 * workflow produces, naming the file, the line, the workflow and the stage. A planned workflow may name
 * no stages. Fixtures only: a small product folder, and the starter set's own manifest read once.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, test } from 'bun:test';
import { Type } from 'typebox';
import { readKinds } from '../src/knowledge/kinds.js';
import { STARTER_FILES } from '../src/knowledge/seed.js';
import { STARTER_WORKFLOWS } from '../src/knowledge/starter-workflows.js';
import { parseWorkflows, readWorkflows, WORKFLOWS_FILE, type WorkflowsRead } from '../src/knowledge/workflows.js';
import { StageRegistry } from '../src/fill/registry.js';
import { createEngineStageRegistry } from '../src/fill/stages/index.js';
import { DEFAULT_STAGE_DEFAULTS, type FillStage } from '../src/fill/stage.js';

const made: string[] = [];
afterAll(() => {
  for (const folder of made.splice(0)) rmSync(folder, { recursive: true, force: true });
});

const STARTER = STARTER_FILES.find((file) => file.path === WORKFLOWS_FILE)!.content;

/** A product folder holding the starter set, its workflows manifest written as `workflows` says. */
function product(workflows?: string): string {
  const folder = mkdtempSync(join(tmpdir(), 'madarch-workflows-read-'));
  made.push(folder);
  for (const file of STARTER_FILES) {
    const path = join(folder, file.path);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, file.path === WORKFLOWS_FILE && workflows !== undefined ? workflows : file.content);
  }
  return folder;
}

/** The 1-based line the file writes `text` on, read as the check reads it. */
function lineOf(text: string, needle: string): number {
  return text.split('\n').findIndex((line) => line.trim() === needle) + 1;
}

/** The starter manifest with one workflow's stages replaced whole. */
function stagesOf(name: string, stages: readonly string[]): string {
  const lines = STARTER.split('\n');
  const start = lines.indexOf(`  ${name}:`);
  const stagesAt = lines.findIndex((line, index) => index > start && line.startsWith('    stages:'));
  let end = stagesAt + 1;
  while (end < lines.length && lines[end]!.startsWith('      ')) end += 1;
  const written = stages.length === 0 ? ['    stages: []'] : ['    stages:', ...stages.map((stage) => `      - ${stage}`)];
  return [...lines.slice(0, stagesAt), ...written, ...lines.slice(end)].join('\n');
}

/** A stage whose declaration says only what the derivation reads, for a registry no product has. */
function stage(id: string, consumes: readonly string[], produces: readonly string[]): FillStage {
  return {
    id,
    version: 1,
    consumes: { required: consumes.map((capability) => ({ capability, scope: 'product' as const })), optional: [] },
    produces: produces.map((kind) => ({ kind, schemaVersion: 1, scope: 'product' as const })),
    configSchema: Type.Object({}),
    defaults: { ...DEFAULT_STAGE_DEFAULTS, config: {} },
    plan: () => ({ units: [] }),
    execute: () => ({ outcome: 'draft' }),
    validate: () => ({ ok: true }),
  };
}

/** The workflows of one text, read against the engine's stage registry. */
function readText(text: string): WorkflowsRead {
  return { ...parseWorkflows(text, 'madarch/workflows.yaml'), present: true };
}

describe('the workflows the starter set declares', () => {
  test('`madarch new` writes four workflows, and every stage they name is one the engine\'s registry holds', () => {
    const read = readWorkflows(product());
    expect(read.present).toBe(true);
    expect(read.findings).toEqual([]);
    expect([...read.workflows.keys()]).toEqual(['branch-worktree', 'first-fill', 'history-point', 'update-by-commit']);
    const held = new Set(createEngineStageRegistry().all().map((one) => one.id));
    for (const workflow of read.workflows.values()) {
      for (const id of workflow.stages) expect(held.has(id)).toBe(true);
    }
    const firstFill = read.workflows.get('first-fill')!;
    expect(firstFill.status).toBe('implemented');
    // The first fill names the stages of the fill as the registry holds them today: the eight deterministic
    // stages, the seven agent stages a run registers when it names an agent, and the narrative stage.
    expect(firstFill.stages).toEqual([
      'snapshot', 'history', 'inventory', 'build-configuration', 'document-index', 'syntax', 'semantic-resolution',
      'modules', 'boundaries', 'intent-history', 'overview', 'understanding', 'recovery', 'doc-intent', 'narrative',
    ]);
    expect(read.workflows.get('update-by-commit')!.stages).toEqual(firstFill.stages);
    expect(read.workflows.get('branch-worktree')!.status).toBe('planned');
    expect(read.workflows.get('branch-worktree')!.stages).toEqual([]);
    expect(read.workflows.get('history-point')!.status).toBe('planned');
    expect(read.workflows.get('history-point')!.stages).toEqual([]);
  }, 30_000);

  test('a workflow of stages the registry holds reads without a finding, and keeps the order the file writes', () => {
    const text = [
      'workflows:',
      '  first-fill:',
      '    status: implemented',
      '    stages: [snapshot, inventory, syntax, modules]',
      '',
    ].join('\n');
    const read = readText(text);
    expect(read.findings).toEqual([]);
    expect(read.workflows.get('first-fill')!.stages).toEqual(['snapshot', 'inventory', 'syntax', 'modules']);
  });

  test('a planned workflow may name no stages, and may name stages the registry holds', () => {
    const text = ['workflows:', '  branch-worktree:', '    status: planned'].join('\n');
    const read = readText(text);
    expect(read.findings).toEqual([]);
    expect(read.workflows.get('branch-worktree')!.stages).toEqual([]);
    const named = readText('workflows:\n  branch-worktree:\n    status: planned\n    stages: [snapshot]\n');
    expect(named.findings).toEqual([]);
    expect(named.workflows.get('branch-worktree')!.stages).toEqual(['snapshot']);
  });

  test('a product without a workflows manifest has none, and no finding about it', () => {
    const folder = mkdtempSync(join(tmpdir(), 'madarch-workflows-none-'));
    made.push(folder);
    expect(readWorkflows(folder)).toMatchObject({ present: false, findings: [] });
  });
});

describe('the refusals of the workflow check', () => {
  test('a workflow naming a stage the registry does not hold is refused, naming the file, line, workflow and stage', () => {
    const text = stagesOf('first-fill', ['snapshot', 'teleport']);
    const read = readText(text);
    const file = 'madarch/workflows.yaml';
    expect(read.findings).toEqual([{
      file,
      line: lineOf(text, '- teleport'),
      message: 'workflow "first-fill" stage "teleport": the engine\'s stage registry holds no stage "teleport" (its stages are boundaries, build-configuration, doc-intent, document-index, history, intent-history, inventory, modules, narrative, overview, recovery, semantic-resolution, snapshot, syntax, understanding)',
    }]);
    // The refused workflow is left out, and the others stand.
    expect(read.workflows.has('first-fill')).toBe(false);
    expect(read.workflows.has('update-by-commit')).toBe(true);
  });

  test('a stage whose input no earlier stage produces is refused by the derivation\'s own path', () => {
    // Modules reads `symbol`, and syntax is the stage that produces it: a workflow that leaves syntax out starves modules.
    const text = stagesOf('first-fill', ['snapshot', 'inventory', 'modules']);
    const read = readText(text);
    expect(read.findings).toEqual([{
      file: 'madarch/workflows.yaml',
      line: lineOf(text, '- modules'),
      message: 'workflow "first-fill" stage "modules": modules → symbol → syntax (disabled): the workflow names no stage that produces the input "symbol"',
    }]);
    expect(read.workflows.has('first-fill')).toBe(false);
  });

  test('an implemented workflow is checked, and a planned one keeps a starved input: the engine cannot run it yet', () => {
    const workflow = (status: string): string => ['workflows:', '  branch-worktree:', `    status: ${status}`, '    stages:', '      - modules', ''].join('\n');
    expect(readText(workflow('implemented')).findings.map((finding) => finding.message)).toEqual([
      'workflow "branch-worktree" stage "modules": modules → file → inventory (disabled): the workflow names no stage that produces the input "file"',
      'workflow "branch-worktree" stage "modules": modules → symbol → syntax (disabled): the workflow names no stage that produces the input "symbol"',
    ]);
    expect(readText(workflow('planned')).findings).toEqual([]);
  });

  test('a stage no stage of this madarch produces is refused by the derivation\'s no-producer path', () => {
    const registry = new StageRegistry().register(stage('wants', ['unicorn'], []));
    const read = parseWorkflows('workflows:\n  first-fill:\n    status: implemented\n    stages: [wants]\n', 'madarch/workflows.yaml', registry);
    expect(read.findings.map((finding) => finding.message)).toEqual([
      'workflow "first-fill" stage "wants": wants → unicorn → no producer: no stage of this madarch produces the input "unicorn"',
    ]);
  });

  test('a cycle of the workflow\'s stages is refused by its own path', () => {
    const registry = new StageRegistry().register(stage('one', ['two-out'], ['one-out'])).register(stage('two', ['one-out'], ['two-out']));
    const read = parseWorkflows('workflows:\n  first-fill:\n    status: implemented\n    stages: [one, two]\n', 'madarch/workflows.yaml', registry);
    expect(read.findings.map((finding) => finding.message)).toEqual(['workflow "first-fill": one → two → one: the workflow\'s stages order themselves in a cycle']);
  });

  test('a stage named twice is refused, and so is a stage id that is no stage id', () => {
    const twice = readText('workflows:\n  first-fill:\n    status: implemented\n    stages: [snapshot, snapshot]\n');
    expect(twice.findings.map((finding) => [finding.line, finding.message])).toEqual([[4, 'workflow "first-fill": the stage "snapshot" is named twice: a workflow\'s stages are a set']]);
    const wrong = readText('workflows:\n  first-fill:\n    status: implemented\n    stages: ["2 fast"]\n');
    expect(wrong.findings.map((finding) => finding.message)).toEqual(['workflow "first-fill": the stage "2 fast" is not a stage id: a stage id starts with a letter and carries letters, digits, ".", "_" or "-"']);
  });

  test('a workflow that leaves its status out, or names one the engine does not know, is refused', () => {
    const absent = readText('workflows:\n  first-fill:\n    stages: [snapshot]\n');
    expect(absent.findings.map((finding) => finding.message)).toEqual(['workflow "first-fill": "status" is one of implemented, planned, got undefined']);
    const unknown = readText('workflows:\n  first-fill:\n    status: someday\n    stages: [snapshot]\n');
    expect(unknown.findings.map((finding) => finding.message)).toEqual(['workflow "first-fill": "status" is one of implemented, planned, got "someday"']);
  });

  test('an implemented workflow that names no stages is refused, and a planned one is not', () => {
    const implemented = readText('workflows:\n  first-fill:\n    status: implemented\n    stages: []\n');
    expect(implemented.findings.map((finding) => finding.message)).toEqual([
      'workflow "first-fill": an implemented workflow names the stage ids it runs, and this one names none',
    ]);
    expect(readText('workflows:\n  first-fill:\n    status: planned\n    stages: []\n').findings).toEqual([]);
  });

  test('a workflow field that is not status or stages is refused, and so is a file that is no workflows mapping', () => {
    const stray = readText('workflows:\n  first-fill:\n    status: planned\n    edges: [snapshot -> syntax]\n');
    expect(stray.findings.map((finding) => finding.message)).toEqual(['workflow "first-fill": "edges" is not a field of a workflow: the fields are status and stages']);
    expect(readText('[]\n').findings.map((finding) => finding.message)).toEqual(['the manifest is a mapping with a "workflows" mapping in it']);
    expect(readText('workflows: []\n').findings.map((finding) => finding.message)).toEqual(['"workflows" maps each workflow\'s name to { status, stages }: a workflow is a named set of the engine\'s stage ids, and the capabilities give the order']);
    expect(readText('workflows: {}\nstages: []\n').findings.map((finding) => finding.message)).toEqual(['"stages" is not a field of the manifest: the manifest holds "workflows"']);
  });
});

describe('the product-wiki check reads the workflows with the manifest', () => {
  test('a product whose workflow names a stage the registry does not hold shows the finding with its own file and line', () => {
    const text = stagesOf('update-by-commit', ['snapshot', 'teleport']);
    const folder = product(text);
    const read = readKinds(folder);
    if (!read.present) throw new Error('the product holds no kinds manifest');
    expect(read.manifest.workflows?.workflows.has('update-by-commit')).toBe(false);
    const expected = `workflow "update-by-commit" stage "teleport": the engine's stage registry holds no stage "teleport" (its stages are boundaries, build-configuration, doc-intent, document-index, history, intent-history, inventory, modules, narrative, overview, recovery, semantic-resolution, snapshot, syntax, understanding)`;
    expect(read.manifest.workflows?.findings.map((finding) => [finding.file, finding.line, finding.message])).toEqual([[join(folder, WORKFLOWS_FILE), lineOf(text, '- teleport'), expected]]);
    // The Problems page reads the manifest's findings: the workflow's stands beside the kinds' own (of which this starter set has none).
    expect(read.manifest.findings.map((finding) => [finding.file.endsWith(WORKFLOWS_FILE), finding.message])).toEqual([[true, expected]]);
  }, 30_000);

  test('the starter set reads with no workflow finding', () => {
    const read = readKinds(product());
    if (!read.present) throw new Error('the product holds no kinds manifest');
    expect(read.manifest.findings).toEqual([]);
    expect(read.manifest.workflows?.workflows.size).toBe(4);
  }, 30_000);

  test('the starter data names only stages the engine\'s registry holds, and the four workflows it declares', () => {
    const held = new Set(createEngineStageRegistry().all().map((one) => one.id));
    expect(STARTER_WORKFLOWS.map((workflow) => workflow.name)).toEqual(['branch-worktree', 'first-fill', 'history-point', 'update-by-commit']);
    for (const workflow of STARTER_WORKFLOWS) for (const id of workflow.stages) expect(held.has(id)).toBe(true);
  }, 30_000);
});
