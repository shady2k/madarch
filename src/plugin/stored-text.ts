/** Raw stored text transport for source display. No product semantics are inferred here. */
import type { GraphReader } from '../knowledge/graph-read.js';
import { storedFileTexts } from '../graph/records.js';

/** The text of many files at once, by path: the listing's titles read in one statement. */
export async function contentsOf(reader: GraphReader, repository: string, paths: readonly string[]): Promise<Map<string, string | null>> {
  return await storedFileTexts(reader.storeOwner(), repository, paths);
}
