/** A serving-only test for the one directory that has a wiki home but no product manifest. */
import { lstatSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { MANIFEST_FILE } from '../product/manifest.js';

type ManifestlessFileSystem = {
  stat(path: string): { isDirectory(): boolean };
  lstat(path: string): unknown;
};

const fileSystem: ManifestlessFileSystem = { stat: statSync, lstat: lstatSync };

/** True only for an existing directory whose manifest directory entry is absent (not a dangling symlink). */
export function isExistingDirectoryWithoutManifest(folder: string, io: ManifestlessFileSystem = fileSystem): boolean {
  try {
    if (!io.stat(folder).isDirectory()) return false;
  } catch {
    return false;
  }

  try {
    io.lstat(join(folder, MANIFEST_FILE));
    return false;
  } catch (error) {
    return (error as { code?: string }).code === 'ENOENT';
  }
}
