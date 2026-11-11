/** Validate the plugin declarations and lock from source files at the manifest boundary. */
import { join } from 'node:path';
import type { ProductFileRead } from './product-files.js';
import type { Finding, KindsManifest } from '../product/manifest/kinds.js';
import { parsePluginLock, PLUGINS_LOCK_FILE } from './lock.js';
import { parsePluginManifest, ClosureRefusal } from './closure.js';

export function pluginDeclarationFindings(files: ProductFileRead, folder: string, manifest: KindsManifest | undefined): Finding[] {
  const findings: Finding[] = [];
  const lock = parsePluginLock(files.text(PLUGINS_LOCK_FILE), join(folder, PLUGINS_LOCK_FILE));
  if (!lock.ok && !findings.some((one) => one.message === lock.message)) findings.push(lock);
  for (const plugin of manifest?.plugins?.values() ?? []) {
    if (plugin.path === undefined) continue;
    const path = `${plugin.path}/plugin.json`;
    const file = join(folder, path);
    const text = files.text(path);
    if (text === undefined) findings.push({ file, line: 1, message: 'the named plugin holds no readable plugin.json' });
    else try { parsePluginManifest(text, file); } catch (error) {
      if (!(error instanceof ClosureRefusal)) throw error;
      findings.push({ file: error.file, line: error.line, message: error.message });
    }
  }
  return findings;
}
