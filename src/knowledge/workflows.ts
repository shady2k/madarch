/**
 * The product's workflows (decision 0033, items 1 and 2): `madarch/workflows.yaml`
 * in the product repository declares the workflows the product runs. A workflow
 * is a named set of the engine's stage ids; the stages' capabilities give the
 * order, so no edge is declared in the file, and the engine holds no workflow of
 * its own beyond the starter set `madarch new` writes.
 *
 * The check is the derivation a run makes (`deriveStageGraphOver`), read over the
 * workflow's own stages: a stage id the registry does not hold is refused by id,
 * and a stage whose required input no stage of the workflow produces is refused
 * by the derivation's own path — `modules → symbol → syntax (disabled)` — naming
 * the file, the line, the workflow and the stage. A cycle of the workflow's
 * stages is refused by its own path too. A workflow's status says what the engine
 * can do with it today: an implemented one names stages whose every required
 * input the workflow produces, and a planned one says the engine has no stage
 * for it yet, so it may name no stages; the stages it does name are checked as
 * an implemented workflow's are, since decision 0033, item 2 exempts neither.
 *
 * ```yaml
 * workflows:
 *   first-fill:
 *     status: implemented
 *     stages: [snapshot, inventory, syntax, modules]
 *   branch-worktree:
 *     status: planned
 *     stages: []
 * ```
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LineCounter, parseDocument } from 'yaml';
import { byCodePoint } from '../model/order.js';
import { lineForPath } from '../model/yaml-position.js';
import { deriveStageGraphOver, type StageRegistry } from '../fill/registry.js';
import { STAGE_ID_PATTERN } from '../fill/stage.js';
import { createEngineStageRegistry } from '../fill/stages/index.js';
import { STARTER_WORKFLOWS } from './starter-workflows.js';

/** The manifest's place in the product repository. */
export const WORKFLOWS_FILE = 'madarch/workflows.yaml';

/** The workflow a fill runs: the starter set declares `first-fill` implemented, and every product is written with it. */
const FIRST_FILL_WORKFLOW = 'first-fill';

/** The statuses a workflow declares: `implemented` runs today, `planned` has no engine stage yet. */
const WORKFLOW_STATUSES = ['implemented', 'planned'] as const;

/** One workflow's status, one of `WORKFLOW_STATUSES`. */
export type WorkflowStatus = (typeof WORKFLOW_STATUSES)[number];

/** One problem the workflows reader finds: the file, the line, and the words a person reads. */
export interface WorkflowFinding {
  file: string;
  line: number;
  message: string;
}

/** One workflow as the file reads it. */
export interface WorkflowEntry {
  /** The workflow's name, the file's own key. */
  readonly name: string;
  readonly status: WorkflowStatus;
  /** The registry stage ids the workflow names, in the order the file writes them. */
  readonly stages: readonly string[];
  /** The 1-based line of the workflow's declaration. */
  readonly line: number;
  /** The 1-based line each named stage stands on, by stage id, so a fault of it names its own line. */
  readonly stageLines: ReadonlyMap<string, number>;
}

/** What reading the product's workflows manifest gives. */
export interface WorkflowsRead {
  /** The manifest's full path, named by every finding. */
  readonly file: string;
  /** Whether the product holds the file; a product without one has no workflows and no finding of its own. */
  readonly present: boolean;
  /** The workflows the file reads, in code point order of their names; a refused workflow is left out and the rest stand. */
  readonly workflows: ReadonlyMap<string, WorkflowEntry>;
  readonly findings: readonly WorkflowFinding[];
}

/** The engine's stage registry, built once: stage declarations are pure data, so a read never drives a stage. */
let engineStages: StageRegistry | undefined;
function engineStageRegistry(): StageRegistry {
  return (engineStages ??= createEngineStageRegistry());
}

/** Reads `madarch/workflows.yaml` of a product folder; absent when the product holds none. */
export function readWorkflows(productFolder: string, registry: StageRegistry = engineStageRegistry()): WorkflowsRead {
  const file = join(productFolder, WORKFLOWS_FILE);
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') return { file, present: false, workflows: new Map(), findings: [] };
    return { file, present: true, workflows: new Map(), findings: [{ file, line: 1, message: `the file cannot be read: ${(error as Error).message}` }] };
  }
  return { ...parseWorkflows(text, file, registry), present: true };
}

/**
 * Parses the workflows manifest's text and checks every workflow against the
 * engine's stage registry: the ids it names, the inputs of its stages, and
 * whether its stages order themselves in a cycle.
 */
export function parseWorkflows(text: string, file: string, registry: StageRegistry = engineStageRegistry()): Omit<WorkflowsRead, 'present'> {
  const findings: WorkflowFinding[] = [];
  const lines = new LineCounter();
  const doc = parseDocument(text, { lineCounter: lines, uniqueKeys: true });
  const at = (path: (string | number)[]): number => lineForPath(doc, lines, path);
  for (const problem of doc.errors) findings.push({ file, line: problem.linePos?.[0].line ?? 1, message: problem.message.split('\n')[0] ?? problem.message });
  if (doc.errors.length > 0) return { file, workflows: new Map(), findings };
  const root: unknown = doc.toJS();
  if (root === null || typeof root !== 'object' || Array.isArray(root)) {
    findings.push({ file, line: 1, message: 'the manifest is a mapping with a "workflows" mapping in it' });
    return { file, workflows: new Map(), findings };
  }
  const top = root as Record<string, unknown>;
  for (const key of Object.keys(top)) {
    if (key !== 'workflows') findings.push({ file, line: at([key]), message: `"${key}" is not a field of the manifest: the manifest holds "workflows"` });
  }
  const declared = top['workflows'];
  if (declared === null || typeof declared !== 'object' || Array.isArray(declared)) {
    findings.push({ file, line: at(['workflows']), message: `"workflows" maps each workflow's name to { status, stages }: a workflow is a named set of the engine's stage ids, and the capabilities give the order` });
    return { file, workflows: new Map(), findings };
  }
  // The registry's ids, read once: every message that names them says the same list, in code point order.
  const held = registry.all().map((stage) => stage.id);
  const workflows = new Map<string, WorkflowEntry>();
  for (const [name, value] of Object.entries(declared as Record<string, unknown>)) {
    const line = at(['workflows', name]);
    if (!STAGE_ID_PATTERN.test(name)) {
      findings.push({ file, line, message: `the workflow name ${JSON.stringify(name)} is not a workflow name: it starts with a letter and carries letters, digits, ".", "_" or "-"` });
      continue;
    }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      findings.push({ file, line, message: `workflow "${name}": the declaration is { status, stages }` });
      continue;
    }
    const decl = value as Record<string, unknown>;
    let sound = true;
    const fail = (path: (string | number)[], message: string): void => {
      sound = false;
      // A field that is absent has no line of its own: the fault stands at the workflow.
      const written = path.length === 0 || String(path[0]) in decl;
      findings.push({ file, line: written ? at(['workflows', name, ...path]) : line, message: `workflow "${name}": ${message}` });
    };
    for (const key of Object.keys(decl)) {
      if (key !== 'status' && key !== 'stages') fail([key], `"${key}" is not a field of a workflow: the fields are status and stages`);
    }
    const status = decl['status'];
    if (typeof status !== 'string' || !(WORKFLOW_STATUSES as readonly string[]).includes(status)) {
      fail(['status'], `"status" is one of ${WORKFLOW_STATUSES.join(', ')}, got ${JSON.stringify(status)}`);
    }
    const stages: string[] = [];
    const stageLines = new Map<string, number>();
    const rawStages = decl['stages'];
    if (rawStages === undefined) {
      if (status === 'implemented') fail([], '"stages" names the stage ids the workflow runs, and an implemented workflow names at least one');
    } else if (!Array.isArray(rawStages)) {
      fail(['stages'], `"stages" is a list of the engine's stage ids`);
    } else {
      rawStages.forEach((written, index) => {
        if (typeof written !== 'string' || !STAGE_ID_PATTERN.test(written)) {
          fail(['stages', index], `the stage ${JSON.stringify(written)} is not a stage id: a stage id starts with a letter and carries letters, digits, ".", "_" or "-"`);
          return;
        }
        if (stageLines.has(written)) {
          fail(['stages', index], `the stage "${written}" is named twice: a workflow's stages are a set`);
          return;
        }
        stageLines.set(written, at(['workflows', name, 'stages', index]));
        stages.push(written);
      });
      if (status === 'implemented' && rawStages.length === 0) fail(['stages'], 'an implemented workflow names the stage ids it runs, and this one names none');
    }
    // A stage the registry does not hold is refused by its own id, before the derivation reads the set: the derivation
    // judges the stages the registry holds, and an id no stage stands behind is not one of them.
    for (const id of [...stageLines.keys()].sort(byCodePoint)) {
      if (held.includes(id)) continue;
      sound = false;
      findings.push({
        file,
        line: stageLines.get(id)!,
        message: `workflow "${name}" stage "${id}": the engine's stage registry holds no stage "${id}" (its stages are ${held.join(', ')})`,
      });
    }
    // A workflow's stages must feed each other, whatever its status says: decision 0033, item 2 refuses a workflow that
    // names a missing stage or leaves a stage's input without a producer, and it exempts no planned workflow. The
    // derivation the run makes says which consumer starves and by which path, and a cycle says the stages cannot be
    // ordered at all.
    if (sound) {
      const graph = deriveStageGraphOver(registry, stages);
      if (!graph.ok) {
        for (const cycle of graph.cycles) {
          sound = false;
          findings.push({ file, line, message: `workflow "${name}": ${cycle.join(' → ')}: the workflow's stages order themselves in a cycle` });
        }
        for (const starved of graph.starvation) {
          sound = false;
          const why = starved.reason === 'no-producer'
            ? `no stage of this madarch produces the input "${starved.capability}"`
            : `the workflow names no stage that produces the input "${starved.capability}"`;
          findings.push({
            file,
            line: stageLines.get(starved.consumer) ?? line,
            message: `workflow "${name}" stage "${starved.consumer}": ${starved.path}: ${why}`,
          });
        }
      }
    }
    if (!sound) continue;
    workflows.set(name, {
      name,
      status: status as WorkflowStatus,
      stages,
      line,
      stageLines,
    });
  }
  return { file, workflows: new Map([...workflows].sort(([left], [right]) => byCodePoint(left, right))), findings };
}


// ---- the workflow a run enables its stages from ---------------------------

/** The engine's starter set, as the file a refusal names for a repository that is no product. */
const ENGINE_STARTER_SET = "the engine's starter set (src/knowledge/starter-workflows.ts)";

/** What a run's stage set read gives: the stages its workflow names, or the refusal named where it stands. */
export type FirstFillRead =
  | { readonly ok: true; readonly file: string; readonly line: number; readonly stages: readonly string[] }
  | { readonly ok: false; readonly refusal: WorkflowFinding };

/**
 * The stages a fill of one product runs (decision 0033, items 1 and 2): the
 * stages the product's `madarch/workflows.yaml` names for its `first-fill`
 * workflow, or the refusal named at the file and line that makes a run
 * unreadable. A product that holds no manifest, a manifest the reader refuses,
 * a manifest without `first-fill`, and one whose `first-fill` is `planned` are
 * each a refusal here: a run never guesses the stages a product runs.
 *
 * The stages a run *holds* are the wiring's: a registry built for a run without
 * an agent holds no agent stage, so a named stage the registry does not hold is
 * not enabled by that run.
 */
export function firstFillStagesOf(folder: string, registry: StageRegistry = engineStageRegistry()): FirstFillRead {
  const read = readWorkflows(folder, registry);
  if (!read.present) {
    return { ok: false, refusal: { file: read.file, line: 1, message: `the product holds no workflows manifest, and its fill reads the stages its \`${FIRST_FILL_WORKFLOW}\` workflow names: write ${WORKFLOWS_FILE} (\`madarch new\` writes the starter set, which names the engine's stages)` } };
  }
  const first = read.findings[0];
  if (first !== undefined) return { ok: false, refusal: first };
  const workflow = read.workflows.get(FIRST_FILL_WORKFLOW);
  if (workflow === undefined) {
    const held = [...read.workflows.keys()];
    return { ok: false, refusal: { file: read.file, line: 1, message: `the manifest holds no "${FIRST_FILL_WORKFLOW}" workflow, and a fill runs the stages that workflow names: it holds ${held.length === 0 ? 'none' : held.map((name) => JSON.stringify(name)).join(', ')}` } };
  }
  if (workflow.status !== 'implemented') {
    return { ok: false, refusal: { file: read.file, line: workflow.line, message: `the workflow "${FIRST_FILL_WORKFLOW}" stands ${JSON.stringify(workflow.status)}, and a fill runs an implemented workflow: its status says what this engine can do with it today` } };
  }
  return { ok: true, file: read.file, line: workflow.line, stages: workflow.stages };
}

/**
 * The stages the engine's own `first-fill` workflow names, for a repository that
 * is no product and so holds no manifest: the starter set `madarch new` writes
 * into a product is the engine's declared workflow, and a repository served
 * without one runs it. The list is the declared workflow's, never a second list
 * written here; the check of decision 0033, item 2 (`scripts/check-workflows.ts`)
 * holds it to the stages the engine's registry declares.
 */
export function engineFirstFillStages(): FirstFillRead {
  const workflow = STARTER_WORKFLOWS.find((candidate) => candidate.name === FIRST_FILL_WORKFLOW);
  if (workflow === undefined) {
    return { ok: false, refusal: { file: ENGINE_STARTER_SET, line: 1, message: `the engine's starter set holds no "${FIRST_FILL_WORKFLOW}" workflow, and a fill runs the stages that workflow names` } };
  }
  return { ok: true, file: ENGINE_STARTER_SET, line: 1, stages: workflow.stages };
}
