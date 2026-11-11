/** Working-tree manifest changes publish a new validated catalogue, never a fill. */
import { watch, type FSWatcher } from 'node:fs';
import { KINDS_FILE } from '../knowledge/kinds.js';
import { WORKFLOWS_FILE } from '../knowledge/workflows.js';
import { validateProductManifests, type ValidatedManifests } from '../graph/manifest-publication.js';

/** Invalid edits leave the previous graph transaction untouched. Each product serializes its publications. */
export function createManifestWatch(folders: readonly string[], publish: (value: ValidatedManifests) => Promise<void>, report: (line: string) => void): { stop(): void; refresh(folder: string): Promise<void> } {
  const watchers: FSWatcher[] = [];
  const pending = new Map<string, Promise<void>>();
  let stopped = false;
  const refresh = async (folder: string): Promise<void> => {
    const previous = pending.get(folder) ?? Promise.resolve();
    const work = previous.then(async () => {
      if (stopped) return;
      const read = validateProductManifests(folder);
      if (!read.ok) {
        for (const finding of read.findings) report(`${finding.file}:${finding.line}: ${finding.message}`);
        return;
      }
      await publish(read.value);
    }).catch((error: unknown) => report(`${folder}:1: the manifest catalogue could not be published: ${String(error)}`));
    pending.set(folder, work);
    await work;
    if (pending.get(folder) === work) pending.delete(folder);
  };
  try {
    for (const folder of folders) {
      const watcher = watch(folder, { recursive: true, persistent: false }, (event, filename) => {
        const path = filename?.toString().replaceAll('\\', '/');
        if (event === 'rename' || path === KINDS_FILE || path === WORKFLOWS_FILE || path === 'madarch/plugins.lock' || path?.endsWith('/plugin.json') || path?.endsWith('/contract.json')) void refresh(folder);
      });
      watcher.on('error', (error) => report(`${folder}:1: the manifest watcher failed: ${error.message}`));
      watchers.push(watcher);
    }
  } catch (error) {
    for (const watcher of watchers) watcher.close();
    throw error;
  }
  return { refresh, stop: () => { stopped = true; for (const watcher of watchers) watcher.close(); } };
}
