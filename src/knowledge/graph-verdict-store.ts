/**
 * Where graph verdicts live (madarch-mwhd.1): the current node and edge
 * versions of a filled product, read from the temporal graph, and the JSON
 * cache beside the product's store. Nothing is written into the graph itself.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { DatabaseOwner } from '../adapters/database-owner.js';
import {
  DEFAULT_GRAPH_VERDICT_BUDGETS,
  GRAPH_VERDICT_VALIDATOR_VERSION,
  type GraphEdgeItem,
  type GraphNodeItem,
  type GraphSnapshot,
  type GraphVerdictBudgets,
  type GraphVerdictCache,
} from './graph-verdicts.js';

type Raw = Record<string, unknown>;

export interface GraphVerdictState {
  readonly cache?: GraphVerdictCache;
  readonly budgets: GraphVerdictBudgets;
}

export const graphVerdictFile = (storeFolder: string): string => join(storeFolder, 'graph-verdicts.json');

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const parseProperties = (value: unknown): unknown => {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
};

/** Reads every current node and edge version, at `infinity` on both axes. */
export async function loadGraphSnapshot(owner: DatabaseOwner): Promise<GraphSnapshot> {
  const read = await owner.run(async (tx) => {
    const nodes = await tx.query<Raw>(
      `SELECT DISTINCT ON (v.node_id) v.id::text AS version_id, v.node_id::text AS node_id,
              k.key AS kind, v.label, v.properties
       FROM node_version v JOIN node_kind k ON k.id = v.kind_id
       WHERE v.recorded_to = 'infinity' AND v.valid_to = 'infinity'
       ORDER BY v.node_id, v.id DESC`,
    );
    const edges = await tx.query<Raw>(
      `SELECT DISTINCT ON (e.edge_id) e.id::text AS version_id, e.edge_id::text AS edge_id,
              r.key AS relation, e.src_id::text AS src, e.dst_id::text AS dst,
              e.discriminator, e.byte_start, e.byte_end, e.properties
       FROM edge_version e JOIN relation_type r ON r.id = e.relation_type_id
       WHERE e.recorded_to = 'infinity' AND e.valid_to = 'infinity'
       ORDER BY e.edge_id, e.id DESC`,
    );
    return { nodes: nodes.rows, edges: edges.rows };
  });
  const held: GraphNodeItem[] = read.nodes.map((row) => ({
    id: row['node_id'] as string,
    versionId: row['version_id'] as string,
    kind: row['kind'] as string,
    label: row['label'] as string,
    properties: parseProperties(row['properties']),
  }));
  const edges: GraphEdgeItem[] = read.edges.map((row) => ({
    id: row['edge_id'] as string,
    versionId: row['version_id'] as string,
    kind: row['relation'] as string,
    from: row['src'] as string,
    to: row['dst'] as string,
    ...(typeof row['discriminator'] === 'string' && row['discriminator'] !== '' ? { discriminator: row['discriminator'] } : {}),
    ...(row['byte_start'] === null || row['byte_end'] === null ? {} : { position: { start: Number(row['byte_start']), end: Number(row['byte_end']) } }),
    properties: parseProperties(row['properties']),
  }));
  return { nodes: held, edges };
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
