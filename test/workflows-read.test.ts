/**
 * The product's workflows (decision 0033, items 1 and 2): `src/knowledge/workflows.ts` reads
 * `madarch/workflows.yaml` — a named set of the engine's stage ids, the capabilities giving the order —
 * and refuses a stage the registry does not hold and a stage whose required input no stage of the
 * workflow produces, naming the file, the line, the workflow and the stage. A planned workflow may name
 * no stages, and the stages it does name are checked as an implemented workflow's are. Fixtures only: a
 * small product folder, and the starter set's own manifest read once.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, test } from 'bun:test';
import { Type } from 'typebox';
import { readKinds } from '../src/knowledge/kinds.js';
import { STARTER_FILES } from '../src/knowledge/seed.js';
import { STARTER_WORKFLOWS } from '../src/knowledge/starter-workflows.js';
import { parseWorkflows, readWorkflowsFrom, WORKFLOWS_FILE, type WorkflowsRead } from '../src/knowledge/workflows.js';
import { StageRegistry } from '../src/fill/registry.js';
import { createEngineStageRegistry } from '../src/fill/stages/index.js';
import { DEFAULT_STAGE_DEFAULTS, type FillStage } from '../src/fill/stage.js';
import { workingTreeFiles } from '../src/knowledge/product-files.js';

const FILE = 'madarch/workflows.yaml';


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
  return { ...parseWorkflows(text, FILE), present: true };
}

/** The messages of one text's findings, each with the line it stands on. */
function refusals(text: string): [number, string][] {
  return readText(text).findings.map((finding) => [finding.line, finding.message]);
}

describe('the workflows the starter set declares', () => {
  test('`madarch new` writes four workflows, and every stage they name is one the engine\'s registry holds', () => {
    const read = readWorkflowsFrom(workingTreeFiles(product()), product());
    expect(read.present).toBe(true);
    expect(read.findings).toEqual([]);
    expect([...read.workflows.keys()]).toEqual(['branch-worktree', 'first-fill', 'history-point', 'update-by-commit']);
    const held = new Set(createEngineStageRegistry().all().map((one) => one.id));
    for (const workflow of read.workflows.values()) for (const id of workflow.stages) expect(held.has(id)).toBe(true);
    const firstFill = read.workflows.get('first-fill')!;
    expect(firstFill.status).toBe('implemented');
    // The first fill names the stages of the fill as the starter set declares them, and every one is a stage this
    // engine's registry holds: the list is the starter set's own, never a second one written here.
    expect(firstFill.stages).toEqual([...STARTER_WORKFLOWS.find((one) => one.name === 'first-fill')!.stages]);
    for (const id of firstFill.stages) expect(held.has(id)).toBe(true);
    // No engine stage waits for a commit, picks one up in the background or narrows a fill to the files a commit
    // changed (0033, item 25): update by commit is planned, and running the fill at a new commit is a first fill again.
    expect(read.workflows.get('update-by-commit')!.status).toBe('planned');
    expect(read.workflows.get('update-by-commit')!.stages).toEqual([]);
    expect(read.workflows.get('branch-worktree')!.status).toBe('planned');
    expect(read.workflows.get('branch-worktree')!.stages).toEqual([]);
    expect(read.workflows.get('history-point')!.status).toBe('planned');
    expect(read.workflows.get('history-point')!.stages).toEqual([]);
    // Every workflow writes its stages, an empty list included: a planned workflow says so in the file a person reads.
    expect(STARTER.match(/^    stages:/gm)?.length).toBe(STARTER_WORKFLOWS.length);
    expect(STARTER.match(/^    stages: \[\]$/gm)?.length).toBe(STARTER_WORKFLOWS.filter((workflow) => workflow.status === 'planned').length);
  }, 30_000);

  
  
  test('the workflows read in code point order of their names, whatever order the file writes them in', () => {
    const read = readText('workflows:\n  zebra:\n    status: planned\n  alpha:\n    status: planned\n  Middle:\n    status: planned\n');
    expect(read.findings).toEqual([]);
    expect([...read.workflows.keys()]).toEqual(['Middle', 'alpha', 'zebra']);
  });

  test('a product without a workflows manifest has none, and a product\'s kinds manifest reads with no workflows field', () => {
    const folder = mkdtempSync(join(tmpdir(), 'madarch-workflows-none-'));
    made.push(folder);
    expect(readWorkflowsFrom(workingTreeFiles(folder), folder)).toMatchObject({ present: false, findings: [] });
    // The wiki's read of a product with a kinds manifest alone gains no workflows and no finding of its own.
    const kinds = mkdtempSync(join(tmpdir(), 'madarch-workflows-none-kinds-'));
    made.push(kinds);
    for (const file of STARTER_FILES.filter((one) => one.path !== WORKFLOWS_FILE)) {
      const path = join(kinds, file.path);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, file.content);
    }
    const read = readKinds(kinds);
    if (!read.present) throw new Error('the product holds no kinds manifest');
    expect(read.manifest.workflows).toBeUndefined();
    expect(read.manifest.findings).toEqual([]);
  }, 30_000);
});

describe('the refusals of the workflow check', () => {
  
  test('the unknown stage ids of one workflow are refused in code point order, whatever order the file names them', () => {
    const read = readText('workflows:\n  first-fill:\n    status: implemented\n    stages:\n      - zebra\n      - alpha\n');
    expect(read.findings.map((finding) => finding.message.split(':')[0])).toEqual([
      'workflow "first-fill" stage "alpha"',
      'workflow "first-fill" stage "zebra"',
    ]);
    expect(read.workflows.size).toBe(0);
  });

  
  
  
  test('a stage no stage of this madarch produces is refused by the derivation\'s no-producer path', () => {
    const registry = new StageRegistry().register(stage('wants', ['unicorn'], []));
    const read = parseWorkflows('workflows:\n  first-fill:\n    status: implemented\n    stages: [wants]\n', FILE, registry);
    expect(read.findings.map((finding) => finding.message)).toEqual([
      'workflow "first-fill" stage "wants": wants → unicorn → no producer: no stage of this madarch produces the input "unicorn"',
    ]);
  });

  test('a cycle of the workflow\'s stages is refused by its own path, and the workflow stands out', () => {
    const registry = new StageRegistry().register(stage('one', ['two-out'], ['one-out'])).register(stage('two', ['one-out'], ['two-out']));
    const read = parseWorkflows('workflows:\n  first-fill:\n    status: implemented\n    stages: [one, two]\n', FILE, registry);
    expect(read.findings.map((finding) => finding.message)).toEqual(['workflow "first-fill": one → two → one: the workflow\'s stages order themselves in a cycle']);
    expect(read.workflows.size).toBe(0);
  });

  
  
  
  test('an implemented workflow that names no stages is refused, whether it leaves them out or names none', () => {
    expect(refusals('workflows:\n  first-fill:\n    status: implemented\n')).toEqual([[2, 'workflow "first-fill": "stages" names the stage ids the workflow runs, and an implemented workflow names at least one']]);
    expect(refusals('workflows:\n  first-fill:\n    status: implemented\n    stages: []\n')).toEqual([[4, 'workflow "first-fill": an implemented workflow names the stage ids it runs, and this one names none']]);
    expect(readText('workflows:\n  first-fill:\n    status: implemented\n    stages: []\n').workflows.size).toBe(0);
    expect(readText('workflows:\n  first-fill:\n    status: planned\n    stages: []\n').findings).toEqual([]);
  });

  test('a workflow field that is not status or stages is refused at its line', () => {
    expect(refusals('workflows:\n  first-fill:\n    status: planned\n    edges: [snapshot -> syntax]\n')).toEqual([[4, 'workflow "first-fill": "edges" is not a field of a workflow: the fields are status and stages']]);
  });

  test('a file that is no mapping, a workflows section that is no mapping, and a declaration that is no mapping are refused', () => {
    for (const text of ['null\n', '42\n', '[]\n', '- workflows\n']) {
      expect(refusals(text)).toEqual([[1, 'the manifest is a mapping with a "workflows" mapping in it']]);
    }
    for (const text of ['workflows: null\n', 'workflows: 3\n', 'workflows: []\n']) {
      expect(refusals(text)).toEqual([[1, '"workflows" maps each workflow\'s name to { status, stages }: a workflow is a named set of the engine\'s stage ids, and the capabilities give the order']]);
    }
    // A workflows section that is no mapping is refused at its own line, not the file's first.
    expect(refusals('# the product workflows\nworkflows: null\n')).toEqual([[2, '"workflows" maps each workflow\'s name to { status, stages }: a workflow is a named set of the engine\'s stage ids, and the capabilities give the order']]);
    expect(refusals('workflows:\n  first-fill: null\n')).toEqual([[2, 'workflow "first-fill": the declaration is { status, stages }']]);
    expect(refusals('workflows:\n  first-fill: "x"\n  update-by-commit: [snapshot]\n')).toEqual([
      [2, 'workflow "first-fill": the declaration is { status, stages }'],
      [3, 'workflow "update-by-commit": the declaration is { status, stages }'],
    ]);
  });

  test('a workflow name that is no workflow name, a status that is no string and a stages value that is no list are refused at their lines', () => {
    expect(refusals('workflows:\n  "2 fast":\n    status: planned\n')).toEqual([[2, 'the workflow name "2 fast" is not a workflow name: it starts with a letter and carries letters, digits, ".", "_" or "-"']]);
    expect(refusals('workflows:\n  first-fill:\n    status: 42\n')).toEqual([[3, 'workflow "first-fill": "status" is one of implemented, planned, got 42']]);
    expect(refusals('workflows:\n  first-fill:\n    status: planned\n    stages: null\n')).toEqual([[4, 'workflow "first-fill": "stages" is a list of the engine\'s stage ids']]);
    // A value YAML reads as something other than a string is refused even where it would spell a stage id.
    expect(refusals('workflows:\n  first-fill:\n    status: implemented\n    stages: [true]\n')).toEqual([[4, 'workflow "first-fill": the stage true is not a stage id: a stage id starts with a letter and carries letters, digits, ".", "_" or "-"']]);
  });

  test('a field of the manifest that is not workflows, and a manifest that is no YAML, are refused at their own line', () => {
    expect(refusals('workflows: {}\nstages: []\n')).toEqual([[2, '"stages" is not a field of the manifest: the manifest holds "workflows"']]);
    expect(refusals('workflows: [unclosed\n')).toEqual([[2, 'Flow sequence in block collection must be sufficiently indented and end with a ] at line 2, column 1:']]);
    // A workflow declared twice is a YAML error of the file's own, not a second reading of one name.
    const twice = readText('workflows:\n  first-fill:\n    status: planned\n  first-fill:\n    status: planned\n');
    expect(twice.findings.map((finding) => [finding.line, finding.message.startsWith('Map keys must be unique')])).toEqual([[4, true]]);
    expect(twice.workflows.size).toBe(0);
  });

  test('a workflows path that is a directory is no workflows manifest, and the product still has no workflows', () => {
    const folder = mkdtempSync(join(tmpdir(), 'madarch-workflows-unreadable-'));
    made.push(folder);
    mkdirSync(join(folder, WORKFLOWS_FILE), { recursive: true });
    const read = readWorkflowsFrom(workingTreeFiles(folder), folder);
    // A directory where the file stands is no file of the product: the product holds no workflows manifest, and no
    // finding says otherwise (there is nothing to read, not a file that failed to read).
    expect(read.present).toBe(false);
    expect(read.workflows.size).toBe(0);
    expect(read.findings).toEqual([]);
  });
});

describe('the product-wiki check reads the workflows with the manifest', () => {
  
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
