/** Raw stored text transport for the plugin host and source display. No product semantics are inferred here. */
import type { GraphAnswerer } from './host.js';
import type { GraphReader } from '../knowledge/graph-read.js';
import { storedFileText, storedFileTexts } from '../graph/records.js';
import { GIT_WIKI } from '../fill/stages/git-contract.js';


  /** The text of many files at once, by path: the listing's titles read in one statement, never one per file. */
export async function contentsOf(reader: GraphReader, repository: string, paths: readonly string[]): Promise<Map<string, string | null>> {
    return await storedFileTexts(reader.storeOwner(), repository, paths);
  }

/** Installs the host handler for a plugin's declared graph value requests. */
export function storedFileValueAnswerer(owner: Parameters<typeof storedFileText>[0]): GraphAnswerer['value'] {
  return async (kind, key, field) => {
    if (kind !== GIT_WIKI.file) throw new Error(`the graph read of a ${JSON.stringify(kind)} is not one the host answers: a plugin reads the files producer's vertices (${GIT_WIKI.file})`);
    const repository = String(key['repository'] ?? '');
    const path = String(key['path'] ?? '');
    if (field !== 'content') throw new Error(`the field ${JSON.stringify(field)} is not one a plugin reads of a file: the files producer stores its content`);
    return await storedFileText(owner, repository, path);
  };
}

