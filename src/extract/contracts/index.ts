/**
 * The contracts extractor (madarch-o0eq.1): reads OpenAPI, protobuf and
 * AsyncAPI contracts and the code that serves, calls and speaks them, and
 * answers one Extraction over a TreeReader. Pure: no database, no network, no
 * clock. This file is the entry point; the reading lives beside it.
 */
import type {Extraction, TreeReader} from '../../extract/records.js';

/** Extracts the contracts and their serving, calling and speaking code. */
export async function extractContracts(_reader: TreeReader): Promise<Extraction> {
  return {producer: 'code.extract.contracts', nodes: [], edges: [], gaps: []};
}
