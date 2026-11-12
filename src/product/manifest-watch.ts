/** Working-tree manifest changes publish a new validated catalogue, never a fill. */
import { watch, type FSWatcher } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { listProducts } from './list.js';
import { KINDS_FILE, KINDS_FOLDER } from '../product/manifest/kinds.js';
import { WORKFLOWS_FILE } from '../product/manifest/workflows.js';
import { validateProductManifests, type ValidatedManifests } from '../graph/manifest-publication.js';

/** Invalid edits leave the previous graph transaction untouched. Each product serializes its publications. */
export function createManifestWatch(folders: readonly string[], publish: (value: ValidatedManifests) => Promise<void>, report: (line: string) => void, home?: string): { stop(): void; refresh(folder: string): Promise<void> } {
  const watchers = new Map<string, FSWatcher>();
  let homeWatcher: FSWatcher | undefined;
  const pending = new Map<string, Promise<void>>();
  const templatePaths = new Map(folders.map((folder) => {
    const read = validateProductManifests(folder);
    return [folder, new Set(read.ok ? read.value?.templatePaths ?? [] : read.templatePaths)] as const;
  }));
  let stopped = false;
  const refresh = async (folder: string): Promise<void> => {
    const previous = pending.get(folder) ?? Promise.resolve();
    const work = previous.then(async () => {
      if (stopped || (home !== undefined && !watchers.has(folder))) return;
      const read = validateProductManifests(folder);
      if (!read.ok) {
        templatePaths.set(folder, new Set([...(templatePaths.get(folder) ?? []), ...read.templatePaths]));
        for (const finding of read.findings) report(`${finding.file}:${finding.line}: ${finding.message}`);
        return;
      }
      if (read.value !== undefined) {
        await publish(read.value);
        templatePaths.set(folder, new Set(read.value.templatePaths));
      }
    }).catch((error: unknown) => report(`${folder}:1: the manifest catalogue could not be published: ${String(error)}`));
    pending.set(folder, work);
    await work;
    if (pending.get(folder) === work) pending.delete(folder);
  };
  const watchFolder = (folder: string): void => {
    const watcher = watch(folder, { recursive: true, persistent: false }, (event, filename) => {
      const path = filename?.toString().replaceAll('\\', '/');
      if (event === 'rename' || path === KINDS_FILE || path === 'madarch/kinds.yaml' || path?.startsWith(`${KINDS_FOLDER}/`) === true || path === WORKFLOWS_FILE || path === 'madarch/plugins.lock' || path?.endsWith('/plugin.json') || path?.endsWith('/contract.json') || (path !== undefined && templatePaths.get(folder)?.has(path))) void refresh(folder);
    });
    watcher.on('error', (error) => report(`${folder}:1: the manifest watcher failed: ${error.message}`));
    watchers.set(folder, watcher);
  };
  const reconcile = (): void => {
    if (stopped || home === undefined) return;
    const listed = listProducts({ home });
    if (listed.outcome !== 'listed') { report(`${resolve(home)}:1: ${listed.message}`); return; }
    for (const finding of listed.unreadable) report(`${finding.file}:${finding.line}: ${finding.message}`);
    const wanted = new Set([...listed.products, ...listed.unreadable].map((product) => product.folder));
    // An installed own wiki outside the products home is still watched.
    for (const folder of folders) if (dirname(folder) !== resolve(home)) wanted.add(folder);
    for (const [folder, watcher] of watchers) {
      if (wanted.has(folder)) continue;
      watcher.close();
      watchers.delete(folder);
      templatePaths.delete(folder);
    }
    for (const folder of wanted) {
      if (watchers.has(folder)) continue;
      try { watchFolder(folder); void refresh(folder); }
      catch (error) { report(`${folder}:1: the manifest watcher could not start: ${String(error)}`); }
    }
  };
  try {
    if (home === undefined) {
      for (const folder of folders) watchFolder(folder);
    } else {
      homeWatcher = watch(home, { persistent: false }, () => reconcile());
      homeWatcher.on('error', (error) => report(`${resolve(home)}:1: the products home watcher failed: ${error.message}`));
      reconcile();
    }
  } catch (error) {
    homeWatcher?.close();
    for (const watcher of watchers.values()) watcher.close();
    throw error;
  }
  return { refresh, stop: () => { stopped = true; homeWatcher?.close(); for (const watcher of watchers.values()) watcher.close(); } };
}
