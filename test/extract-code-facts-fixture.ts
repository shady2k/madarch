/** Explicit test fixture owner: one immutable code extraction per held tree. */
import { extractCodeWithFacts } from '../src/extract/code/index.js';
import type { CodeExtractionResult } from '../src/extract/code/facts.js';
import { extractOperations as operations } from '../src/extract/operations/index.js';
import { extractContracts as contracts } from '../src/extract/contracts/index.js';
import type { Extraction, TreeReader } from '../src/extract/records.js';

const reads = new WeakMap<TreeReader, Promise<CodeExtractionResult>>();
function read(tree: TreeReader): Promise<CodeExtractionResult> {
  let result = reads.get(tree);
  if (result === undefined) { result = extractCodeWithFacts(tree); reads.set(tree, result); }
  return result;
}
export async function extractCode(tree: TreeReader): Promise<Extraction> {
  return (await read(tree)).extraction;
}
export async function extractOperations(tree: TreeReader, suppliedCode?: Extraction): Promise<Extraction> {
  const result = await read(tree);
  if (suppliedCode !== undefined && suppliedCode !== result.extraction) throw new Error('fixture must share one code extraction for its tree');
  return operations(tree, result.extraction, result.facts);
}

export async function extractContracts(tree: TreeReader, suppliedCode?: Extraction): Promise<Extraction> {
  const result = await read(tree);
  if (suppliedCode !== undefined && suppliedCode !== result.extraction) throw new Error('fixture must share one code extraction for its tree');
  return contracts(tree, result.extraction, result.facts);
}
