/**
 * Where graph verdicts live (madarch-mwhd.1): the current node and edge
 * versions of a filled product, read from the temporal graph, and the JSON
 * cache beside the product's store. Nothing is written into the graph itself.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { GraphReader } from './graph-read.js';
import {
  DEFAULT_GRAPH_VERDICT_BUDGETS,
  GRAPH_VERDICT_VALIDATOR_VERSION,
  type GraphEdgeItem,
  type GraphNodeItem,
  type GraphSnapshot,
  type GraphVerdictBudgets,
  type GraphVerdictCache,
} from './graph-verdicts.js';


export interface GraphVerdictState {
  readonly cache?: GraphVerdictCache;
  readonly budgets: GraphVerdictBudgets;
}

export const graphVerdictFile = (storeFolder: string): string => join(storeFolder, 'graph-verdicts.json');

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);


/** Reads every entity and relation the one graph holds, presented as the wiki's code kinds. */
export async function loadGraphSnapshot(reader: GraphReader): Promise<GraphSnapshot> {
  const nodes: GraphNodeItem[] = [];
  for (const kind of ['code.repository', 'code.directory', 'code.file', 'code.commit', 'code.author']) {
    const page = await reader.list(kind, { limit: Number.MAX_SAFE_INTEGER });
    for (const entity of page.rows) {
      nodes.push({ id: entity.key, versionId: entity.nodeIds[0] ?? entity.key, kind: entity.kind, label: entity.label, properties: entity.properties });
    }
  }
  const edges: GraphEdgeItem[] = [];
  for (const relation of ['code.contains', 'code.touched', 'code.authored', 'code.parent', 'code.renamed-from']) {
    const page = await reader.relationEdges(relation, Number.MAX_SAFE_INTEGER);
    for (const edge of page.rows) {
      edges.push({
        id: `${relation}\u0000${edge.from.key}\u0000${edge.to.key}\u0000${edge.discriminator ?? ''}`,
        versionId: `${relation}\u0000${edge.from.key}\u0000${edge.to.key}`,
        kind: relation,
        from: edge.from.key,
        to: edge.to.key,
        ...(edge.discriminator === undefined || edge.discriminator === '' ? {} : { discriminator: edge.discriminator }),
        properties: edge.properties,
      });
    }
  }
  return { nodes, edges };
}

const budgetsOf = (value: unknown, file: string): GraphVerdictBudgets => {
  if (!isObject(value)) throw new Error(`${file}:1: budgets is not an object with itemsPerRun and modelCallsPerRun; full path ${file}`);
  const itemsPerRun = value.itemsPerRun;
  const modelCallsPerRun = value.modelCallsPerRun;
  if (typeof itemsPerRun !== 'number' || !Number.isInteger(itemsPerRun) || itemsPerRun < 0) throw new Error(`${file}:1: budgets.itemsPerRun is ${JSON.stringify(itemsPerRun)}; it is a whole number, 0 or more; full path ${file}`);
  if (typeof modelCallsPerRun !== 'number' || !Number.isInteger(modelCallsPerRun) || modelCallsPerRun < 0) throw new Error(`${file}:1: budgets.modelCallsPerRun is ${JSON.stringify(modelCallsPerRun)}; it is a whole number, 0 or more; full path ${file}`);
  return { itemsPerRun, modelCallsPerRun };
};

/** Reads the cache and budgets; a missing file is the starter budgets and no cache. */
export function readGraphVerdictState(file: string): GraphVerdictState {
  if (!existsSync(file)) return { budgets: DEFAULT_GRAPH_VERDICT_BUDGETS };
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    throw new Error(`${file}:1: the graph verdicts cannot be read: ${(error as Error).message}; full path ${file}`);
  }
  let body: unknown;
  try {
    body = JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(`${file}:1: the graph verdicts are not JSON: ${(error as Error).message}; full path ${file}`);
  }
  if (!isObject(body)) throw new Error(`${file}:1: the graph verdicts are not an object; full path ${file}`);
  const budgets = budgetsOf(body.budgets, file);
  if (body.validatorVersion === undefined && body.entries === undefined) return { budgets };
  if (typeof body.validatorVersion !== 'string') throw new Error(`${file}:1: validatorVersion is not a string; full path ${file}`);
  if (typeof body.generatedAt !== 'string') throw new Error(`${file}:1: generatedAt is not a string; full path ${file}`);
  if (typeof body.fingerprint !== 'string') throw new Error(`${file}:1: fingerprint is not a string; full path ${file}`);
  if (!isObject(body.entries)) throw new Error(`${file}:1: entries is not an object; full path ${file}`);
  return { budgets, cache: { validatorVersion: body.validatorVersion, generatedAt: body.generatedAt, fingerprint: body.fingerprint, budgets, entries: body.entries as GraphVerdictCache['entries'] } };
}

const writeAtomically = (file: string, text: string): void => {
  mkdirSync(dirname(file), { recursive: true });
  const temporary = join(dirname(file), `.${basename(file)}.${process.pid}.${Date.now()}.tmp`);
  writeFileSync(temporary, text, 'utf8');
  renameSync(temporary, file);
};

export function writeGraphVerdictState(file: string, cache: GraphVerdictCache): void {
  writeAtomically(file, `${JSON.stringify(cache)}\n`);
}

/** Changes the budgets without throwing away the verdicts already held; the next run decides whether it must judge again. */
export function writeGraphVerdictBudgets(file: string, budgets: GraphVerdictBudgets): void {
  const state = readGraphVerdictState(file);
  if (state.cache === undefined) {
    writeGraphVerdictState(file, {
      validatorVersion: GRAPH_VERDICT_VALIDATOR_VERSION,
      generatedAt: new Date().toISOString(),
      fingerprint: '',
      budgets,
      entries: {},
    });
    return;
  }
  writeGraphVerdictState(file, { ...state.cache, budgets, fingerprint: '' });
}
